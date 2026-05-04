import { prisma } from "../db.js";
import { NodeClient } from "../nodes/node-client.js";
import { readDownloadProxy } from "../integrations/download-proxy.js";
import { reconcileAndReprovision } from "./service.js";

/**
 * Background worker that babysits modpack-source servers while they are
 * installing mods. For each starting/running CURSEFORGE or MODRINTH
 * server it polls the agent's install-failures endpoint and:
 *
 *   1. If the install aborted with a CDN timeout / retries-exhausted /
 *      403 storm AND the user has a Download proxy configured + enabled
 *      AND the server is not already routed through it: flip the per-
 *      server proxy flag on, reprovision, and restart. This second
 *      start tunnels downloads through the proxy.
 *   2. If the agent sees a 403 storm (>=3 per-mod 403s) without any
 *      install-level abort yet: same action, fire early — don't wait
 *      hours for itzg's per-mod retry budget to exhaust.
 *   3. If the MC server has printed its "Done!" boot marker AND the
 *      server is currently using the proxy: flip the flag off,
 *      reprovision, and restart once more. That second start lands in
 *      a container without JAVA_TOOL_OPTIONS so Mojang auth / skins
 *      resolve directly, and the server runs in normal mode from then on.
 *   4. If the DB flag says "use proxy" but the container's actual
 *      Config.Env carries no proxy injection: the previous toggle's
 *      reprovision/start failed mid-flight. Detect that desync and
 *      force a clean reprovision so the container actually picks up
 *      the proxy.
 *
 * The watchdog is rate-limited per server (60s cooldown between actions)
 * and capped to one proxy attempt per install session to avoid tight
 * restart loops when the proxy itself is unreachable.
 */

const TICK_MS = 15_000;
const COOLDOWN_MS = 60_000;
/** Per-mod 403s we tolerate before assuming we're being IP-blocked.
 *  Single 403s happen on individual restricted mods; sustained 403s
 *  across many mods strongly suggest CDN-side region blocking. */
const FAILURES_FOR_PROXY = 3;

const lastActionAt = new Map<string, number>();
const proxyAttempts = new Map<string, number>();

type ServerRow = Awaited<
  ReturnType<typeof prisma.server.findFirst>
> extends infer R
  ? NonNullable<R>
  : never;

type InstallState = {
  interrupt: { kind: string; message: string } | null;
  booted: boolean;
  failures?: unknown[];
  containerHasProxyEnv?: boolean;
};

export function startInstallWatchdog(): void {
  setInterval(() => {
    tick().catch((err) => {
      // Catch only here — individual handler errors get their own
      // logging below so the user can see WHICH server failed and
      // why.
      // eslint-disable-next-line no-console
      console.warn("[watchdog] tick failed:", err);
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
    } catch (err) {
      // Log instead of swallow. The previous silent catch was
      // hiding both the "DB-flag set but reconcile threw" desync
      // bug AND any future watchdog failures from operators.
      // eslint-disable-next-line no-console
      console.warn(
        `[watchdog] handler failed for server ${s.id} (${s.name}):`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

async function handle(s: ServerRow): Promise<void> {
  const env = ((s.env as Record<string, string> | null) ?? {}) as Record<
    string,
    string
  >;
  const dbWantsProxy = env["__COFEMINE_INSTALL_PROXY"] === "1";
  const client = await NodeClient.forId(s.nodeId);

  let installState: InstallState | null = null;
  try {
    installState = await client.call<InstallState>(
      "GET",
      `/servers/${s.id}/install-failures`
    );
  } catch {
    return;
  }
  if (!installState) return;

  // Case D — desync repair. DB believes proxy is on, but the live
  // container's Config.Env doesn't carry the proxy injection. The
  // previous toggle's reprovision or start step crashed silently
  // and left things in this half-state. Force a clean reprovision
  // so the container actually picks up the proxy. We DON'T touch
  // proxyAttempts here — this is recovering a failed action, not
  // a new attempt.
  if (
    dbWantsProxy &&
    installState.containerHasProxyEnv === false &&
    !installState.booted
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[watchdog] ${s.name}: DB says proxy=on but container env has no proxy — forcing reprovision`
    );
    lastActionAt.set(s.id, Date.now());
    await reprovisionAndStart(s.id);
    return;
  }

  // Case A — server booted successfully. Reset attempt counter; if it
  // was using the proxy, just clear the DB flag (no restart) so the
  // NEXT user-initiated start picks up the cleared env. We used to
  // reprovision+restart here to take MC's runtime traffic off the
  // proxy immediately, but that killed the JVM mid-worldgen on a
  // freshly-booted server — the user reported losing world progress
  // because the watchdog yanked the container out from under them.
  // Trade-off: MC's runtime auth/skins keep going through the proxy
  // until the next manual restart. With a working proxy that's fine;
  // worst case is slightly slower skin loads.
  if (installState.booted) {
    proxyAttempts.delete(s.id);
    if (dbWantsProxy) {
      try {
        const server = await prisma.server.findUnique({
          where: { id: s.id },
        });
        if (server) {
          const env = ((server.env as Record<string, string> | null) ??
            {}) as Record<string, string>;
          if (env.__COFEMINE_INSTALL_PROXY === "1") {
            const next = { ...env };
            delete next.__COFEMINE_INSTALL_PROXY;
            await prisma.server.update({
              where: { id: s.id },
              data: { env: next as unknown as object },
            });
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[watchdog] couldn't clear install-proxy flag for ${s.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    return;
  }

  // Case B / C — install hasn't booted yet. Decide whether to flip
  // the proxy ON. Two triggers:
  //   - install-level abort (timeout / exhausted / generic / blocked)
  //   - failures storm: 3+ per-mod 403s observed, even without a
  //     full install abort. Catches the case where mc-image-helper
  //     is grinding through individual retries and the user would
  //     otherwise wait hours for it to finally exhaust the budget.
  const failuresCount = Array.isArray(installState.failures)
    ? installState.failures.length
    : 0;
  const shouldProxy =
    !dbWantsProxy &&
    (installState.interrupt !== null ||
      failuresCount >= FAILURES_FOR_PROXY);
  if (!shouldProxy) return;

  const proxy = await readDownloadProxy();
  if (!proxy) return;
  const attempts = proxyAttempts.get(s.id) ?? 0;
  if (attempts >= 1) return;
  proxyAttempts.set(s.id, attempts + 1);
  lastActionAt.set(s.id, Date.now());
  await toggleProxyAndRestart(s.id, true);
}

/**
 * Flip the server's `__COFEMINE_INSTALL_PROXY` flag in DB, reprovision
 * the container (so the new JAVA_TOOL_OPTIONS / HTTP_PROXY env take
 * effect), and kick a start. If reconcile or start throws, ROLL BACK
 * the DB flag — without this rollback, a partial failure leaves DB
 * saying "proxy=on" while the live container has no proxy injection
 * (and the watchdog then thinks everything's fine and stops acting,
 * which was the exact desync the user hit).
 */
async function toggleProxyAndRestart(
  serverId: string,
  enable: boolean
): Promise<void> {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
  });
  const previousEnv = (server.env as Record<string, string> | null) ?? {};
  const env = { ...previousEnv };
  if (enable) {
    env["__COFEMINE_INSTALL_PROXY"] = "1";
  } else {
    delete env["__COFEMINE_INSTALL_PROXY"];
  }
  await prisma.server.update({
    where: { id: serverId },
    data: { env: env as unknown as object },
  });
  try {
    await reconcileAndReprovision(serverId);
    const client = await NodeClient.forId(server.nodeId);
    await client.call("POST", `/servers/${serverId}/start`);
    await prisma.server.update({
      where: { id: serverId },
      data: { status: "starting", lastStartedAt: new Date() },
    });
  } catch (err) {
    // Roll back the flag so the next tick doesn't see a stale
    // "proxy=on" claim while the container actually has no proxy.
    await prisma.server
      .update({
        where: { id: serverId },
        data: { env: previousEnv as unknown as object },
      })
      .catch(() => {
        /* secondary failure — at this point the DB is just stuck */
      });
    // eslint-disable-next-line no-console
    console.warn(
      `[watchdog] toggleProxyAndRestart(${serverId}, enable=${enable}) failed; flag rolled back:`,
      err instanceof Error ? err.message : err
    );
    throw err;
  }
}

/**
 * Recover the desync case (D): keep DB env as-is (flag already on),
 * just re-run reconcile + start so the container actually picks up
 * the proxy that the DB claims is set.
 */
async function reprovisionAndStart(serverId: string): Promise<void> {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
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
