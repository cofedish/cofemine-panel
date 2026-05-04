import { prisma } from "../db.js";
import { NodeClient } from "../nodes/node-client.js";
import { firePendingMapInstall } from "./post-boot.js";

/**
 * Bridge between Docker's container state vocabulary and the panel's
 * higher-level status enum.
 *
 * Docker reports one of: created / restarting / running / removing /
 * paused / exited / dead. The panel UI only thinks in four states:
 * running / starting / stopping / stopped, plus an implicit "we
 * don't know yet" handled by the polling layer.
 *
 * We don't try to reverse-engineer "starting" from docker state —
 * the user-action path in routes.ts sets DB to "starting" the
 * moment a Start is dispatched. Our job here is to recognise when
 * the container has actually crossed the line into "running" or
 * fallen back to "stopped" so the DB doesn't stick on "starting".
 */
export type PanelStatus = "running" | "starting" | "stopping" | "stopped";
export type DockerHealth = "healthy" | "unhealthy" | "starting" | null;

/**
 * Map a container's Docker state (and optional HEALTHCHECK status)
 * to the panel's enum.
 *
 * `state === "running"` only means the container's process is alive,
 * not that Minecraft has finished booting. itzg's image ships a
 * HEALTHCHECK that pings RCON; until that probe succeeds, Health is
 * "starting" and we keep showing the user "starting" instead of
 * pretending the server is ready. After the first healthy probe we
 * flip to "running". Containers without a HEALTHCHECK (custom
 * runtimes) are treated as healthy by default — there's no signal
 * to wait on.
 */
export function dockerStateToPanelStatus(
  state: string,
  health: DockerHealth = null
): PanelStatus {
  switch (state) {
    case "running":
      // itzg's HEALTHCHECK pings RCON; "starting" → MC still
      // booting (loading mods, generating world, etc.). The user's
      // bug was that we were claiming "running" the second the
      // Java process spawned, which on a heavy modpack happens
      // many minutes before the server actually accepts players.
      if (health === "starting") return "starting";
      return "running";
    case "restarting":
      // True restart loop — closer to "starting" UX-wise than a
      // hard "running".
      return "starting";
    case "removing":
    case "paused":
    case "exited":
    case "dead":
    case "created":
    default:
      return "stopped";
  }
}

/**
 * Reconcile a single server row against its container's actual
 * docker state. Writes back to the DB only when something needs
 * to change, so the cheap "no-op" path stays cheap.
 *
 * Tolerates the "container already settled into the target state"
 * intermediate: e.g. a server in DB="starting" whose container says
 * "running" — flip DB to "running". A server in DB="stopping" whose
 * container says "exited" — flip to "stopped".
 *
 * NEVER overwrites "starting"/"stopping" with the in-progress
 * docker state — we want the user-action transient to stick until
 * the container settles, so the UI button doesn't bounce. So:
 *   docker=running, db=starting  → write "running"
 *   docker=running, db=running   → no-op
 *   docker=running, db=stopped   → write "running" (drift detected)
 *   docker=exited, db=starting   → no-op (still booting up; could
 *     also be a crash, the install-watchdog handles that path)
 */
export async function reconcileServerStatus(
  serverId: string,
  liveDockerState: string | null,
  liveHealth: DockerHealth = null
): Promise<PanelStatus | null> {
  if (!liveDockerState) return null;
  const live = dockerStateToPanelStatus(liveDockerState, liveHealth);
  const row = await prisma.server.findUnique({
    where: { id: serverId },
    select: { status: true },
  });
  if (!row) return null;
  const db = row.status as PanelStatus;
  if (db === live) return db;
  // Hold the user-action transient if the container hasn't settled
  // yet. Docker exited while we were "starting" almost certainly
  // means the install/boot is still chugging through itzg's stages
  // — let the existing watchdog flip the DB if it eventually
  // crashes; don't preemptively claim "stopped" here.
  if (db === "starting" && live === "stopped") return db;
  if (db === "stopping" && live === "running") return db;
  await prisma.server.update({
    where: { id: serverId },
    data: { status: live },
  });
  // Running transition is also our trigger for post-boot install
  // hooks (deferred dynmap / bluemap install for modpack servers).
  // Fire-and-forget; the hook reads the server's env flag itself.
  if (live === "running" && db !== "running") {
    void firePendingMapInstall(serverId);
    // Loader-override one-shot: if CF_FORCE_SYNCHRONIZE is set, the
    // user just changed the loader version and we needed itzg to
    // re-resolve the pack. Now that the server is up on the new
    // loader, clear the flag so the NEXT restart isn't a full pack
    // re-download. Fire-and-forget — the boot already succeeded.
    void clearForceSynchronizeIfSet(serverId);
    // Decouple-from-source one-shot: if the user picked "Detach
    // from CF/Modrinth after first boot" in the wizard, the pack
    // has now been fully installed — convert the server to its
    // native loader type so future starts don't go through any
    // pack-reinstall machinery and the user can edit /data/mods
    // freely without itzg fighting back.
    void detachFromSourceIfFlagged(serverId);
  }
  return live;
}

/**
 * Convert a CF/MR modpack server into a "plain" native-loader server
 * once the pack has been successfully installed for the first time.
 *
 * Why: every restart of an AUTO_CURSEFORGE / Modrinth-pack server runs
 * mc-image-helper, which fights any local /data/mods modification by
 * the user (deletes added jars, downgrades upgraded ones, re-runs the
 * loader installer, etc.). After the initial install we have all the
 * mods we need on disk; running mc-image-helper on every subsequent
 * boot is pure overhead and makes user customisation impossible.
 *
 * Trigger: env flag __COFEMINE_DECOUPLE_AFTER_BOOT="1" set at create
 * time by the wizard's "detach after boot" checkbox.
 *
 * What we do:
 *   1. Flip server.type to the loader's native type (NEOFORGE / FORGE /
 *      FABRIC / QUILT) — derived from CF_MOD_LOADER_VERSION's prefix
 *      or from MODRINTH manifest data we stored at create.
 *   2. Strip CF_*-flavoured env: CF_SLUG, CF_PAGE_URL, CF_FILE_ID,
 *      CF_API_KEY, CF_MOD_LOADER_VERSION, CF_FORCE_*, CF_OVERRIDE_*,
 *      MODRINTH_PROJECT, MODRINTH_VERSION, MODRINTH_PROJECTS, MODS,
 *      and the decouple sentinel itself.
 *   3. Set the loader's native version env (NEOFORGE_VERSION etc.) so
 *      itzg's plain TYPE=NEOFORGE flow installs the same loader version
 *      on subsequent starts (idempotent; libraries already present).
 *   4. Reprovision the container so the next start runs the new spec.
 *
 * /data/mods, /data/world, /data/config — all left untouched.
 */
async function detachFromSourceIfFlagged(serverId: string): Promise<void> {
  try {
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return;
    const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
      string,
      string
    >;
    if (env.__COFEMINE_DECOUPLE_AFTER_BOOT !== "1") return;
    if (server.type !== "CURSEFORGE" && server.type !== "MODRINTH") return;

    // Derive the native loader from whichever loader-version env var
    // the modpack flow populated. CF_MOD_LOADER_VERSION isn't typed
    // (just a string), but practical values look like "21.1.218" for
    // NeoForge or "47.2.0-1.20.1" for Forge — we infer from the
    // pack's known loader if we stored it, otherwise fall back to
    // NEOFORGE which covers the most common 1.21.x case.
    const cfModLoaderVer = env.CF_MOD_LOADER_VERSION;
    const neoVer = env.NEOFORGE_VERSION ?? cfModLoaderVer;
    const forgeVer = env.FORGE_VERSION;
    const fabricVer = env.FABRIC_LOADER_VERSION;
    const quiltVer = env.QUILT_LOADER_VERSION;
    let newType: string = "NEOFORGE";
    let nativeVerKey = "NEOFORGE_VERSION";
    let nativeVer: string | undefined = neoVer;
    if (forgeVer) {
      newType = "FORGE";
      nativeVerKey = "FORGE_VERSION";
      nativeVer = forgeVer;
    } else if (fabricVer) {
      newType = "FABRIC";
      nativeVerKey = "FABRIC_LOADER_VERSION";
      nativeVer = fabricVer;
    } else if (quiltVer) {
      newType = "QUILT";
      nativeVerKey = "QUILT_LOADER_VERSION";
      nativeVer = quiltVer;
    }

    // Strip every modpack-specific env var. After this, the server
    // looks like a plain native-loader install for itzg's purposes.
    const dropKeys = [
      // CF
      "CF_SLUG",
      "CF_PAGE_URL",
      "CF_FILE_ID",
      "CF_API_KEY",
      "CF_MOD_LOADER_VERSION",
      "CF_FORCE_REINSTALL_MODLOADER",
      "CF_FORCE_SYNCHRONIZE",
      "CF_FORCE_INCLUDE_MODS",
      "CF_OVERRIDE_LOADER_VERSION",
      "CF_EXCLUDE_MODS",
      "CF_EXCLUDE_INCLUDE_FILE",
      // Modrinth
      "MODRINTH_PROJECT",
      "MODRINTH_VERSION",
      "MODRINTH_PROJECTS",
      "MODRINTH_LOADER",
      // Pack-managed mod list (we keep the jars on disk; the env is
      // for itzg's reinstall flow which we're now opting out of).
      "MODS",
      "PLUGINS",
      // Sentinel itself
      "__COFEMINE_DECOUPLE_AFTER_BOOT",
    ];
    const next: Record<string, string> = { ...env };
    for (const k of dropKeys) delete next[k];
    if (nativeVer) next[nativeVerKey] = nativeVer;

    await prisma.server.update({
      where: { id: serverId },
      data: {
        type: newType,
        env: next as unknown as object,
      },
    });
    // eslint-disable-next-line no-console
    console.info(
      `[decouple] server ${serverId} detached from ${server.type}; new type=${newType}, loader=${nativeVer ?? "unknown"}`
    );
    // Don't reprovision now — it'd kill the freshly-booted MC. The
    // change takes effect on the next user-initiated restart, where
    // the pre-start auto-reprovision picks up the new spec.
  } catch (err) {
    // Non-fatal — server keeps running on its current spec; user can
    // re-trigger by toggling the flag and restarting.
    // eslint-disable-next-line no-console
    console.warn(
      `[decouple] failed for ${serverId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

async function clearForceSynchronizeIfSet(serverId: string): Promise<void> {
  try {
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return;
    const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
      string,
      string
    >;
    // Clear any of the one-shot reinstall flags. They were set when
    // the user clicked Apply on the loader-version dialog; once the
    // server boots cleanly on the new loader, they're no longer
    // needed and would just slow every subsequent restart with a
    // redundant download check.
    const oneShotKeys = [
      "CF_FORCE_REINSTALL_MODLOADER",
      "CF_FORCE_SYNCHRONIZE",
    ];
    const stale = oneShotKeys.filter((k) => env[k] === "true");
    if (stale.length === 0) return;
    const next = { ...env };
    for (const k of stale) delete next[k];
    await prisma.server.update({
      where: { id: serverId },
      data: { env: next as unknown as object },
    });
    // No reprovision here on purpose: the env change only matters at
    // next start, and we don't want to bounce a freshly-booted server.
    // The next user-initiated restart picks up the cleared env.
  } catch {
    // Non-fatal — at worst the user pays for one extra full sync next
    // restart. They can clear the flag manually via "Сбросить" too.
  }
}

/**
 * Fetch one node's batch state map. Returns null on any agent
 * failure — caller should fall back to whatever's already in the DB
 * rather than blanking the UI.
 */
export async function fetchNodeStates(
  nodeId: string
): Promise<Record<
  string,
  { state: string; health?: DockerHealth }
> | null> {
  try {
    const client = await NodeClient.forId(nodeId);
    return await client.call<
      Record<string, { state: string; health?: DockerHealth }>
    >("GET", "/servers/state");
  } catch {
    return null;
  }
}

/**
 * Pull live state from every node referenced by `servers`, write
 * back any drift, and return a serverId → resolved-status map for
 * the caller to overlay onto its response.
 */
export async function reconcileMany(
  servers: Array<{ id: string; nodeId: string; status: string }>
): Promise<Record<string, PanelStatus>> {
  const byNode = new Map<string, string[]>();
  for (const s of servers) {
    const arr = byNode.get(s.nodeId) ?? [];
    arr.push(s.id);
    byNode.set(s.nodeId, arr);
  }
  const out: Record<string, PanelStatus> = {};
  await Promise.all(
    [...byNode.entries()].map(async ([nodeId, ids]) => {
      const live = await fetchNodeStates(nodeId);
      if (!live) {
        // Agent down — fall back to whatever the DB says.
        for (const id of ids) {
          const s = servers.find((x) => x.id === id)!;
          out[id] = s.status as PanelStatus;
        }
        return;
      }
      for (const id of ids) {
        const dockerState = live[id]?.state ?? null;
        const dockerHealth = live[id]?.health ?? null;
        const reconciled = await reconcileServerStatus(
          id,
          dockerState,
          dockerHealth
        );
        if (reconciled) {
          out[id] = reconciled;
        } else {
          // No container on the agent — treat as stopped, but only
          // flip the DB if it currently claims it's running, so we
          // don't churn writes on freshly-created servers that
          // legitimately haven't been started yet.
          const s = servers.find((x) => x.id === id)!;
          if (s.status === "running" || s.status === "starting") {
            await prisma.server
              .update({
                where: { id },
                data: { status: "stopped" },
              })
              .catch(() => {});
            out[id] = "stopped";
          } else {
            out[id] = s.status as PanelStatus;
          }
        }
      }
    })
  );
  return out;
}
