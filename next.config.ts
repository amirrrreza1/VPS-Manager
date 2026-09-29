import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
