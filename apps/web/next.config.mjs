/**
 * Content-Security-Policy for the panel itself.
 *
 * Why it exists: the panel renders mod descriptions fetched from
 * Modrinth / CurseForge, which are unmoderated and attacker-controlled.
 * That markup is sanitised with DOMPurify before it reaches the DOM
 * (see components/content-detail-drawer.tsx), and this is the second
 * layer — the app shipped with no CSP at all, so a sanitiser bug was a
 * single point of failure.
 *
 * On `script-src 'unsafe-inline'`: the App Router inlines its RSC
 * payload as `<script>` tags, so a strict policy needs per-request
 * nonces, which in Next means adding middleware. This project has none
 * by design. So script-src is not the layer doing the work here —
 * these are:
 *
 *   base-uri 'none'    kills injected <base href=evil> (which the old
 *                      regex sanitiser could not express at all)
 *   form-action 'self' kills injected <form action=evil> credential
 *                      and CSRF-token exfiltration
 *   connect-src 'self' stops fetch/XHR/WebSocket exfiltration to a
 *                      third-party collector
 *   object-src 'none'  no Flash/plugin gadgets
 *
 * `img-src` has to allow https: — mod descriptions and galleries embed
 * images from arbitrary CDNs. That leaves an image-URL side channel for
 * data exfiltration; closing it would mean proxying every remote image.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@cofemine/shared"],
  // Deliberately scoped to everything EXCEPT /api/*. Those paths are
  // rewrites onto the API and the map-proxy, and both send their own
  // CSP. Two policies on one response are enforced as an intersection,
  // which would strip the 'unsafe-eval' BlueMap's renderer needs.
  async headers() {
    return [
      {
        source: "/((?!api/).*)",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
  async rewrites() {
    const apiUrl = process.env.API_INTERNAL_URL ?? "http://api:4000";
    const mapProxyUrl =
      process.env.MAP_PROXY_INTERNAL_URL ?? "http://map-proxy:4500";
    // Order matters: the map-proxy rewrite is more specific and must
    // come first so /api/servers/:id/map/* is routed to the dedicated
    // process, not into the general /api/:path* catch-all that points
    // at the panel API. The map-proxy serves an identical /servers/
    // :id/map/* surface, so the only difference is which Node pid /
    // event loop / pool serves the request.
    return [
      {
        source: "/api/servers/:id/map/:path*",
        destination: `${mapProxyUrl}/servers/:id/map/:path*`,
      },
      {
        source: "/api/servers/:id/map",
        destination: `${mapProxyUrl}/servers/:id/map`,
      },
      { source: "/api/:path*", destination: `${apiUrl}/:path*` },
    ];
  },
};
export default nextConfig;
