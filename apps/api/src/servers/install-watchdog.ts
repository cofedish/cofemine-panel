import { prisma } from "../db.js";
import { NodeClient } from "../nodes/node-client.js";
import { readDownloadProxy } from "../integrations/download-proxy.js";
import { reconcileAndReprovision } from "./service.js";

/**
 * Background worker that babysits modpack-source servers while they are
 * installing mods. For each starting/running CURSEFORGE or MODRINTH
 * server it polls the agent's install-failures endpoint and:
 *
 *   1. If the install aborted with a CDN timeout / retries-exhausted
 *      AND the user has a Download proxy configured + enabled AND the
 *      server is not already routed through it: flip the per-server
 *      proxy flag on, reprovision, and restart. This second start
 *      tunnels downloads through the proxy.
 *
 *   2. If the MC server has printed its "Done!" boot marker AND the
 *      server is currently using the proxy: flip the flag off,
 *      reprovision, and restart once more. That second start lands in
 *      a container without JAVA_TOOL_OPTIONS so Mojang auth / skins
 *      resolve directly, and the server runs in normal mode from then on.
 *
 * The watchdog is rate-limited per server (60s cooldown between actions)
 * and capped to one proxy attempt per install session to avoid tight
 * restart loops when the proxy itself is unreachable.
 */

const TICK_MS = 15_000;
const COOLDOWN_MS = 60_000;

/** Anti-flap state kept in-memory. Survives server code but not restarts;
 *  losing this on restart is fine — new ticks will resume from scratch. */
const lastActionAt = new Map<string, number>();
/** How many times the watchdog has flipped proxy=on for THIS install
 *  session. Cleared when the server boots successfully or is stopped. */
const proxyAttempts = new Map<string, number>();

type ServerRow = Awaited<
  ReturnType<typeof prisma.server.findFirst>
> extends infer R
  ? NonNullable<R>
  : never;

export function startInstallWatchdog(): void {
  setInterval(() => {
    tick().catch(() => {
      /* swallow — individual handler failures are already logged */
    });
  }, TICK_MS);
}

async function tick(): Promise<void> {
  const servers = await prisma.server.findMany({
    where: {
      OR: [{ type: "CURSEFORGE" }, { type: "MODRINTH" }],
      status: { in: ["starting", "running"] },
    },
  });
  for (const s of servers) {
    const now = Date.now();
    const last = lastActionAt.get(s.id) ?? 0;
    if (now - last < COOLDOWN_MS) continue;
    try {
      await handle(s);
    } catch {
      /* best-effort — don't let one bad server poison the rest */
    }
  }
}

async function handle(s: ServerRow): Promise<void> {
  const env = ((s.env as Record<string, string> | null) ?? {}) as Record<
    string,
    string
  >;
  const usingProxy = env["__COFEMINE_INSTALL_PROXY"] === "1";
  const client = await NodeClient.forId(s.nodeId);

  let installState:
    | { interrupt: unknown | null; booted: boolean }
    | null = null;
  try {
    installState = await client.call<{
      interrupt: unknown | null;
      booted: boolean;
    }>("GET", `/servers/${s.id}/install-failures`);
  } catch {
    return;
  }
  if (!installState) return;

  // Case A — server booted successfully. Reset attempt counter; if it
  // was using the proxy, flip it off and kick a clean restart so MC's
  // own HTTP traffic goes direct.
  if (installState.booted) {
    proxyAttempts.delete(s.id);
    if (usingProxy) {
      lastActionAt.set(s.id, Date.now());
      await toggleProxyAndRestart(s.id, false);
    }
    return;
  }

  // Case B — install aborted. If we have a proxy configured and enabled,
  // and the current run wasn't already using it, try one proxied run.
  if (installState.interrupt && !usingProxy) {
    const proxy = await readDownloadProxy();
    if (!proxy) return;
    const attempts = proxyAttempts.get(s.id) ?? 0;
    if (attempts >= 1) return;
    proxyAttempts.set(s.id, attempts + 1);
    lastActionAt.set(s.id, Date.now());
    await toggleProxyAndRestart(s.id, true);
  }
}

/**
 * Flip the server's `__COFEMINE_INSTALL_PROXY` flag in DB, reprovision
 * the container (so the new JAVA_TOOL_OPTIONS take effect on disk), and
 * kick a start. reconcileAndReprovision leaves the container in the
 * "created" state — we still need an explicit start.
 */
async function toggleProxyAndRestart(
  serverId: string,
  enable: boolean
): Promise<void> {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
  });
  const env = { ...((server.env as Record<string, string> | null) ?? {}) };
  if (enable) {
    env["__COFEMINE_INSTALL_PROXY"] = "1";
  } else {
    delete env["__COFEMINE_INSTALL_PROXY"];
  }
  await prisma.server.update({
    where: { id: serverId },
    data: { env: env as unknown as object },
  });
  await reconcileAndReprovision(serverId);
  const client = await NodeClient.forId(server.nodeId);
  await client.call("POST", `/servers/${serverId}/start`);
  await prisma.server.update({
    where: { id: serverId },
    data: { status: "starting", lastStartedAt: new Date() },
  });
}

/** Clear in-memory anti-flap state for a server. Call when the server
 *  is stopped/deleted — otherwise stale attempt counters would survive
 *  across install sessions. */
export function resetWatchdogState(serverId: string): void {
  lastActionAt.delete(serverId);
  proxyAttempts.delete(serverId);
}
