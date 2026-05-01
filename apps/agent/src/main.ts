import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { serversAgentRoutes } from "./routes/servers.js";
import { backupsAgentRoutes } from "./routes/backups.js";
import { installAgentRoutes } from "./routes/install.js";
import { proxyAgentRoutes } from "./routes/proxy.js";
import { consoleAgentWs } from "./ws/console.js";
import { ensureNetwork } from "./docker.js";
import { ensureDir } from "./paths.js";

async function bootstrap(): Promise<void> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  await app.register(websocket);

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/health") return;
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    if (auth.slice(7) !== config.AGENT_TOKEN) {
      return reply.code(401).send({ error: "Invalid agent token" });
    }
  });

  app.get("/health", async () => ({ ok: true, version: "0.1.0" }));

  await app.register(serversAgentRoutes);
  await app.register(backupsAgentRoutes);
  await app.register(installAgentRoutes);
  await app.register(proxyAgentRoutes);
  await consoleAgentWs(app);

  await ensureDir(config.AGENT_DATA_ROOT);
  await ensureDir(config.AGENT_BACKUP_ROOT);
  await ensureNetwork(config.AGENT_DOCKER_NETWORK).catch((err) =>
    app.log.warn({ err }, "ensureNetwork failed at startup")
  );

  await app.listen({ host: config.AGENT_HOST, port: config.AGENT_PORT });
  app.log.info(`Agent listening on ${config.AGENT_HOST}:${config.AGENT_PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
