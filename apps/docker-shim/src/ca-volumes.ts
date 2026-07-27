import { Writable } from "node:stream";
import { docker } from "./docker.js";

/**
 * CA material distribution for the maven-cache MITM proxy.
 *
 * Moved here from the agent along with the Docker socket: seeding a
 * volume means running a throwaway container with bind mounts, which is
 * exactly the primitive this service exists to keep out of the agent's
 * hands. The agent asks "distribute this cert and key"; it does not get
 * to say which volumes or mount points are involved.
 *
 * Three volumes, and the split is the whole point:
 *
 *   cofemine_maven_cache_ca_key  ca.crt + ca.key   → maven-cache ONLY
 *   cofemine_maven_cache_ca_pub  ca.crt + .ready
 *                                + import.sh       → new MC containers
 *   cofemine_maven_cache_ca      ca.crt + .ready   → MC containers created
 *                                + import.sh         before the split
 *                                (ca.key TRUNCATED)
 *
 * Container binds are immutable, so every MC container created before
 * the split still mounts `cofemine_maven_cache_ca`. It is kept alive as
 * public-only material with `ca.key` truncated on every seed, which
 * removes the key from those containers without recreating them.
 */

/** Private CA volume: ca.crt AND ca.key. Only maven-cache mounts it. */
export const CA_KEY_VOLUME_NAME = "cofemine_maven_cache_ca_key";
/** Public CA volume: exactly what an MC container needs, nothing more. */
export const CA_PUB_VOLUME_NAME = "cofemine_maven_cache_ca_pub";
/** Pre-split volume, kept public-only. Never write key material here. */
export const CA_LEGACY_VOLUME_NAME = "cofemine_maven_cache_ca";
/** Mount point inside MC containers. */
export const CA_MOUNT_PATH = "/cofemine-ca";

/** Idempotently create a named volume. */
export async function ensureVolume(name: string): Promise<void> {
  const list = await docker.listVolumes({
    filters: JSON.stringify({ name: [name] }),
  });
  if (!(list.Volumes ?? []).some((v) => v.Name === name)) {
    await docker.createVolume({ Name: name });
  }
}

export async function ensureNetwork(name: string): Promise<void> {
  const networks = await docker.listNetworks({
    filters: JSON.stringify({ name: [name] }),
  });
  if (networks.length === 0) {
    await docker.createNetwork({ Name: name, Driver: "bridge" });
  }
}

/**
 * Run a shell script in a throwaway alpine container with the given
 * volume binds.
 *
 * Callers inside this package pass fixed binds; there is no path here
 * that lets an HTTP request choose a mount source.
 */
async function runInVolumes(binds: string[], script: string): Promise<void> {
  const have = await docker.listImages({ filters: { reference: ["alpine:3"] } });
  if (have.length === 0) {
    await new Promise<void>((resolve, reject) => {
      docker.pull("alpine:3", (err: unknown, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
      });
    });
  }
  const c = await docker.createContainer({
    Image: "alpine:3",
    Cmd: ["sh", "-c", script],
    HostConfig: { Binds: binds, AutoRemove: true },
  });
  await c.start();
  try {
    await c.wait();
  } catch {
    // AutoRemove races with wait — the write already happened.
  }
}

/** Shell fragment writing one text file, base64 so content needs no escaping. */
function writeFileScript(file: {
  path: string;
  content: string;
  mode?: number;
}): string {
  const b64 = Buffer.from(file.content, "utf8").toString("base64");
  return [
    `echo '${b64}' | base64 -d > '${file.path}'`,
    `chmod ${(file.mode ?? 0o644).toString(8)} '${file.path}'`,
  ].join(" && ");
}

async function writeFilesToVolume(
  volumeName: string,
  files: Array<{ path: string; content: string; mode?: number }>
): Promise<void> {
  await runInVolumes(
    [`${volumeName}:/dst`],
    files.map((f) => writeFileScript({ ...f })).join(" && ")
  );
}

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

/**
 * Refresh import.sh in both MC-facing volumes, mirror public material
 * outward from the private volume, and truncate the private key left in
 * the legacy volume by pre-split deploys. Safe to call on every boot.
 */
export async function seedCaVolumes(): Promise<void> {
  await Promise.all([
    ensureVolume(CA_KEY_VOLUME_NAME),
    ensureVolume(CA_PUB_VOLUME_NAME),
    ensureVolume(CA_LEGACY_VOLUME_NAME),
  ]);
  const script = [
    writeFileScript({ path: "/pub/import.sh", content: CA_IMPORT_SCRIPT, mode: 0o755 }),
    writeFileScript({ path: "/legacy/import.sh", content: CA_IMPORT_SCRIPT, mode: 0o755 }),
    // Truncate rather than delete: squid's entrypoint and import.sh both
    // test with `-s`, so an empty file reads as "no CA" everywhere.
    ": > /legacy/ca.key",
    "chmod 600 /legacy/ca.key",
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
 * Write freshly generated CA material across the three volumes.
 * `ca.key` goes to the private volume only — never add it to the pub or
 * legacy lists, those are mounted into Minecraft containers.
 */
export async function distributeCaMaterial(
  certPem: string,
  keyPem: string
): Promise<{ configured: boolean }> {
  await Promise.all([
    ensureVolume(CA_KEY_VOLUME_NAME),
    ensureVolume(CA_PUB_VOLUME_NAME),
    ensureVolume(CA_LEGACY_VOLUME_NAME),
  ]);
  const configured = Boolean(certPem && keyPem);
  const cert = configured ? certPem : "";
  const ready = configured ? "1\n" : "0\n";
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
  await writeFilesToVolume(CA_LEGACY_VOLUME_NAME, [
    ...publicMaterial,
    { path: "/dst/ca.key", content: "", mode: 0o600 },
  ]);
  return { configured };
}

void Writable;
