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
 * Mojang auth domains are excluded from that ACL, so session traffic is
 * tunnelled without ever being decrypted here.
 *
 * The certificate carries X.509 Name Constraints limiting it to the CDN
 * domains below — but do not treat that as the control protecting you.
 *
 * **Name Constraints do not bind Java clients.** The JDK's PKIXValidator
 * builds trust anchors as `new TrustAnchor(cert, null)`, discarding any
 * name constraints the anchor itself carries, so a leaf signed by this
 * CA for an unrelated host is accepted by a JVM that trusts it. Java is
 * exactly the client that matters here — mc-image-helper and the
 * Minecraft server are the whole reason this cert is imported into
 * cacerts. The constraint does bind OpenSSL-based clients (curl/wget
 * inside the container, an operator's browser), so it stays, but the
 * property that actually contains a compromise is key confinement: the
 * private key only ever reaches the maven-cache sidecar's own volume
 * (see apps/agent/src/routes/maven-cache.ts).
 *
 * Caveat worth testing on a staging server: squid mimics the origin
 * certificate when it mints a leaf, including subjectAltName. If a CDN
 * behind Cloudflare presents SANs outside the permitted set, the whole
 * leaf fails constraint checking — which would break the OpenSSL path
 * while Java carries on, i.e. a confusing partial failure.
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
  /**
   * PEM-encoded private key. The agent writes it to the private
   * `cofemine_maven_cache_ca` volume, which only the maven-cache
   * sidecar mounts. MC containers mount the separate `_ca_pub` volume,
   * which never receives this value — see
   * apps/agent/src/routes/maven-cache.ts.
   */
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
 * Domains this CA is permitted to sign for. Must stay a superset of
 * squid's `mitm_domains` ACL (services/maven-cache/squid.conf.template)
 * — a domain that squid bumps but that isn't listed here produces a
 * leaf certificate every PKIX verifier rejects, which surfaces as a
 * failed modpack install.
 *
 * Bare domains, not `.domain`: an X.509 dNSName constraint already
 * covers the domain and everything under it.
 */
const PERMITTED_DOMAINS = [
  "forgecdn.net",
  "curseforge.com",
  "modrinth.com",
  "neoforged.net",
  "minecraftforge.net",
  "fabricmc.net",
  "quiltmc.org",
];

/**
 * Validity window. Short on purpose: this is a trust root installed
 * into every Minecraft container's JVM truststore, and there is no
 * revocation path for it — expiry IS the revocation mechanism. 180 days
 * rather than 90 because rotation is still a manual action in the
 * Integrations UI; the panel warns when the CA is close to expiring.
 */
const CA_VALIDITY_DAYS = 180;

/**
 * Build the DER for an X.509 NameConstraints extension permitting only
 * the dNSNames above.
 *
 * Hand-rolled because node-forge has no builder for this extension —
 * it does pass through a raw `{ id, critical, value }` triple, where
 * `value` is the DER of the extension body.
 *
 *   NameConstraints ::= SEQUENCE { permittedSubtrees [0] GeneralSubtrees }
 *   GeneralSubtrees ::= SEQUENCE OF GeneralSubtree
 *   GeneralSubtree  ::= SEQUENCE { base GeneralName }
 *   GeneralName     ::= ... dNSName [2] IA5String
 */
function nameConstraintsExtension(): {
  id: string;
  critical: boolean;
  value: string;
} {
  const { asn1 } = forge;
  const subtrees = PERMITTED_DOMAINS.map((domain) =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      // [2] dNSName, context-specific + primitive
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, domain),
    ])
  );
  const permitted = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, subtrees);
  const body = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    permitted,
  ]);
  return {
    // 2.5.29.30 — id-ce-nameConstraints. RFC 5280 requires it to be
    // marked critical.
    id: "2.5.29.30",
    critical: true,
    value: asn1.toDer(body).getBytes(),
  };
}

/**
 * Generate a fresh self-signed CA (RSA-2048) and persist it. The cert is
 * marked as a CA via Basic Constraints + Key Usage so JVM/openssl chains
 * accept it as a signer, and constrained by Name Constraints to the CDN
 * domains squid is allowed to intercept.
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
  // Backdate slightly: a container whose clock lags the panel's would
  // otherwise reject a freshly minted CA as not-yet-valid.
  cert.validity.notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  // Arithmetic on epoch ms, not on the local-time Date constructor —
  // the previous `new Date(y+10, m, d)` form was interpreted in the
  // server's local timezone while X.509 validity is UTC.
  cert.validity.notAfter = new Date(
    now.getTime() + CA_VALIDITY_DAYS * 24 * 60 * 60 * 1000
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
    nameConstraintsExtension(),
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
