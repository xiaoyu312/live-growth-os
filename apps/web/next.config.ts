import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function extraDevOrigins(): string[] {
  const origins = ["127.0.0.1", "localhost"];
  const share = process.env.LAN_VIEW_SHARE_ORIGIN?.trim();
  if (share) {
    try {
      const host = new URL(share).hostname;
      if (host && !origins.includes(host)) origins.push(host);
    } catch {
      /* 忽略非法分享地址，默认仍放行本机 */
    }
  }
  return origins;
}

const nextConfig: NextConfig = {
  ...(process.env.NEXT_PUBLIC_CAPTURE_ONLY === "1" ? { images: { unoptimized: true } } : {}),
  transpilePackages: ["@live-growth/contracts"],
  allowedDevOrigins: extraDevOrigins(),
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone", outputFileTracingRoot: repoRoot } : {}),
  async headers() {
    return [{
      source: "/live/:path*",
      headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self' chrome-extension:" }]
    }];
  }
};

export default nextConfig;
