/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@cofemine/shared"],
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
