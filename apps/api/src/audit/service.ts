import type { FastifyRequest } from "fastify";
import { prisma } from "../db.js";

export interface AuditInput {
  action: string;
  resource?: string;
  metadata?: Record<string, unknown>;
}

export async function writeAudit(
  req: FastifyRequest,
  input: AuditInput
): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        userId: req.user?.id ?? null,
        action: input.action,
        resource: input.resource ?? null,
        metadata: (input.metadata as object) ?? undefined,
        ip: req.ip ?? null,
      },
    });
  } catch (err) {
    req.log.error({ err }, "audit: failed to persist event");
  }
}
