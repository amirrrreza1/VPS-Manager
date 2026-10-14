/** @type {import('next').NextConfig} */
const nextConfig = {
  // Proxy buffers request bodies; its 10 MB default would truncate uploads.
  experimental: {
    // Keep builds practical on small VPSs and busy development machines.
    cpus: 2,
    proxyClientMaxBodySize: Math.max(
      Math.min(Number(process.env.VPM_MAX_UPLOAD_BYTES) || 25 * 1024 * 1024, 25 * 1024 * 1024),
      (Number(process.env.VPM_MAX_EDIT_BYTES) || 2 * 1024 * 1024) * 6,
    ) + 65536,
  },
  // This app manages a filesystem tree that only exists at runtime, so
  // Turbopack's static tracing of server routes is not meaningful here.
  outputFileTracingIncludes: {},
  outputFileTracingExcludes: {
    // Never ship the local dev sandbox or the SQLite data dir into the build.
    "/*": ["./.vpm-data/**", "./.dev-root/**", "./test/**"],
  },
  serverExternalPackages: ["node:sqlite"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
