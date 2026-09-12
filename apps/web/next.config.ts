import type { NextConfig } from 'next';

/**
 * The web app renders the same React Native screens the phone does, through
 * react-native-web. Everything below is what that costs: the RN packages ship
 * untranspiled source, and `react-native` has to resolve to its web build.
 */
const config: NextConfig = {
  transpilePackages: [
    '@kanon/spec',
    '@kanon/tokens',
    '@kanon/ui',
    'react-native',
    'react-native-web',
    'react-native-safe-area-context',
    'nativewind',
    'react-native-css-interop',
  ],
  typedRoutes: true,
  webpack: (webpackConfig) => {
    webpackConfig.resolve.alias = {
      ...webpackConfig.resolve.alias,
      'react-native$': 'react-native-web',
      '@farcaster/mini-app-solana': false,
    };
    // `.web.tsx` wins over `.tsx`, the convention every RN library ships against.
    webpackConfig.resolve.extensions = [
      '.web.tsx',
      '.web.ts',
      '.web.jsx',
      '.web.js',
      ...webpackConfig.resolve.extensions,
    ];
    return webpackConfig;
  },
};

export default config;
