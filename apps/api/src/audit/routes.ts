import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireGlobalPermission } from "../auth/rbac.js";

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/",
    { preHandler: requireGlobalPermission("audit.view") },
    async (req) => {
      const q = req.query as { limit?: string; offset?: string };
      const limit = Math.min(Number(q.limit ?? 100), 500);
      const offset = Math.max(Number(q.offset ?? 0), 0);
      const [items, total] = await Promise.all([
        prisma.auditEvent.findMany({
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
          include: {
            user: {
              select: { username: true, email: true, avatar: true },
            },
          },
        }),
        prisma.auditEvent.count(),
      ]);
      return { items, total, limit, offset };
    }
  );
}
