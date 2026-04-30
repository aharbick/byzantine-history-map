const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: path.resolve(__dirname),
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "upload.wikimedia.org" },
      { protocol: "https", hostname: "commons.wikimedia.org" },
      { protocol: "https", hostname: "en.wikipedia.org" },
    ],
  },
  env: {
    AUDIO_BASE_URL: process.env.AUDIO_BASE_URL || "/audio",
  },
};

module.exports = nextConfig;
