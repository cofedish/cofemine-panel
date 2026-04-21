import { prisma } from "../db.js";
import { NodeClient } from "../nodes/node-client.js";
import type { CreateServerInput } from "@cofemine/shared";

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
 * For modpack sources, merge the provider-specific env vars the itzg image
 * expects so it can bootstrap the pack by itself (loader + MC version
 * detection).
 */
function mergeModpackEnv(input: CreateServerInput): Record<string, string> {
  const env: Record<string, string> = { ...(input.env ?? {}) };
  if (!input.modpack) return env;
  if (input.type === "MODRINTH") {
    // itzg accepts either a slug/id or a full version/file URL.
    env.MODRINTH_PROJECT ??= input.modpack.slug ?? input.modpack.projectId;
  } else if (input.type === "CURSEFORGE") {
    // Prefer slug; fall back to the CurseForge page URL if only URL was known.
    if (input.modpack.slug) env.CF_SLUG ??= input.modpack.slug;
    if (input.modpack.url) env.CF_PAGE_URL ??= input.modpack.url;
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
  const env = mergeModpackEnv(input);
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
