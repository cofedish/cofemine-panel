import crypto from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { listManaged } from "./containers.js";
import { ensureNetwork, seedCaVolumes } from "./ca-volumes.js";
import { mavenCacheStatus, recreateMavenCache } from "./maven-cache.js";
import {
  createServerContainer,
  execInServer,
  inspectServer,
  killServer,
  mergeServerEnv,
  removeServer,
  runInstaller,
  serverLogStream,
  serverLogs,
  serverStats,
  setRestartPolicy,
  startServer,
  stopServer,
  waitForServer,
} from "./servers.js";

/**
 * Docker shim — the only service that mounts `/var/run/docker.sock`.
 *
 * The whole HTTP surface is below, and it is deliberately small enough
 * to read in one sitting. Two properties make the split worth its
 * weight; preserve both when adding anything:
 *
 *   1. Containers are addressed by **server id**, resolved through the
 *      `cofemine.serverId` label. There is no endpoint that takes a
 *      container id, a name, or a filter. The blast radius of a
 *      compromised agent is the set of Minecraft containers this
 *      service created.
 *
 *   2. Nothing on the wire describes *how* a container is built. Image,
 *      binds, capabilities, network and security options are decided by
 *      ItzgRuntimeProvider running in this process. The agent sends a
 *      ServerSpec (type/version/memory/ports/env); it cannot send a
 *      HostConfig, which is what would turn a bug in the agent's file
 *      manager into root on the host.
 *
 * The agent keeps every route that has historically had bugs — archive
 * extraction, uploads, content downloads, the proxy — and now has no
 * socket at all.
 */
const SPEC_SCHEMA = z.object({
  id: z.string().min(1),
  name: z.string(),
  containerName: z.string(),
  type: z.string(),
  version: z.string(),
  memoryMb: z.number().int(),
  cpuLimit: z.number().nullable().optional(),
  ports: z.array(
    z.object({
      host: z.number(),
      container: z.number(),
      protocol: z.enum(["tcp", "udp"]),
    })
  ),
  env: z.record(z.string(), z.string()),
  eulaAccepted: z.boolean(),
});

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function bootstrap(): Promise<void> {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
    // No large bodies here: uploads and archives stay in the agent. The
    // biggest thing this service accepts is a PEM pair.
    bodyLimit: 2 * 1024 * 1024,
  });

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/health") return;
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    if (!timingSafeEqualStrings(auth.slice(7), config.SHIM_TOKEN)) {
      return reply.code(401).send({ error: "Invalid shim token" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "Validation error", issues: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) reply.log.error({ err }, "shim error");
    return reply.code(status).send({ error: err.message });
  });

  app.get("/health", async () => ({ ok: true, role: "docker-shim" }));

  // ---- Minecraft containers ------------------------------------------
  app.get("/mc", async () => ({ containers: await listManaged() }));

  app.post("/mc", async (req) => {
    const spec = SPEC_SCHEMA.parse(req.body);
    return createServerContainer(spec);
  });

  app.get("/mc/:serverId", async (req) => {
    const { serverId } = req.params as { serverId: string };
    return { state: await inspectServer(serverId) };
  });

  app.post("/mc/:serverId/start", async (req) => {
    const { serverId } = req.params as { serverId: string };
    await startServer(serverId);
    return { ok: true };
  });

  app.post("/mc/:serverId/stop", async (req) => {
    const { serverId } = req.params as { serverId: string };
    const body = z
      .object({ timeoutSeconds: z.number().int().min(0).max(600).default(30) })
      .parse(req.body ?? {});
    await stopServer(serverId, body.timeoutSeconds);
    return { ok: true };
  });

  app.post("/mc/:serverId/kill", async (req) => {
    const { serverId } = req.params as { serverId: string };
    await killServer(serverId);
    return { ok: true };
  });

  app.post("/mc/:serverId/remove", async (req) => {
    const { serverId } = req.params as { serverId: string };
    await removeServer(serverId);
    return { ok: true };
  });

  app.post("/mc/:serverId/restart-policy", async (req) => {
    const { serverId } = req.params as { serverId: string };
    const body = z
      .object({ policy: z.enum(["no", "unless-stopped"]) })
      .parse(req.body);
    await setRestartPolicy(serverId, body.policy);
    return { ok: true };
  });

  app.post("/mc/:serverId/wait", async (req) => {
    const { serverId } = req.params as { serverId: string };
    const body = z
      .object({ condition: z.literal("not-running").optional() })
      .parse(req.body ?? {});
    return waitForServer(serverId, body.condition);
  });

  app.get("/mc/:serverId/stats", async (req) => {
    const { serverId } = req.params as { serverId: string };
    return { stats: await serverStats(serverId) };
  });

  // Docker's framed log format is passed through untouched — the agent
  // already has the demuxer and the ANSI/timestamp parsing.
  app.get("/mc/:serverId/logs", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const q = z
      .object({
        tail: z.coerce.number().int().min(1).max(20_000).optional(),
        since: z.coerce.number().int().optional(),
        timestamps: z.coerce.boolean().optional(),
      })
      .parse(req.query ?? {});
    const buf = await serverLogs(serverId, q);
    return reply.type("application/octet-stream").send(buf);
  });

  app.get("/mc/:serverId/logs/stream", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const q = z
      .object({ tail: z.coerce.number().int().min(0).max(5000).optional() })
      .parse(req.query ?? {});
    const stream = await serverLogStream(serverId, q);
    reply.raw.on("close", () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    });
    return reply.type("application/octet-stream").send(stream);
  });

  app.post("/mc/:serverId/exec", async (req) => {
    const { serverId } = req.params as { serverId: string };
    const body = z
      .object({ cmd: z.array(z.string()).min(1).max(64) })
      .parse(req.body);
    return execInServer(serverId, body.cmd);
  });

  app.post("/mc/:serverId/env", async (req) => {
    const { serverId } = req.params as { serverId: string };
    const body = z
      .object({ env: z.record(z.string(), z.string()) })
      .parse(req.body);
    return mergeServerEnv(serverId, body.env);
  });

  app.post("/mc/:serverId/installer", async (req) => {
    const { serverId } = req.params as { serverId: string };
    const body = z
      .object({
        image: z.string().min(1).max(200),
        cmd: z.array(z.string()).min(1).max(64),
        env: z.array(z.string()).max(64).default([]),
      })
      .parse(req.body);
    const result = await runInstaller({ serverId, ...body });
    return { exitCode: result.exitCode, logs: result.logs.toString("base64") };
  });

  // ---- Infrastructure --------------------------------------------------
  app.post("/infra/ca", async (req) => {
    const body = z
      .object({
        upstreamProxy: z.string().max(500).default(""),
        caCertPem: z.string().max(20_000).default(""),
        caKeyPem: z.string().max(20_000).default(""),
      })
      .parse(req.body ?? {});
    return recreateMavenCache(body);
  });

  app.get("/infra/maven-cache", async () => mavenCacheStatus());

  await ensureNetwork(config.DOCKER_NETWORK).catch((err) =>
    app.log.warn({ err }, "ensureNetwork failed at startup")
  );
  await seedCaVolumes().catch((err) =>
    app.log.warn({ err }, "seedCaVolumes failed at startup")
  );

  await app.listen({ host: config.SHIM_HOST, port: config.SHIM_PORT });
  app.log.info(`docker-shim listening on ${config.SHIM_HOST}:${config.SHIM_PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
