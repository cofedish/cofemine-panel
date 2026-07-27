import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  docker,
  ensureVolume,
  runInVolumes,
  writeFilesToVolume,
  writeFileScript,
} from "../docker.js";

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
 * CA distribution uses THREE volumes, and the split is the whole point:
 *
 *   cofemine_maven_cache_ca_key  ca.crt + ca.key   → maven-cache ONLY
 *   cofemine_maven_cache_ca_pub  ca.crt + .ready
 *                                + import.sh       → new MC containers
 *   cofemine_maven_cache_ca      ca.crt + .ready   → MC containers created
 *                                + import.sh         before the split
 *                                (ca.key TRUNCATED)
 *
 * Originally cert and key shared one volume that every MC container
 * mounted, which handed the CA's *private key* to every modpack the
 * panel runs — arbitrary third-party code holding a signing key for a
 * root the JVM trusts.
 *
 * Why three and not two: a container's binds are immutable, so every MC
 * container created before the split still mounts
 * `cofemine_maven_cache_ca`. Simply moving new containers to a new
 * volume would leave the key exposed to all of them — and the *next*
 * CA rotation would drop a fresh key right back into their view. So the
 * key moved to its own volume, the sidecar follows it there, and the
 * legacy volume is kept alive as public-only material with `ca.key`
 * truncated on every seed. Legacy containers keep booting (import.sh
 * reads only ca.crt and .ready) and stop seeing key material without
 * being recreated.
 */
const RECREATE_BODY = z.object({
  /** New UPSTREAM_PROXY value. Empty / null → cache goes direct. */
  upstreamProxy: z.string().nullable().optional(),
  /** PEM. When null, MITM is disabled — squid runs in pure splice
   *  mode and tunnels TLS through without caching jar bodies. */
  caCertPem: z.string().nullable().optional(),
  /** PEM, private key for the CA. Written only to the private volume
   *  that the maven-cache sidecar mounts — never into the volume MC
   *  containers see. */
  caKeyPem: z.string().nullable().optional(),
});

const COMPOSE_CONTAINER_NAME = "cofemine-maven-cache-1";

/** Private CA volume: holds ca.crt AND ca.key. Mounted read-only by the
 *  maven-cache sidecar at /etc/cofemine/ca and by nothing else. Declared
 *  in both compose files with an explicit literal `name:`. */
export const CA_KEY_VOLUME_NAME = "cofemine_maven_cache_ca_key";

/** Public CA volume: ca.crt + .ready + import.sh, i.e. exactly what an
 *  MC container needs to trust squid's leaf certs and nothing more.
 *  Created by the agent on first use (not declared in compose — no
 *  compose service mounts it; only agent-created MC containers do). */
export const CA_PUB_VOLUME_NAME = "cofemine_maven_cache_ca_pub";

/** The original single volume. MC containers created before the split
 *  still mount it and cannot be re-bound without a recreate, so it is
 *  maintained as public-only material: same cert/.ready/import.sh as the
 *  pub volume, with `ca.key` truncated to empty on every seed. Nothing
 *  writes key material here — ever. */
export const CA_LEGACY_VOLUME_NAME = "cofemine_maven_cache_ca";

/** Mount point inside MC containers. itzg-provider references the
 *  same constant so the STARTUP_SCRIPT env path matches. */
export const CA_MOUNT_PATH = "/cofemine-ca";

/**
 * Idempotently rewrite the wrapper script into the CA volume on agent
 * startup. The script is the entrypoint for every MC container, so a
 * stale version (e.g. from before the operator ran an agent upgrade)
 * means freshly-recreated MC containers crashloop with the OLD script
 * until they hit a /maven-cache/recreate via CA-generate or Re-apply.
 *
 * We only touch import.sh — ca.crt / .ready are owned by the API and
 * only seeded on /maven-cache/recreate. Safe to call at boot even on a
 * fresh agent: ensureVolume creates the volume if missing.
 *
 * Writes to the PUBLIC volume only. The private volume holds key
 * material for squid and must not gain an executable that MC containers
 * could ever be pointed at.
 */
export async function seedCaVolumes(): Promise<void> {
  await Promise.all([
    ensureVolume(CA_KEY_VOLUME_NAME),
    ensureVolume(CA_PUB_VOLUME_NAME),
    ensureVolume(CA_LEGACY_VOLUME_NAME),
  ]);
  // One throwaway container mounting all three volumes, so the three
  // stay consistent even if the API never gets around to calling
  // /maven-cache/recreate.
  //
  //   1. refresh import.sh in both MC-facing volumes;
  //   2. truncate ca.key in the legacy volume — this is what actually
  //      removes the key from every MC container created before the
  //      volume split, without recreating them;
  //   3. mirror ca.crt/.ready from the private volume so a server
  //      created before the API's first apply still gets a trustable
  //      cert. Without this the container mounts an empty pub volume,
  //      import.sh no-ops, and squid bumps with a leaf the JVM doesn't
  //      trust — an SSLHandshakeException with no obvious cause.
  const importSh = writeFileScript({
    path: "/pub/import.sh",
    content: CA_IMPORT_SCRIPT,
    mode: 0o755,
  });
  const importShLegacy = writeFileScript({
    path: "/legacy/import.sh",
    content: CA_IMPORT_SCRIPT,
    mode: 0o755,
  });
  const script = [
    importSh,
    importShLegacy,
    // Truncate rather than delete: squid's entrypoint and import.sh both
    // test with `-s`, so an empty file reads as "no CA" everywhere.
    ": > /legacy/ca.key",
    "chmod 600 /legacy/ca.key",
    // Mirror public material outward from the private volume.
    'if [ -s /key/ca.crt ]; then cp /key/ca.crt /pub/ca.crt && cp /key/ca.crt /legacy/ca.crt && chmod 644 /pub/ca.crt /legacy/ca.crt; fi',
    'if [ -f /key/.ready ]; then cp /key/.ready /pub/.ready && cp /key/.ready /legacy/.ready && chmod 644 /pub/.ready /legacy/.ready; fi',
  ].join(" ; ");
  await runInVolumes(
    [
      `${CA_KEY_VOLUME_NAME}:/key`,
      `${CA_PUB_VOLUME_NAME}:/pub`,
      `${CA_LEGACY_VOLUME_NAME}:/legacy`,
    ],
    script
  );
}

/**
 * Wrapper entrypoint seeded into the CA volume alongside the cert.
 * The agent overrides each MC container's `Entrypoint` to this script
 * (NOT itzg's `STARTUP_SCRIPT` env — that helper isn't universal
 * across itzg image variants). The wrapper:
 *
 *   1. Imports the panel CA into the JVM cacerts (so mc-image-helper's
 *      Java HttpClient trusts squid's MITM leaf certs).
 *   2. Drops the CA into /usr/local/share/ca-certificates/ + runs
 *      update-ca-certificates (so curl/wget paths used by install
 *      scripts also trust it).
 *   3. `exec /start "$@"` — hands off to itzg's normal entrypoint
 *      with whatever CMD docker passed in.
 *
 * Robust to image variants: keytool path is probed across JAVA_HOME
 * variants (java8-jdk, java17, java21, graalvm, …) and PATH. cacerts
 * file is probed against both $JAVA_HOME/lib/security and the
 * Debian-symlinked /etc/ssl/certs/java/. Any failure is logged and
 * the wrapper still execs /start — we never want a CA hiccup to
 * brick the MC server's boot.
 */
const CA_IMPORT_SCRIPT_VERSION = "3";
const CA_IMPORT_SCRIPT = `#!/bin/sh
# import.sh version ${CA_IMPORT_SCRIPT_VERSION} — bump this when the script
# body changes so a stale volume is obvious in the container log.
echo '[cofemine-ca] wrapper v${CA_IMPORT_SCRIPT_VERSION} starting'
# NOTE: no \`set -e\` — failures here must not block /start.
CA_FILE='${CA_MOUNT_PATH}/ca.crt'
READY='${CA_MOUNT_PATH}/.ready'
import_ca() {
  if [ ! -s "$CA_FILE" ] || [ ! -f "$READY" ] || [ "$(cat "$READY" 2>/dev/null)" != "1" ]; then
    echo '[cofemine-ca] no CA configured — skipping import'
    return 0
  fi
  KEYTOOL=""
  for cand in "\${JAVA_HOME:-}/bin/keytool" /opt/java/openjdk/bin/keytool /usr/lib/jvm/*/bin/keytool; do
    if [ -x "$cand" ]; then KEYTOOL="$cand"; break; fi
  done
  if [ -z "$KEYTOOL" ]; then
    KEYTOOL="$(command -v keytool 2>/dev/null || true)"
  fi
  if [ -z "$KEYTOOL" ] || [ ! -x "$KEYTOOL" ]; then
    echo '[cofemine-ca] WARN keytool not found — JVM will not trust squid'
  else
    CACERTS=""
    for cand in "\${JAVA_HOME:-}/lib/security/cacerts" /opt/java/openjdk/lib/security/cacerts /etc/ssl/certs/java/cacerts /usr/lib/jvm/*/lib/security/cacerts; do
      if [ -f "$cand" ]; then CACERTS="$cand"; break; fi
    done
    if [ -z "$CACERTS" ]; then
      echo '[cofemine-ca] WARN cacerts not found — JVM will not trust squid'
    else
      "$KEYTOOL" -delete -alias cofemine-maven-cache -keystore "$CACERTS" -storepass changeit >/dev/null 2>&1
      if "$KEYTOOL" -importcert -noprompt -trustcacerts -alias cofemine-maven-cache -file "$CA_FILE" -keystore "$CACERTS" -storepass changeit >/dev/null 2>&1; then
        echo "[cofemine-ca] imported into $CACERTS"
      else
        echo '[cofemine-ca] WARN keytool import failed (continuing)'
      fi
    fi
  fi
  if command -v update-ca-certificates >/dev/null 2>&1; then
    mkdir -p /usr/local/share/ca-certificates
    cp "$CA_FILE" /usr/local/share/ca-certificates/cofemine-maven-cache.crt 2>/dev/null
    update-ca-certificates >/dev/null 2>&1
  fi
}
import_ca
# Hand off to itzg's stock entrypoint. The image declares ENTRYPOINT
# ["/start"] (which itself exec's /image/scripts/start) — we replaced
# it with this script, so we have to invoke it ourselves and forward
# the original CMD ("$@"). Verify it exists with a clear log line so
# a missing /start in a future itzg image variant is obvious instead
# of looking like a silent crash-loop.
if [ ! -x /start ]; then
  echo '[cofemine-ca] FATAL /start not executable — image layout changed?'
  ls -la /start /image/scripts/start 2>&1
  exit 1
fi
echo '[cofemine-ca] handing off to /start'
exec /start "$@"
echo '[cofemine-ca] FATAL exec /start returned (should be unreachable)'
exit 1
`;

export async function mavenCacheRoutes(app: FastifyInstance): Promise<void> {
  app.post("/maven-cache/recreate", async (req, reply) => {
    const body = RECREATE_BODY.parse(req.body ?? {});
    const target = body.upstreamProxy?.trim() ?? "";

    // Step 1: seed both CA volumes. We always do this — even when
    // there's no CA — so a stale CA from a previous generate cycle
    // doesn't linger inside MC containers. The marker file lets squid
    // tell "no CA configured" apart from "volume not initialised".
    //
    // The private key goes to CA_KEY_VOLUME_NAME only. Never add ca.key
    // to the pub or legacy lists below: those volumes are mounted into
    // Minecraft containers, i.e. into arbitrary third-party mod code.
    await Promise.all([
      ensureVolume(CA_KEY_VOLUME_NAME),
      ensureVolume(CA_PUB_VOLUME_NAME),
      ensureVolume(CA_LEGACY_VOLUME_NAME),
    ]);
    const certPem = body.caCertPem?.trim() ?? "";
    const keyPem = body.caKeyPem?.trim() ?? "";
    const configured = Boolean(certPem && keyPem);
    const cert = configured ? certPem : "";
    const ready = configured ? "1\n" : "0\n";
    // Empty sentinel files (rather than deletions) keep the volumes in a
    // known shape; the MC-side import script no-ops on an empty cert.
    await writeFilesToVolume(CA_KEY_VOLUME_NAME, [
      { path: "/dst/ca.crt", content: cert, mode: 0o644 },
      { path: "/dst/ca.key", content: configured ? keyPem : "", mode: 0o600 },
      { path: "/dst/.ready", content: ready, mode: 0o644 },
    ]);
    const publicMaterial = [
      { path: "/dst/ca.crt", content: cert, mode: 0o644 },
      { path: "/dst/.ready", content: ready, mode: 0o644 },
      { path: "/dst/import.sh", content: CA_IMPORT_SCRIPT, mode: 0o755 },
    ];
    await writeFilesToVolume(CA_PUB_VOLUME_NAME, publicMaterial);
    // Legacy volume: same public material, plus an explicit truncation
    // of any ca.key left there by a pre-split deploy. MC containers
    // created before the split mount this volume and cannot be re-bound
    // without a recreate, so this is the only way the key stops being
    // visible to them.
    await writeFilesToVolume(CA_LEGACY_VOLUME_NAME, [
      ...publicMaterial,
      { path: "/dst/ca.key", content: "", mode: 0o600 },
    ]);

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
    // Preserve the service alias (e.g. `maven-cache`) so MC containers
    // and the agent itself can still resolve the cache by its short
    // name after a recreate. Without this, every recreate strips the
    // alias docker compose put on the container at first start, and
    // anything pointing at `http://maven-cache` breaks with NXDOMAIN.
    const rawAliases: string[] =
      (networkSettings[networkName] as { Aliases?: string[] } | undefined)
        ?.Aliases ?? [];
    const existingAliases = rawAliases.filter(
      (a) => typeof a === "string" && !a.startsWith(inspect.Id.slice(0, 12))
    );
    if (!existingAliases.includes("maven-cache")) {
      existingAliases.push("maven-cache");
    }

    // Make sure the CA volume is mounted into the new container. The
    // compose-created sidecar usually already has it, but on an older
    // deploy / hand-rolled run it might be missing — splice it in
    // here so squid finds the cert without the operator editing
    // compose.
    const hostConfig = inspect.HostConfig ?? {};
    // Drop a pre-split bind of the legacy volume if it's still there:
    // that volume no longer carries a key, so leaving it mounted at
    // /etc/cofemine/ca would silently put squid into splice-only mode.
    const binds = (hostConfig.Binds ?? []).filter(
      (b) => !b.startsWith(`${CA_LEGACY_VOLUME_NAME}:`)
    );
    if (!binds.some((b) => b.startsWith(`${CA_KEY_VOLUME_NAME}:`))) {
      binds.push(`${CA_KEY_VOLUME_NAME}:/etc/cofemine/ca:ro`);
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

    // Use the image *tag* (Config.Image) rather than the resolved sha
    // (inspect.Image). When the operator rebuilds the cache image
    // locally (docker compose build maven-cache), the old sha is
    // garbage-collected and the recreate call fails with "no such
    // image". The tag is stable across rebuilds.
    const imageRef =
      inspect.Config?.Image && inspect.Config.Image.length > 0
        ? inspect.Config.Image
        : inspect.Image;
    const created = await docker.createContainer({
      name: oldName,
      Image: imageRef,
      Env: existingEnv,
      ExposedPorts: inspect.Config?.ExposedPorts ?? {},
      Labels: inspect.Config?.Labels ?? {},
      HostConfig: hostConfig,
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: { Aliases: existingAliases },
        },
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
      b.startsWith(`${CA_KEY_VOLUME_NAME}:`)
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
