import Fastify from "fastify";
import cookie from "@fastify/cookie";
import sensible from "@fastify/sensible";
import { ZodError } from "zod";
import { prisma } from "./db.js";
import { registerAuthHook } from "./auth/plugin.js";
import { mapRoutes } from "./servers/map-routes.js";

/**
 * Dedicated map-proxy process.
 *
 * Why this exists as a separate entrypoint: the BlueMap iframe fans
 * out 100+ parallel tile/asset fetches the moment a player walks into
 * a new chunk. Even with caches in front of Postgres and docker.sock,
 * those requests still occupy the HTTP serving event loop and add
 * GC / streaming pressure to whichever Node process serves them.
 * Running map traffic in the same process as the panel API meant a
 * busy map page made the rest of the panel feel laggy / "Loading…".
 *
 * Splitting it out gives map traffic its own pid, its own event loop,
 * its own undici / Prisma pools, and lets the OS schedule it on a
 * different core from the panel API. The two processes share the
 * same Docker image and the same Prisma client — only the entrypoint
 * differs.
 *
 * Auth model: identical to the panel API. The session cookie is
 * verified via the same registerAuthHook → loadUser path, and
 * server.view permissions are checked in mapRoutes via the cached
 * assertServerPermissionCached helper. So a request without a valid
 * panel session can never reach a Minecraft container.
 */

const PORT = Number(process.env.MAP_PROXY_PORT ?? "4500");
const HOST = process.env.MAP_PROXY_HOST ?? "0.0.0.0";

async function bootstrap(): Promise<void> {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
    },
    trustProxy: true,
    // Same reason as in api/main.ts: BlueMap's iframe loads at
    // /servers/:id/map/bluemap/ (trailing slash) which Fastify's
    // wildcard `*` does not reliably match without this flag.
    ignoreTrailingSlash: true,
  });

  app.addHook("onSend", (_req, reply, payload, done) => done(null, payload));
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };

  await app.register(cookie);
  await app.register(sensible);

  await registerAuthHook(app);
  // Reject anything without a session cookie. We don't whitelist /health
  // or /auth/* here — this process serves the panel UI's logged-in
  // users only, nothing else.
  app.addHook("preHandler", async (req, reply) => {
    if (req.routerPath === "/health") return;
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
    role: "map-proxy",
    pid: process.pid,
    version: process.env.npm_package_version ?? "0.1.0",
  }));

  await app.register(mapRoutes);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`map-proxy listening on ${HOST}:${PORT} (pid ${process.pid})`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
