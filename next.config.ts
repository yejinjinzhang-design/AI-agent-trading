import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [],
  output: "standalone",
  async redirects() {
    return [
      // /sessions → /strategies
      { source: "/sessions", destination: "/strategies", permanent: false },
      // /evolve → /evolution (preserve query params)
      { source: "/evolve", destination: "/evolution", permanent: false },
      // /strategy?id=xxx → /builder?id=xxx
      { source: "/strategy", destination: "/builder", permanent: false },
    ];
  },
};

export default nextConfig;
