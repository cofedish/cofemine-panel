import { prisma } from "../db.js";
import { NodeClient } from "../nodes/node-client.js";

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

export function dockerStateToPanelStatus(state: string): PanelStatus {
  switch (state) {
    case "running":
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
  liveDockerState: string | null
): Promise<PanelStatus | null> {
  if (!liveDockerState) return null;
  const live = dockerStateToPanelStatus(liveDockerState);
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
  return live;
}

/**
 * Fetch one node's batch state map. Returns null on any agent
 * failure — caller should fall back to whatever's already in the DB
 * rather than blanking the UI.
 */
export async function fetchNodeStates(
  nodeId: string
): Promise<Record<string, { state: string }> | null> {
  try {
    const client = await NodeClient.forId(nodeId);
    return await client.call<Record<string, { state: string }>>(
      "GET",
      "/servers/state"
    );
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
        const reconciled = await reconcileServerStatus(id, dockerState);
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
