import { prisma } from "../db.js";
import { NodeClient } from "../nodes/node-client.js";
import type { CreateServerInput } from "@cofemine/shared";
import { decryptSecret } from "../crypto.js";
import {
  INSTALL_PROXY_ENV_FLAG,
  makeJavaToolOptions,
  readDownloadProxy,
} from "../integrations/download-proxy.js";

/**
 * Transform the server's stored env into the env the agent will actually
 * ship to the container. Strips panel-internal state flags and, if the
 * server is opted-in (via `__COFEMINE_INSTALL_PROXY`), injects
 * JAVA_TOOL_OPTIONS built from the global download-proxy settings so
 * mc-image-helper tunnels its modpack downloads through the proxy.
 */
async function materializeEnv(
  env: Record<string, string>
): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...env };
  const useProxy = out[INSTALL_PROXY_ENV_FLAG] === "1";
  // Always strip our sentinel so it never reaches the container.
  delete out[INSTALL_PROXY_ENV_FLAG];
  if (!useProxy) return out;
  const proxy = await readDownloadProxy();
  if (!proxy) return out;
  const opts = makeJavaToolOptions(proxy);
  // Respect user-provided JAVA_TOOL_OPTIONS — append ours, don't overwrite.
  out.JAVA_TOOL_OPTIONS = out.JAVA_TOOL_OPTIONS
    ? `${out.JAVA_TOOL_OPTIONS} ${opts}`
    : opts;
  return out;
}

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
    // Pin a specific pack version if requested. Without this, itzg picks
    // the newest published version, which may include mods incompatible
    // with the MC version we're actually booting.
    if (input.modpack.versionId) {
      env.MODRINTH_VERSION ??= input.modpack.versionId;
    }
  } else if (input.type === "CURSEFORGE") {
    // itzg's AUTO_CURSEFORGE expects ONE of: CF_SLUG, CF_PAGE_URL,
    // CF_MOD_ID. We set every identifier we can derive — that way
    // even if the CF search hit had a missing slug/URL (rare but
    // happens), the numeric project id always gets through. Without
    // this, the container would crash with
    // "A modpack page URL or slug identifier is required" the moment
    // itzg's helper tried to install.
    if (input.modpack?.slug) env.CF_SLUG ??= input.modpack.slug;
    if (input.modpack?.url) env.CF_PAGE_URL ??= input.modpack.url;
    // Numeric project id — always present; we generate it from the
    // CF search response. Belt-and-braces fallback for the cases
    // where slug/URL are absent.
    if (input.modpack?.projectId) {
      env.CF_MOD_ID ??= String(input.modpack.projectId);
    }
    // Synthesise CF_PAGE_URL from slug when only slug is known so the
    // installer always has a URL too.
    if (env.CF_SLUG && !env.CF_PAGE_URL) {
      env.CF_PAGE_URL = `https://www.curseforge.com/minecraft/modpacks/${env.CF_SLUG}`;
    }
    // Pin a specific pack file if the user picked a version. itzg's
    // AUTO_CURSEFORGE mode uses CF_FILE_ID to override "latest".
    if (input.modpack?.versionId) {
      env.CF_FILE_ID ??= input.modpack.versionId;
    }
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
  const materialized = await materializeEnv(refreshedEnv);
  const spec = {
    id: server.id,
    name: server.name,
    containerName,
    type: server.type,
    version: server.version,
    memoryMb: server.memoryMb,
    cpuLimit: server.cpuLimit,
    ports: server.ports,
    env: materialized,
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
      // CF_MOD_ID is the most stable identifier — slug can collide
      // with renamed projects, URLs change, but the numeric mod id
      // is forever. Prefer it as the projectId; reprovision still
      // sets all three env vars so itzg has its pick.
      projectId:
        env.CF_MOD_ID ?? env.CF_SLUG ?? env.CF_PAGE_URL ?? "auto",
      ...(env.CF_SLUG ? { slug: env.CF_SLUG } : {}),
      ...(env.CF_PAGE_URL ? { url: env.CF_PAGE_URL } : {}),
      ...(env.CF_FILE_ID ? { versionId: env.CF_FILE_ID } : {}),
    };
  }
  if (type === "MODRINTH") {
    return {
      provider: "modrinth",
      projectId: env.MODRINTH_PROJECT ?? "auto",
      ...(env.MODRINTH_PROJECT ? { slug: env.MODRINTH_PROJECT } : {}),
      ...(env.MODRINTH_VERSION ? { versionId: env.MODRINTH_VERSION } : {}),
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
  const storedEnv = (server.env as Record<string, string> | null) ?? {};
  const materialized = await materializeEnv(storedEnv);
  const spec = {
    id: server.id,
    name: server.name,
    containerName,
    type: server.type,
    version: server.version,
    memoryMb: server.memoryMb,
    cpuLimit: server.cpuLimit,
    ports: server.ports,
    env: materialized,
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
