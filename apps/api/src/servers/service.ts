import { prisma } from "../db.js";
import { request } from "undici";
import { NodeClient } from "../nodes/node-client.js";
import type { CreateServerInput } from "@cofemine/shared";
import { decryptSecret } from "../crypto.js";
import {
  extractLoaders,
  isMinecraftVersion,
} from "../integrations/curseforge-provider.js";

/**
 * Transform the server's stored env into the env the agent will actually
 * ship to the container. Strips panel-internal state flags and force-
 * appends -Djava.net.preferIPv4Stack=true to JAVA_TOOL_OPTIONS — the
 * cofemine_mcnet docker network is IPv4-only, so the JVM picking up an
 * AAAA record from a CDN with no IPv6 routing wedges TLS for ~30s.
 *
 * Per-install proxying is no longer the API's job — the maven-cache
 * sidecar handles it transparently. The agent's itzg-provider injects
 * HTTPS_PROXY and the squid leaf-cert trust at container create time.
 */
async function materializeEnv(
  env: Record<string, string>
): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...env };
  const ipv4Opt = "-Djava.net.preferIPv4Stack=true";
  out.JAVA_TOOL_OPTIONS = out.JAVA_TOOL_OPTIONS
    ? `${out.JAVA_TOOL_OPTIONS} ${ipv4Opt}`
    : ipv4Opt;
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
    // itzg's AUTO_CURSEFORGE accepts CF_SLUG OR CF_PAGE_URL as the
    // project identifier — those are the only two supported values
    // (CF_FILE_ID pins a specific file but isn't a project id). If
    // neither survives into the container env, mc-image-helper
    // crashes with "A modpack page URL or slug identifier is
    // required".
    //
    // The wizard collects both `slug` and `pageUrl` from the CF
    // search hit. We mirror them into env, AND synthesise the URL
    // from the slug as a belt-and-braces fallback so even a
    // glitchy CF response (slug present, websiteUrl null) doesn't
    // strand the install.
    if (input.modpack?.slug) env.CF_SLUG ??= input.modpack.slug;
    if (input.modpack?.url) env.CF_PAGE_URL ??= input.modpack.url;
    if (env.CF_SLUG && !env.CF_PAGE_URL) {
      env.CF_PAGE_URL = `https://www.curseforge.com/minecraft/modpacks/${env.CF_SLUG}`;
    }
    if (env.CF_PAGE_URL && !env.CF_SLUG) {
      // Reverse synthesis: the modpack URL is always the slug at the
      // tail. Pull it out so itzg always has a slug too.
      const m = /\/modpacks\/([a-z0-9-]+)/i.exec(env.CF_PAGE_URL);
      if (m?.[1]) env.CF_SLUG = m[1];
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
    // Safety net: refuse to provision if we'd hand the agent a
    // CURSEFORGE spec with no usable project identifier. Better to
    // fail fast in the panel with an actionable message than have
    // the container crash-loop with a cryptic error.
    if (!env.CF_SLUG && !env.CF_PAGE_URL) {
      const err = new Error(
        "CurseForge server is missing both CF_SLUG and CF_PAGE_URL. " +
          "The modpack identifier wasn't preserved in the server's env. " +
          "Edit the server's env to add one of them (find the slug at " +
          "the end of the pack URL: " +
          "https://www.curseforge.com/minecraft/modpacks/<slug>)."
      );
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
  }
  return env;
}

/**
 * Look up loader + MC version from the CF file metadata and stamp
 * them into the supplied env object as CF_DETECTED_LOADER /
 * CF_DETECTED_MC_VERSION. Idempotent: re-stamps every call so a
 * reattach to a new file id refreshes the values. Best-effort —
 * swallows CF API failures.
 *
 * mc-image-helper figures these out at install time from the pack
 * manifest, but never writes them back to spec.env. Without this
 * stamp, anything that reads server.env after the install
 * (public .mrpack metadata that drives the client launcher's pack
 * picker, dynmap/bluemap install which needs to pick the right
 * Modrinth loader build, etc.) defaults to "vanilla" for CURSEFORGE
 * servers.
 */
async function stampCfDetectedMetadata(
  env: Record<string, string>,
  cfPackProjectId: number,
  cfPackFileId: number
): Promise<void> {
  const cfApiKey = await readCurseforgeApiKey().catch(() => null);
  if (!cfApiKey) return;
  try {
    const url = `https://api.curseforge.com/v1/mods/${cfPackProjectId}/files/${cfPackFileId}`;
    const res = await request(url, {
      method: "GET",
      headers: { "x-api-key": cfApiKey, accept: "application/json" },
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    if (res.statusCode >= 400) {
      await res.body.dump().catch(() => {});
      return;
    }
    const body = (await res.body.json()) as {
      data?: { gameVersions?: string[] };
    };
    const raw = body.data?.gameVersions ?? [];
    const mcVersion = raw.find(isMinecraftVersion);
    const loader = extractLoaders(raw)[0];
    if (loader) env.CF_DETECTED_LOADER = loader;
    if (mcVersion) env.CF_DETECTED_MC_VERSION = mcVersion;
  } catch {
    /* non-fatal — deriveLoader will fall back to null */
  }
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

  // For CurseForge servers — resolve the slug to a numeric projectId
  // and persist it (with the file id) on the row. Done here once at
  // create-time so the .mrpack export can rebuild from the canonical
  // CF pack later, even after the server has been detached from its
  // source. Best-effort: if CF API is unavailable, fields stay null
  // and the export falls back to dump-disk mode.
  let cfPackProjectId: number | null = null;
  let cfPackFileId: number | null = null;
  if (input.type === "CURSEFORGE" && env.CF_SLUG && env.CF_FILE_ID) {
    const fileId = parseInt(env.CF_FILE_ID, 10);
    if (Number.isFinite(fileId)) {
      const cfApiKey = await readCurseforgeApiKey().catch(() => null);
      if (cfApiKey) {
        try {
          const url = `https://api.curseforge.com/v1/mods/search?gameId=432&slug=${encodeURIComponent(env.CF_SLUG)}`;
          const res = await request(url, {
            method: "GET",
            headers: { "x-api-key": cfApiKey, accept: "application/json" },
            headersTimeout: 15_000,
            bodyTimeout: 15_000,
          });
          if (res.statusCode < 400) {
            const body = (await res.body.json()) as {
              data?: Array<{ id: number; slug: string }>;
            };
            const m =
              body.data?.find((p) => p.slug === env.CF_SLUG) ?? body.data?.[0];
            if (m) {
              cfPackProjectId = m.id;
              cfPackFileId = fileId;
            }
          } else {
            await res.body.dump().catch(() => {});
          }
        } catch {
          /* swallow — non-fatal */
        }
      }
    }
  }

  if (
    input.type === "CURSEFORGE" &&
    cfPackProjectId &&
    cfPackFileId
  ) {
    await stampCfDetectedMetadata(env, cfPackProjectId, cfPackFileId);
  }

  return prisma.server.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      nodeId: input.nodeId,
      type: input.type,
      version: input.version ?? "LATEST",
      memoryMb: input.memoryMb,
      cpuLimit: input.cpuLimit ?? null,
      ports: mirrorUdpForMcPorts(input.ports) as unknown as object,
      env: env as unknown as object,
      eulaAccepted: input.eulaAccepted,
      templateId: input.templateId ?? null,
      status: "stopped",
      cfPackProjectId,
      cfPackFileId,
    },
  });
}

/**
 * Auto-add a UDP mirror for every TCP port the user mapped onto MC's
 * game port (default 25565). Simple Voice Chat — the most popular MC
 * voice-comms mod — listens on UDP at the same port as the game by
 * default. Without an explicit UDP PortBinding the docker bridge
 * blocks the packets and clients show "UDP port not open" no matter
 * how the operator sets up routing.
 *
 * Heuristic: only mirror ports that look like MC's game port (25565
 * or the operator's `server.properties` override surfaced via the
 * container side). Skip RCON (25575), query, anything below 1024.
 * Idempotent: if an equivalent UDP entry already exists, leave the
 * input untouched.
 */
const SVC_DEFAULT_PORT = 24454;
const MC_DEFAULT_PORT = 25565;

function mirrorUdpForMcPorts(
  ports: Array<{ host: number; container: number; protocol: "tcp" | "udp" }>
): Array<{ host: number; container: number; protocol: "tcp" | "udp" }> {
  const out = [...ports];
  for (const p of ports) {
    if (p.protocol !== "tcp") continue;
    // RCON is TCP-only — never mirror it.
    if (p.container === 25575) continue;
    // Mirror every other TCP entry. Covers the default MC port (25565),
    // operator-renumbered game ports, and any future mod that expects
    // UDP on the same number. Idempotent — skip when a matching UDP
    // entry is already present (operator added one manually).
    const exists = ports.some(
      (q) =>
        q.protocol === "udp" &&
        q.container === p.container &&
        q.host === p.host
    );
    if (!exists) {
      out.push({ host: p.host, container: p.container, protocol: "udp" });
    }
  }
  // Simple Voice Chat ships with `port=24454` in its default
  // voicechat-server.properties — a separate UDP port from the game.
  // Open it automatically so SVC works out of the box; if no SVC
  // mod is installed, the unused port binding is harmless.
  //
  // Host port = 24454 offset by however far MC's host port is from
  // its default (25565). That way two MC servers on the same node
  // pick non-colliding SVC ports: MC 25566 → SVC 24455, etc.
  const mcTcp = ports.find(
    (p) => p.protocol === "tcp" && p.container === MC_DEFAULT_PORT
  );
  if (mcTcp) {
    const svcHostPort = SVC_DEFAULT_PORT + (mcTcp.host - MC_DEFAULT_PORT);
    const svcExists = out.some(
      (q) => q.protocol === "udp" && q.container === SVC_DEFAULT_PORT
    );
    if (!svcExists && svcHostPort >= 1 && svcHostPort <= 65535) {
      out.push({
        host: svcHostPort,
        container: SVC_DEFAULT_PORT,
        protocol: "udp",
      });
    }
  }
  return out;
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
  // Re-stamp CF_DETECTED_LOADER / CF_DETECTED_MC_VERSION on every
  // repair too — covers servers created before this stamp existed
  // (they'd show as "vanilla" in the launcher's pack picker forever
  // otherwise) and refreshes the values after a re-attach to a
  // newer pack file id.
  if (
    server.type === "CURSEFORGE" &&
    server.cfPackProjectId &&
    server.cfPackFileId
  ) {
    await stampCfDetectedMetadata(
      refreshedEnv,
      server.cfPackProjectId,
      server.cfPackFileId
    );
  }

  // Also patch the ports column for old servers created before the
  // UDP-mirror existed — Simple Voice Chat / similar UDP-on-game-port
  // mods otherwise stay broken until the operator deletes and recreates
  // the server. mirrorUdpForMcPorts is idempotent, so this is a no-op
  // when the mirror is already there.
  const currentPorts =
    (server.ports as Array<{
      host: number;
      container: number;
      protocol: "tcp" | "udp";
    }>) ?? [];
  const mirroredPorts = mirrorUdpForMcPorts(currentPorts);
  const portsChanged = mirroredPorts.length !== currentPorts.length;
  const envChanged =
    JSON.stringify(refreshedEnv) !== JSON.stringify(currentEnv);
  if (envChanged || portsChanged) {
    await prisma.server.update({
      where: { id: server.id },
      data: {
        ...(envChanged && { env: refreshedEnv as unknown as object }),
        ...(portsChanged && { ports: mirroredPorts as unknown as object }),
      },
    });
  }
  const changed = envChanged || portsChanged;

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
    ports: mirroredPorts,
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
    // CF_MOD_ID isn't an itzg-recognised env var (mc-image-helper
    // only accepts --slug / --modpack-page-url / --file-id), so
    // we don't read it here — earlier I tried to use it as a
    // fallback but it's dead env from itzg's POV.
    const projectId = env.CF_SLUG ?? env.CF_PAGE_URL;
    if (!projectId) {
      // No modpack identifier surviving in env — the merge step
      // below will error out cleanly. Returning an empty hint
      // lets the merge handle the error path uniformly.
      return undefined;
    }
    return {
      provider: "curseforge",
      projectId,
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
