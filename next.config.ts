import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['192.168.31.94'],
  // The proxy buffers request bodies and silently truncates above 10MB; the import route's own limit is 15MB.
  experimental: { proxyClientMaxBodySize: '20mb' },
};

export default nextConfig;
