import type { FastifyInstance } from "fastify";
import type { WebSocket as FastifyWS } from "@fastify/websocket";
import UpstreamWS from "ws";
import { prisma } from "../db.js";
import { assertServerPermission } from "../auth/rbac.js";
import { requireUser } from "../auth/context.js";
import { NodeClient } from "../nodes/node-client.js";

/**
 * Proxy a WebSocket from panel-web ↔ panel-api ↔ node-agent so the browser
 * never has to know about the agent, while still enforcing RBAC before
 * opening the upstream socket.
 */
export async function registerConsoleWs(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/ws/servers/:id/console",
    { websocket: true },
    async (socket: FastifyWS, req) => {
      const { id } = req.params;
      try {
        requireUser(req);
        await assertServerPermission(req, id, "server.control");
      } catch {
        socket.close(4401, "unauthorized");
        return;
      }
      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        socket.close(4404, "server not found");
        return;
      }
      const client = await NodeClient.forId(server.nodeId);
      const upstreamUrl =
        client.host.replace(/^http/, "ws") + `/ws/servers/${id}/console`;
      const upstream = new UpstreamWS(upstreamUrl, {
        headers: { authorization: `Bearer ${client.token}` },
      });
      upstream.on("open", () => {
        safeSend(socket, { type: "status", message: "connected" });
      });
      upstream.on("message", (data: UpstreamWS.RawData) => {
        try {
          socket.send(data.toString());
        } catch {}
      });
      upstream.on("close", (code, reason) => {
        try {
          socket.close(code, reason.toString());
        } catch {}
      });
      upstream.on("error", (err) => {
        req.log.error({ err }, "upstream ws error");
        try {
          socket.close(1011, "upstream error");
        } catch {}
      });
      socket.on("message", (data) => {
        if (upstream.readyState === UpstreamWS.OPEN) {
          upstream.send(data.toString());
        }
      });
      socket.on("close", () => {
        try {
          upstream.close();
        } catch {}
      });
    }
  );
}

function safeSend(socket: FastifyWS, payload: object): void {
  try {
    socket.send(JSON.stringify(payload));
  } catch {}
}
