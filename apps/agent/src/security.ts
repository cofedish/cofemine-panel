import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Constant-time comparison for the agent bearer token.
 *
 * `crypto.timingSafeEqual` throws when the buffers differ in length, and
 * comparing lengths first leaks the token's length, so both sides are
 * hashed to a fixed 32 bytes and the digests are compared.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Reject URLs the agent must never fetch on a caller's behalf.
 *
 * The agent sits on `cofemine_internal` (the API and Postgres) *and*
 * `cofemine_mcnet` (every Minecraft container), and it holds the Docker
 * socket. An unrestricted "download this URL" primitive therefore reads
 * as: fetch anything on the operator's private networks, or the cloud
 * metadata service, and write the response to disk. This narrows it to
 * plain HTTPS against public addresses.
 *
 * Checks, in order:
 *   1. scheme must be https (no file:, no gopher:, no plain http where
 *      an on-path attacker chooses the bytes we then execute)
 *   2. no credentials in the URL
 *   3. the hostname must resolve exclusively to public addresses
 *
 * Step 3 resolves DNS itself rather than trusting the string, which
 * also covers hostnames that deliberately resolve to 127.0.0.1 or
 * 169.254.169.254. It is not a perfect DNS-rebinding defence — the
 * address could change between this lookup and the connection — but it
 * removes the trivial cases without a custom dispatcher.
 */
export async function assertSafeDownloadUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw badRequest(`Only https:// downloads are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw badRequest("Credentials in download URLs are not allowed");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(url.hostname, { all: true });
  } catch {
    throw badRequest(`Cannot resolve download host: ${url.hostname}`);
  }
  if (addresses.length === 0) {
    throw badRequest(`Cannot resolve download host: ${url.hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw badRequest(
        `Refusing to download from a private/link-local address (${url.hostname} → ${address})`
      );
    }
  }
  return url;
}

/** RFC1918 / loopback / link-local / CGNAT / unique-local / metadata. */
export function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) return isPrivateIpv6(address);
  return isPrivateIpv4(address);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p))) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:169.254.169.254) — judge the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  return false;
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}
