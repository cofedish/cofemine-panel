import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { docker } from "../docker.js";

/**
 * Maintenance endpoints for the maven-cache sidecar container.
 *
 * The panel-API hits POST /maven-cache/recreate when the operator
 * changes Download Proxy settings (the same SOCKS/HTTP proxy that
 * used to be injected into MC containers directly is now the upstream
 * chain for maven-cache instead). On a single-node deploy this is the
 * only place the cache lives, so the agent just inspects + recreates
 * its local container.
 *
 * "Recreate" semantics: stop → remove → create-with-new-env → start.
 * docker doesn't expose a live env-mutation API; the only way to push
 * the new UPSTREAM_PROXY value into gost is to make a new container
 * from the same image with the env override and start it.
 */
const RECREATE_BODY = z.object({
  /** New UPSTREAM_PROXY value. Empty / null → cache goes direct. */
  upstreamProxy: z.string().nullable().optional(),
});

/** Compose container naming convention: `<project>-<service>-<idx>`.
 *  The project is "cofemine" (top-level `name:` in compose), service
 *  is "maven-cache". Compose adds a numeric suffix per replica; we
 *  only ever run one instance so it's always "-1". On non-compose
 *  deploys (operator started the container by hand), we also accept
 *  the literal label match. */
const COMPOSE_CONTAINER_NAME = "cofemine-maven-cache-1";

export async function mavenCacheRoutes(app: FastifyInstance): Promise<void> {
  app.post("/maven-cache/recreate", async (req, reply) => {
    const body = RECREATE_BODY.parse(req.body ?? {});
    const target = body.upstreamProxy?.trim() ?? "";

    // Find current container. Try the compose name first, fall back to
    // any container with the `com.docker.compose.service=maven-cache`
    // label.
    let existing: import("dockerode").ContainerInfo | undefined;
    const all = await docker.listContainers({ all: true });
    existing = all.find((c) => c.Names.some((n) => n === `/${COMPOSE_CONTAINER_NAME}`));
    if (!existing) {
      existing = all.find(
        (c) => c.Labels["com.docker.compose.service"] === "maven-cache"
      );
    }
    if (!existing) {
      reply.code(404);
      return { error: "maven-cache container not found — is the service running?" };
    }

    const container = docker.getContainer(existing.Id);
    const inspect = await container.inspect();

    // Build the new env: keep everything the previous container had,
    // overriding only UPSTREAM_PROXY.
    const existingEnv = (inspect.Config?.Env ?? []).filter(
      (line) => !line.startsWith("UPSTREAM_PROXY=")
    );
    if (target) existingEnv.push(`UPSTREAM_PROXY=${target}`);

    // Preserve the rest of HostConfig + NetworkSettings exactly so the
    // container comes back on the same network / volume / restart
    // policy / extra_hosts.
    const oldName = inspect.Name.replace(/^\//, "");
    const networkSettings = inspect.NetworkSettings?.Networks ?? {};
    const networkName = Object.keys(networkSettings)[0] ?? "cofemine_mcnet";

    // Stop + remove the old container. Use a short timeout because
    // nginx + gost handle SIGTERM cleanly.
    try {
      await container.stop({ t: 5 });
    } catch (err: any) {
      // Already stopped is fine. Anything else, surface.
      if (err?.statusCode !== 304) {
        req.log.warn({ err }, "stop failed (continuing to remove)");
      }
    }
    await container.remove({ force: true });

    // Create new container from the same image + same HostConfig.
    const created = await docker.createContainer({
      name: oldName,
      Image: inspect.Image,
      Env: existingEnv,
      ExposedPorts: inspect.Config?.ExposedPorts ?? {},
      Labels: inspect.Config?.Labels ?? {},
      HostConfig: inspect.HostConfig ?? {},
      NetworkingConfig: {
        EndpointsConfig: { [networkName]: {} },
      },
    });
    await created.start();

    req.log.info(
      { name: oldName, upstreamProxy: target || "(direct)" },
      "maven-cache recreated"
    );

    return { ok: true, name: oldName, upstreamProxy: target || null };
  });

  app.get("/maven-cache/status", async () => {
    const all = await docker.listContainers({ all: true });
    const c =
      all.find((x) => x.Names.some((n) => n === `/${COMPOSE_CONTAINER_NAME}`)) ??
      all.find((x) => x.Labels["com.docker.compose.service"] === "maven-cache");
    if (!c) return { running: false, upstreamProxy: null };
    const inspect = await docker.getContainer(c.Id).inspect();
    const env = inspect.Config?.Env ?? [];
    const upstream =
      env.find((e) => e.startsWith("UPSTREAM_PROXY="))?.slice("UPSTREAM_PROXY=".length) ??
      null;
    return {
      running: inspect.State?.Running ?? false,
      upstreamProxy: upstream || null,
      startedAt: inspect.State?.StartedAt ?? null,
      image: inspect.Config?.Image ?? null,
    };
  });
}
