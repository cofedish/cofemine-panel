/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@cofemine/shared"],
  async rewrites() {
    const apiUrl = process.env.API_INTERNAL_URL ?? "http://api:4000";
    return [
      { source: "/api/:path*", destination: `${apiUrl}/:path*` },
    ];
  },
};
export default nextConfig;
