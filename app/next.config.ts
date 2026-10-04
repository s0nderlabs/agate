import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // local render checks open the app at 127.0.0.1; without this Next blocks its dev scripts there
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
