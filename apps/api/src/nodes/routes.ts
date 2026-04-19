import type { FastifyInstance } from "fastify";
import { createNodeSchema } from "@cofemine/shared";
import { prisma } from "../db.js";
import { sha256Hex } from "../crypto.js";
import { requireGlobalPermission } from "../auth/rbac.js";
import { requireUser } from "../auth/context.js";
import { writeAudit } from "../audit/service.js";
import { NodeClient } from "./node-client.js";

export async function nodesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/",
    { preHandler: requireGlobalPermission("node.manage") },
    async () => {
      const nodes = await prisma.node.findMany({
        orderBy: { createdAt: "asc" },
      });
      return nodes.map((n) => ({
        id: n.id,
        name: n.name,
        host: n.host,
        status: n.status,
        lastSeenAt: n.lastSeenAt,
        createdAt: n.createdAt,
      }));
    }
  );

  app.post(
    "/",
    { preHandler: requireGlobalPermission("node.manage") },
    async (req, reply) => {
      const body = createNodeSchema.parse(req.body);
      const node = await prisma.node.create({
        data: {
          name: body.name,
          host: body.host,
          tokenHash: sha256Hex(body.token),
        },
      });
      await writeAudit(req, {
        action: "node.create",
        resource: node.id,
        metadata: { name: node.name, host: node.host },
      });
      return reply.code(201).send({ id: node.id });
    }
  );

  app.get(
    "/:id/health",
    { preHandler: requireGlobalPermission("node.manage") },
    async (req) => {
      const { id } = req.params as { id: string };
      const client = await NodeClient.forId(id);
      try {
        const res = await client.call<{ ok: boolean; version: string }>(
          "GET",
          "/health"
        );
        await prisma.node.update({
          where: { id },
          data: { status: "ONLINE", lastSeenAt: new Date() },
        });
        return res;
      } catch (err) {
        await prisma.node.update({
          where: { id },
          data: { status: "OFFLINE" },
        });
        throw err;
      }
    }
  );

  app.delete(
    "/:id",
    { preHandler: requireGlobalPermission("node.manage") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = requireUser(req);
      const serverCount = await prisma.server.count({ where: { nodeId: id } });
      if (serverCount > 0) {
        return reply.code(409).send({
          error: "Node has servers — delete servers first",
        });
      }
      await prisma.node.delete({ where: { id } });
      await writeAudit(req, {
        action: "node.delete",
        resource: id,
        metadata: { by: user.username },
      });
      return { ok: true };
    }
  );
}
