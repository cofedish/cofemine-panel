import forge from "node-forge";
import { prisma } from "../db.js";
import { decryptSecret, encryptSecret } from "../crypto.js";

/**
 * The TLS-intercepting CA used by the maven-cache sidecar to MITM
 * CDN downloads (CurseForge edge, Modrinth CDN, loader CDNs, Mojang
 * piston, etc.) so squid can cache the *jar bodies* on disk — the
 * plain-CONNECT mode caches nothing because TLS payloads are opaque.
 *
 * Threat model: this CA signs leaf certs ONLY for whitelisted CDN
 * hostnames inside squid's `ssl_bump bump` ACL. Everything outside
 * that whitelist is `ssl_bump splice`-d (passthrough, no MITM).
 * Player auth (sessionserver.mojang.com etc.) is excluded from the
 * proxy entirely via NO_PROXY on the MC container, so it never even
 * reaches this CA.
 *
 * Both the cert and the private key are encrypted with the panel's
 * SECRETS_KEY before they land in IntegrationSetting (cert PEM is
 * public-ish but we keep the same envelope for symmetry — and the
 * cert is needed to import into JVM truststores, so making it secret
 * costs nothing).
 */

const KEYS = {
  cert: "maven.cache.ca.cert",
  key: "maven.cache.ca.key",
  /** Stored as ISO string. Lets the UI render the validity window
   *  without parsing the cert client-side. */
  notAfter: "maven.cache.ca.notAfter",
  /** Hex SHA-256 of DER. Same fingerprint format Firefox / Chrome
   *  show in their cert details — operator can sanity-check that
   *  the CA installed in any MC container matches what the panel
   *  thinks is current. */
  fingerprint: "maven.cache.ca.fingerprint",
} as const;

export type MavenCaMaterial = {
  /** PEM-encoded root certificate. Safe to ship into MC containers. */
  certPem: string;
  /** PEM-encoded private key. Only sent to maven-cache sidecar,
   *  never to a Minecraft container. */
  keyPem: string;
};

export type MavenCaDisplay = {
  exists: boolean;
  fingerprint: string | null;
  notAfter: string | null;
};

async function readOne(key: string): Promise<string | null> {
  const row = await prisma.integrationSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return decryptSecret(row.value);
  } catch {
    return null;
  }
}

async function writeOne(key: string, value: string): Promise<void> {
  const encrypted = encryptSecret(value);
  await prisma.integrationSetting.upsert({
    where: { key },
    create: { key, value: encrypted },
    update: { value: encrypted },
  });
}

async function deleteOne(key: string): Promise<void> {
  await prisma.integrationSetting.delete({ where: { key } }).catch(() => {});
}

/**
 * Returns the active CA material if both cert + key are present and
 * decrypt cleanly. The agent gets this verbatim; nothing else should
 * touch the private key.
 */
export async function readMavenCa(): Promise<MavenCaMaterial | null> {
  const [certPem, keyPem] = await Promise.all([
    readOne(KEYS.cert),
    readOne(KEYS.key),
  ]);
  if (!certPem || !keyPem) return null;
  return { certPem, keyPem };
}

/** Public-only view for the UI: do not include the private key. */
export async function readMavenCaForDisplay(): Promise<MavenCaDisplay> {
  const [certPem, fingerprint, notAfter] = await Promise.all([
    readOne(KEYS.cert),
    readOne(KEYS.fingerprint),
    readOne(KEYS.notAfter),
  ]);
  return {
    exists: !!certPem,
    fingerprint: fingerprint ?? null,
    notAfter: notAfter ?? null,
  };
}

/** Public PEM for download (.crt). */
export async function readMavenCaCertPem(): Promise<string | null> {
  return readOne(KEYS.cert);
}

export async function clearMavenCa(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((k) => deleteOne(k)));
}

/**
 * Generate a fresh self-signed CA (RSA-2048, valid 10 years) and
 * persist it. The cert is marked as a CA via Basic Constraints + Key
 * Usage so JVM/openssl chains accept it as an intermediate signer.
 *
 * RSA-2048 vs ECC: most JVMs (especially older java8/11 itzg variants
 * the panel still supports) ship with patchy EC curve coverage, while
 * RSA 2048 is universally accepted. 2048 is enough — this CA only
 * signs leaf certs for the lifetime of an install run, not real
 * internet-facing TLS.
 */
export async function generateMavenCa(): Promise<MavenCaDisplay> {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // 16 bytes of entropy, hex-encoded — gives squid's cert generator
  // a stable parent serial to chain leaf certs from.
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(
    now.getFullYear() + 10,
    now.getMonth(),
    now.getDate()
  );
  const attrs = [
    { name: "commonName", value: "Cofemine Panel maven-cache CA" },
    { name: "organizationName", value: "Cofemine" },
    { shortName: "OU", value: "Maven Cache MITM" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
      critical: true,
    },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // SHA-256 fingerprint over the DER. The same value openssl prints
  // with `openssl x509 -fingerprint -sha256 -noout` — handy for an
  // operator who wants to verify the CA inside a running container
  // matches what the panel has.
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  const fingerprint = md
    .digest()
    .toHex()
    .toUpperCase()
    .match(/.{2}/g)!
    .join(":");

  await Promise.all([
    writeOne(KEYS.cert, certPem),
    writeOne(KEYS.key, keyPem),
    writeOne(KEYS.notAfter, cert.validity.notAfter.toISOString()),
    writeOne(KEYS.fingerprint, fingerprint),
  ]);

  return {
    exists: true,
    fingerprint,
    notAfter: cert.validity.notAfter.toISOString(),
  };
}
