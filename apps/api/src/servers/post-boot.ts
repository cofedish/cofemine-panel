import { prisma } from "../db.js";
import { NodeClient } from "../nodes/node-client.js";
import { ModrinthProvider } from "../integrations/modrinth-provider.js";

/**
 * Post-boot install hook.
 *
 * Stored as a panel-internal env flag on the server row:
 *   __COFEMINE_PENDING_MAP_INSTALL = '{"provider":"modrinth", ...}'
 *
 * The agent's itzg provider strips all `__COFEMINE_*` keys before
 * passing env into the container, so the modpack runtime never sees
 * the flag. The status reconciler picks it up the moment the server
 * transitions into "running" for the first time, fires the install
 * via the agent, then clears the flag.
 *
 * Why deferred? itzg-managed modpack types (AUTO_CURSEFORGE,
 * MODRINTH) take full ownership of /data/mods at first boot — any
 * pre-installed jar gets wiped against the pack manifest. The only
 * reliable place to drop a non-pack mod is AFTER itzg's first-pass
 * install completes. Plain (non-modpack) servers don't have this
 * problem, but we use the same path for both for consistency.
 *
 * After a successful install we kick a restart so the new mod /
 * plugin actually loads. If the install fails, we leave the flag in
 * place so the next running-transition retries — useful when the
 * server stops/starts and the failure was transient.
 */

export type PendingMapInstall = {
  provider: "modrinth";
  projectId: string;
  kind: "mod" | "plugin";
  gameVersion?: string;
  loader?: string;
};

const PENDING_KEY = "__COFEMINE_PENDING_MAP_INSTALL";

function envOf(server: { env: unknown }): Record<string, string> {
  return (server.env as Record<string, string> | null) ?? {};
}

export function readPendingMapInstall(server: {
  env: unknown;
}): PendingMapInstall | null {
  const raw = envOf(server)[PENDING_KEY];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingMapInstall;
    if (!parsed.provider || !parsed.projectId || !parsed.kind) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingMapInstall(serverId: string): Promise<void> {
  const row = await prisma.server.findUnique({
    where: { id: serverId },
    select: { env: true },
  });
  if (!row) return;
  const env = envOf(row);
  if (!(PENDING_KEY in env)) return;
  const next = { ...env };
  delete next[PENDING_KEY];
  await prisma.server.update({
    where: { id: serverId },
    data: { env: next as object },
  });
}

const modrinth = new ModrinthProvider();

/**
 * Fire-and-forget post-boot install. Called from the status
 * reconciler when a server crosses into "running". Wrapped so the
 * caller can `void firePendingMapInstall(...)` without juggling
 * promise chains in the hot path.
 *
 * Re-entrant safety: we don't lock or coordinate. If the reconciler
 * fires twice in quick succession (e.g. parallel list calls right
 * after boot), both instances will hit the same agent endpoint
 * back-to-back. Re-downloading the same file is a no-op overwrite,
 * and the env-clear is idempotent — worst case is a duplicate
 * restart, which the user can absorb on a freshly-booted server.
 */
export async function firePendingMapInstall(
  serverId: string
): Promise<void> {
  try {
    const server = await prisma.server.findUnique({
      where: { id: serverId },
      select: { id: true, nodeId: true, env: true },
    });
    if (!server) return;
    const pending = readPendingMapInstall(server);
    if (!pending) return;

    if (pending.provider !== "modrinth") {
      // Future-proofed shape; today we only ship Modrinth installs.
      // If we ever stage a non-Modrinth install, drop a different
      // dispatcher here.
      return;
    }

    const versions = await modrinth.getVersions(pending.projectId, {
      gameVersion: pending.gameVersion,
      loader: pending.loader,
    });
    const version = versions[0];
    if (!version) {
      // No compatible build — leave the flag for now so a future
      // upstream release would pick up. Not great UX; we'll add a
      // diagnostic banner later.
      // eslint-disable-next-line no-console
      console.warn(
        `[post-boot] no compatible ${pending.projectId} for MC=${pending.gameVersion}/${pending.loader}; will retry on next running transition`
      );
      return;
    }
    const plan = await modrinth.planInstall(version, pending.kind);
    const client = await NodeClient.forId(server.nodeId);
    await client.call("POST", `/servers/${serverId}/install`, {
      provider: "modrinth",
      kind: pending.kind,
      plan,
    });

    await clearPendingMapInstall(serverId);

    // Restart so the freshly-dropped jar actually loads. itzg sees
    // the SIGTERM, MC saves and exits clean, the next start picks
    // up the new mod / plugin. Schedule with a small delay so we
    // don't restart while the player who just booted is still
    // logging in — if they're already in, the auto-save covers it.
    setTimeout(() => {
      void client
        .call("POST", `/servers/${serverId}/restart`)
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[post-boot] restart after install failed:", err);
        });
    }, 8_000);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[post-boot] install failed:", err);
  }
}
