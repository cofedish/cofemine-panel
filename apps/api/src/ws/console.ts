import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { prisma } from "../db.js";
import { assertServerPermission } from "../auth/rbac.js";
import { requireUser } from "../auth/context.js";
import { NodeClient } from "../nodes/node-client.js";

/**
 * Proxy a WebSocket from the panel-web ↔ panel-api ↔ node-agent so the
 * browser never has to know about the agent, and we still enforce RBAC
 * before opening the upstream socket.
 */
export async function registerConsoleWs(app: FastifyInstance): Promise<void> {
  app.get(
    "/ws/servers/:id/console",
    { websocket: true },
    async (connection, req) => {
      const { id } = req.params as { id: string };
      try {
        // req.user was populated by the auth hook
        requireUser(req);
        await assertServerPermission(req, id, "server.control");
      } catch (err) {
        connection.socket.close(4401, "unauthorized");
        return;
      }
      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        connection.socket.close(4404, "server not found");
        return;
      }
      const client = await NodeClient.forId(server.nodeId);
      const upstreamUrl =
        client.host.replace(/^http/, "ws") + `/ws/servers/${id}/console`;
      const upstream = new WebSocket(upstreamUrl, {
        headers: { authorization: `Bearer ${client.token}` },
      });
      upstream.on("open", () => {
        connection.socket.send(
          JSON.stringify({ type: "status", message: "connected" })
        );
      });
      upstream.on("message", (data) => {
        try {
          connection.socket.send(data.toString());
        } catch {}
      });
      upstream.on("close", (code, reason) => {
        try {
          connection.socket.close(code, reason.toString());
        } catch {}
      });
      upstream.on("error", (err) => {
        req.log.error({ err }, "upstream ws error");
        try {
          connection.socket.close(1011, "upstream error");
        } catch {}
      });
      connection.socket.on("message", (data) => {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data.toString());
        }
      });
      connection.socket.on("close", () => {
        try {
          upstream.close();
        } catch {}
      });
    }
  );
}
