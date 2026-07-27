/**
 * Guard for URLs that come from Modrinth / CurseForge metadata.
 *
 * Publishing on either registry is unmoderated, so `pageUrl`, project
 * links and similar fields are attacker-controlled strings that we then
 * put in an `href`. React does *not* block `javascript:` URLs — it only
 * logs a warning — so an unchecked href is script execution on the
 * panel's origin with the operator's session.
 *
 * Returns the URL when it is a plain web link, otherwise `undefined` so
 * the caller can drop the link entirely.
 */
export function safeExternalUrl(
  url: string | undefined | null
): string | undefined {
  if (!url) return undefined;
  try {
    // The base only matters for relative inputs; those resolve to the
    // sentinel host and are rejected below as neither http nor https on
    // a real origin — which is what we want, since these fields are
    // supposed to be absolute links.
    const parsed = new URL(url, "https://invalid.example");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}
