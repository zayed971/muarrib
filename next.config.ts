import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@anthropic-ai/sdk', '@google/generative-ai'],
};

export default nextConfig;
