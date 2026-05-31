import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { docker, ensureVolume, writeFilesToVolume } from "../docker.js";

/**
 * Maintenance endpoints for the maven-cache sidecar container.
 *
 * The panel-API hits POST /maven-cache/recreate when the operator
 * changes Download Proxy settings, or generates/clears the MITM CA.
 * On a single-node deploy this is the only place the cache lives.
 *
 * "Recreate" semantics: stop → remove → create-with-new-env → start.
 * docker doesn't expose a live env-mutation API; the only way to push
 * the new UPSTREAM_PROXY (and the new CA material via volume reseed)
 * into squid is to make a new container from the same image and
 * restart it.
 *
 * CA distribution: the cert + key (when present) are written into the
 * shared named volume `cofemine_maven_cache_ca` before the cache
 * sidecar is recreated. The cache itself mounts that volume read-only
 * at /etc/cofemine/ca/; every MC container mounts the same volume
 * read-only and a STARTUP_SCRIPT inside the MC container imports
 * the cert into the JVM cacerts so squid's MITM leaves valid for the
 * loader installer + mc-image-helper.
 */
const RECREATE_BODY = z.object({
  /** New UPSTREAM_PROXY value. Empty / null → cache goes direct. */
  upstreamProxy: z.string().nullable().optional(),
  /** PEM. When null, MITM is disabled — squid runs in pure splice
   *  mode and tunnels TLS through without caching jar bodies. */
  caCertPem: z.string().nullable().optional(),
  /** PEM, private key for the CA. Only used by squid; never given
   *  to MC containers. */
  caKeyPem: z.string().nullable().optional(),
});

const COMPOSE_CONTAINER_NAME = "cofemine-maven-cache-1";

/** Named docker volume that the cache sidecar and every MC container
 *  mount read-only. Owned by the agent — created on first use. */
export const CA_VOLUME_NAME = "cofemine_maven_cache_ca";

/** Mount point inside MC containers. itzg-provider references the
 *  same constant so the STARTUP_SCRIPT env path matches. */
export const CA_MOUNT_PATH = "/cofemine-ca";

/**
 * Script seeded into the CA volume alongside ca.crt/ca.key, executed
 * by itzg's STARTUP_SCRIPT hook before mc-image-helper runs. Imports
 * the panel CA into the JVM cacerts so squid's MITM leaves validate
 * during the install phase. No-ops cleanly when no CA is configured.
 *
 * Keytool path resolves $JAVA_HOME at runtime — itzg images vary
 * (java8-jdk, java21, graalvm, …). Falls back to PATH lookup.
 */
const CA_IMPORT_SCRIPT = `#!/bin/sh
set -u
CA_FILE='${CA_MOUNT_PATH}/ca.crt'
READY='${CA_MOUNT_PATH}/.ready'
if [ ! -s "$CA_FILE" ] || [ ! -f "$READY" ] || [ "$(cat "$READY" 2>/dev/null)" != "1" ]; then
  echo '[cofemine-ca] no CA configured — skipping import'
  exit 0
fi
KEYTOOL="\${JAVA_HOME:-/opt/java/openjdk}/bin/keytool"
if [ ! -x "$KEYTOOL" ]; then
  KEYTOOL="$(command -v keytool || true)"
fi
if [ -z "$KEYTOOL" ] || [ ! -x "$KEYTOOL" ]; then
  echo '[cofemine-ca] WARN keytool not found — TLS to maven-cache will fail'
  exit 0
fi
CACERTS="\${JAVA_HOME:-/opt/java/openjdk}/lib/security/cacerts"
if [ ! -f "$CACERTS" ] && [ -f /etc/ssl/certs/java/cacerts ]; then
  CACERTS=/etc/ssl/certs/java/cacerts
fi
"$KEYTOOL" -delete -alias cofemine-maven-cache -keystore "$CACERTS" -storepass changeit >/dev/null 2>&1 || true
if "$KEYTOOL" -importcert -noprompt -trustcacerts \\
    -alias cofemine-maven-cache \\
    -file "$CA_FILE" \\
    -keystore "$CACERTS" \\
    -storepass changeit; then
  echo "[cofemine-ca] imported into $CACERTS"
else
  echo '[cofemine-ca] WARN keytool import failed (continuing)'
fi
if command -v update-ca-certificates >/dev/null 2>&1; then
  mkdir -p /usr/local/share/ca-certificates
  cp "$CA_FILE" /usr/local/share/ca-certificates/cofemine-maven-cache.crt
  update-ca-certificates >/dev/null 2>&1 || true
fi
exit 0
`;

export async function mavenCacheRoutes(app: FastifyInstance): Promise<void> {
  app.post("/maven-cache/recreate", async (req, reply) => {
    const body = RECREATE_BODY.parse(req.body ?? {});
    const target = body.upstreamProxy?.trim() ?? "";

    // Step 1: seed the shared CA volume. We always do this — even when
    // there's no CA — so a stale CA from a previous generate cycle
    // doesn't linger inside MC containers. The marker file lets squid
    // tell "no CA configured" apart from "volume not initialised".
    await ensureVolume(CA_VOLUME_NAME);
    const certPem = body.caCertPem?.trim() ?? "";
    const keyPem = body.caKeyPem?.trim() ?? "";
    if (certPem && keyPem) {
      await writeFilesToVolume(CA_VOLUME_NAME, [
        { path: "/dst/ca.crt", content: certPem, mode: 0o644 },
        { path: "/dst/ca.key", content: keyPem, mode: 0o600 },
        { path: "/dst/.ready", content: "1\n", mode: 0o644 },
        { path: "/dst/import.sh", content: CA_IMPORT_SCRIPT, mode: 0o755 },
      ]);
    } else {
      // Wipe the CA files when MITM is disabled. We use a sentinel
      // empty cert to keep the volume in a known shape; the MC-side
      // import script no-ops on empty cert files.
      await writeFilesToVolume(CA_VOLUME_NAME, [
        { path: "/dst/ca.crt", content: "", mode: 0o644 },
        { path: "/dst/ca.key", content: "", mode: 0o600 },
        { path: "/dst/.ready", content: "0\n", mode: 0o644 },
        { path: "/dst/import.sh", content: CA_IMPORT_SCRIPT, mode: 0o755 },
      ]);
    }

    // Step 2: find current container. Try the compose name first,
    // fall back to any container with the
    // `com.docker.compose.service=maven-cache` label.
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

    const oldName = inspect.Name.replace(/^\//, "");
    const networkSettings = inspect.NetworkSettings?.Networks ?? {};
    const networkName = Object.keys(networkSettings)[0] ?? "cofemine_mcnet";

    // Make sure the CA volume is mounted into the new container. The
    // compose-created sidecar usually already has it, but on an older
    // deploy / hand-rolled run it might be missing — splice it in
    // here so squid finds the cert without the operator editing
    // compose.
    const hostConfig = inspect.HostConfig ?? {};
    const binds = [...(hostConfig.Binds ?? [])];
    if (!binds.some((b) => b.startsWith(`${CA_VOLUME_NAME}:`))) {
      binds.push(`${CA_VOLUME_NAME}:/etc/cofemine/ca:ro`);
    }
    hostConfig.Binds = binds;

    // Stop + remove the old container.
    try {
      await container.stop({ t: 5 });
    } catch (err: any) {
      if (err?.statusCode !== 304) {
        req.log.warn({ err }, "stop failed (continuing to remove)");
      }
    }
    await container.remove({ force: true });

    const created = await docker.createContainer({
      name: oldName,
      Image: inspect.Image,
      Env: existingEnv,
      ExposedPorts: inspect.Config?.ExposedPorts ?? {},
      Labels: inspect.Config?.Labels ?? {},
      HostConfig: hostConfig,
      NetworkingConfig: {
        EndpointsConfig: { [networkName]: {} },
      },
    });
    await created.start();

    req.log.info(
      {
        name: oldName,
        upstreamProxy: target || "(direct)",
        ca: certPem && keyPem ? "configured" : "absent",
      },
      "maven-cache recreated"
    );

    return {
      ok: true,
      name: oldName,
      upstreamProxy: target || null,
      ca: certPem && keyPem ? "configured" : null,
    };
  });

  app.get("/maven-cache/status", async () => {
    const all = await docker.listContainers({ all: true });
    const c =
      all.find((x) => x.Names.some((n) => n === `/${COMPOSE_CONTAINER_NAME}`)) ??
      all.find((x) => x.Labels["com.docker.compose.service"] === "maven-cache");
    if (!c) return { running: false, upstreamProxy: null, caMounted: false };
    const inspect = await docker.getContainer(c.Id).inspect();
    const env = inspect.Config?.Env ?? [];
    const upstream =
      env.find((e) => e.startsWith("UPSTREAM_PROXY="))?.slice("UPSTREAM_PROXY=".length) ??
      null;
    const caMounted = (inspect.HostConfig?.Binds ?? []).some((b) =>
      b.startsWith(`${CA_VOLUME_NAME}:`)
    );
    return {
      running: inspect.State?.Running ?? false,
      upstreamProxy: upstream || null,
      caMounted,
      startedAt: inspect.State?.StartedAt ?? null,
      image: inspect.Config?.Image ?? null,
    };
  });
}
