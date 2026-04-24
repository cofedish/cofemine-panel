import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { registerAuthHook } from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { nodesRoutes } from "./nodes/routes.js";
import { serversRoutes } from "./servers/routes.js";
import { backupsRoutes } from "./backups/routes.js";
import { schedulesRoutes } from "./schedules/routes.js";
import { templatesRoutes } from "./templates/routes.js";
import { usersRoutes } from "./users/routes.js";
import { auditRoutes } from "./audit/routes.js";
import { integrationsRoutes } from "./integrations/routes.js";
import { metaRoutes } from "./meta/routes.js";
import { registerConsoleWs } from "./ws/console.js";
import { startScheduler } from "./schedules/scheduler.js";
import { startInstallWatchdog } from "./servers/install-watchdog.js";

async function bootstrap(): Promise<void> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
    },
    trustProxy: true,
  });

  // BigInt serialization for JSON responses.
  app.addHook("onSend", (_req, reply, payload, done) => done(null, payload));
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: [config.WEB_ORIGIN],
    credentials: true,
  });
  await app.register(cookie);
  await app.register(sensible);
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
  });
  await app.register(websocket);

  await registerAuthHook(app);

  // Global auth gate for protected routes. /auth/setup-status, /auth/setup,
  // /auth/login are whitelisted.
  app.addHook("preHandler", async (req, reply) => {
    const open = new Set([
      "/health",
      "/auth/setup-status",
      "/auth/setup",
      "/auth/login",
    ]);
    if (open.has(req.routerPath) || req.routerPath?.startsWith("/ws/")) return;
    if (!req.user) return reply.code(401).send({ error: "Unauthorized" });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation error", issues: err.issues });
    }
    const status = (err as any).statusCode ?? 500;
    if (status >= 500) reply.log.error({ err }, "unhandled error");
    return reply.code(status).send({ error: err.message });
  });

  app.get("/health", async () => ({
    ok: true,
    version: process.env.npm_package_version ?? "0.1.0",
  }));

  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(nodesRoutes, { prefix: "/nodes" });
  await app.register(serversRoutes, { prefix: "/servers" });
  await app.register(backupsRoutes); // mounts under /servers/:id/backups and /backups/:id
  await app.register(schedulesRoutes);
  await app.register(templatesRoutes, { prefix: "/templates" });
  await app.register(usersRoutes, { prefix: "/users" });
  await app.register(auditRoutes, { prefix: "/audit" });
  await app.register(integrationsRoutes, { prefix: "/integrations" });
  await app.register(metaRoutes, { prefix: "/meta" });
  await registerConsoleWs(app);

  await startScheduler();
  startInstallWatchdog();

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  app.log.info(`API listening on ${config.API_HOST}:${config.API_PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
