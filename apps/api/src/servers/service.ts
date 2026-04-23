import { prisma } from "../db.js";
import { NodeClient } from "../nodes/node-client.js";
import type { CreateServerInput } from "@cofemine/shared";
import { decryptSecret } from "../crypto.js";

/** Normalize a human name into a container-safe identifier. */
export function toContainerName(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20) || "srv";
  return `cofemine-mc-${slug}-${id.slice(0, 8)}`;
}

/**
 * Fetch the CurseForge API key that the user pasted into Integrations.
 * itzg expects it as CF_API_KEY env on the container — the key we stored
 * lives encrypted in IntegrationSetting, so we decrypt and forward it.
 * Returns null when no key is configured.
 */
export async function readCurseforgeApiKey(): Promise<string | null> {
  const row = await prisma.integrationSetting.findUnique({
    where: { key: "curseforge.apiKey" },
  });
  if (!row) return null;
  try {
    return decryptSecret(row.value);
  } catch {
    return null;
  }
}

/**
 * For modpack sources, merge the provider-specific env vars the itzg image
 * expects so it can bootstrap the pack by itself (loader + MC version
 * detection).
 */
async function mergeModpackEnv(
  input: CreateServerInput
): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...(input.env ?? {}) };
  if (input.type === "MODRINTH" && input.modpack) {
    // itzg accepts either a slug/id or a full version/file URL.
    env.MODRINTH_PROJECT ??= input.modpack.slug ?? input.modpack.projectId;
  } else if (input.type === "CURSEFORGE") {
    // Prefer slug; fall back to the CurseForge page URL if only URL was known.
    if (input.modpack?.slug) env.CF_SLUG ??= input.modpack.slug;
    if (input.modpack?.url) env.CF_PAGE_URL ??= input.modpack.url;
    // Inject the API key from our Integrations store so AUTO_CURSEFORGE
    // can actually download the pack. Without this, itzg logs
    // "API key is not set" and refuses to install.
    if (!env.CF_API_KEY) {
      const key = await readCurseforgeApiKey();
      if (key) env.CF_API_KEY = key;
    }
  }
  return env;
}

export async function createServerRecord(input: CreateServerInput) {
  const existsName = await prisma.server.findFirst({
    where: { name: input.name, nodeId: input.nodeId },
  });
  if (existsName) {
    throw Object.assign(new Error("Server name already in use on this node"), {
      statusCode: 409,
    });
  }
  const env = await mergeModpackEnv(input);
  return prisma.server.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      nodeId: input.nodeId,
      type: input.type,
      version: input.version ?? "LATEST",
      memoryMb: input.memoryMb,
      cpuLimit: input.cpuLimit ?? null,
      ports: input.ports as unknown as object,
      env: env as unknown as object,
      eulaAccepted: input.eulaAccepted,
      templateId: input.templateId ?? null,
      status: "stopped",
    },
  });
}

/**
 * Recompute env for an existing server (injecting current integration
 * secrets like CF_API_KEY) and ask the agent to recreate the container
 * with the refreshed spec. /data is preserved via bind mount, so worlds
 * and configs survive.
 */
export async function reconcileAndReprovision(
  serverId: string
): Promise<{ changed: boolean }> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) {
    throw Object.assign(new Error("Server not found"), { statusCode: 404 });
  }
  const currentEnv = (server.env as Record<string, string> | null) ?? {};
  const refreshedEnv = await mergeModpackEnv({
    name: server.name,
    nodeId: server.nodeId,
    type: server.type as any,
    version: server.version,
    memoryMb: server.memoryMb,
    ports: server.ports as any,
    env: currentEnv,
    eulaAccepted: server.eulaAccepted as true,
    modpack: inferModpackHint(server.type, currentEnv),
  });

  const changed =
    JSON.stringify(refreshedEnv) !== JSON.stringify(currentEnv);
  if (changed) {
    await prisma.server.update({
      where: { id: server.id },
      data: { env: refreshedEnv as unknown as object },
    });
  }

  const client = await NodeClient.forId(server.nodeId);
  const containerName =
    server.containerName ?? toContainerName(server.name, server.id);
  const spec = {
    id: server.id,
    name: server.name,
    containerName,
    type: server.type,
    version: server.version,
    memoryMb: server.memoryMb,
    cpuLimit: server.cpuLimit,
    ports: server.ports,
    env: refreshedEnv,
    eulaAccepted: server.eulaAccepted,
  };
  const res = await client.call<{ containerId: string }>(
    "POST",
    `/servers/${server.id}/reprovision`,
    spec
  );
  await prisma.server.update({
    where: { id: server.id },
    data: { containerId: res.containerId, containerName },
  });
  return { changed };
}

/**
 * Rebuild the `modpack` hint used by mergeModpackEnv from env alone.
 * On create we stored the modpack object on the input; for reprovision
 * we only have the container env, so we infer slug/url/id from the
 * CF_SLUG / CF_PAGE_URL / MODRINTH_PROJECT we wrote earlier.
 */
function inferModpackHint(
  type: string,
  env: Record<string, string>
): CreateServerInput["modpack"] | undefined {
  if (type === "CURSEFORGE") {
    return {
      provider: "curseforge",
      projectId: env.CF_SLUG ?? env.CF_PAGE_URL ?? "auto",
      ...(env.CF_SLUG ? { slug: env.CF_SLUG } : {}),
      ...(env.CF_PAGE_URL ? { url: env.CF_PAGE_URL } : {}),
    };
  }
  if (type === "MODRINTH") {
    return {
      provider: "modrinth",
      projectId: env.MODRINTH_PROJECT ?? "auto",
      ...(env.MODRINTH_PROJECT ? { slug: env.MODRINTH_PROJECT } : {}),
    };
  }
  return undefined;
}

/**
 * Ask the node-agent to provision the container for a freshly-created server,
 * then persist the resulting container id / container name.
 */
export async function provisionServerOnNode(serverId: string): Promise<void> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) throw Object.assign(new Error("Server not found"), { statusCode: 404 });
  const client = await NodeClient.forId(server.nodeId);
  const containerName = toContainerName(server.name, server.id);
  const spec = {
    id: server.id,
    name: server.name,
    containerName,
    type: server.type,
    version: server.version,
    memoryMb: server.memoryMb,
    cpuLimit: server.cpuLimit,
    ports: server.ports,
    env: server.env,
    eulaAccepted: server.eulaAccepted,
  };
  const res = await client.call<{ containerId: string }>(
    "POST",
    "/servers",
    spec
  );
  await prisma.server.update({
    where: { id: server.id },
    data: { containerId: res.containerId, containerName },
  });
}
