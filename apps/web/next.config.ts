import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages ship TypeScript source, not a build step.
  transpilePackages: ['@kanon/spec', '@kanon/tokens'],
  typedRoutes: true,
};

export default config;
