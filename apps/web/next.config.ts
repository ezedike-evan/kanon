import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Wallet app: lock down framing, sniffing and referrers, and restrict what can load.
 * Privy (embedded wallet) renders in iframes and WalletConnect talks over wss, so
 * `connect-src` stays on https/wss rather than a host list that would rot. Inline scripts
 * are required by the Next App Router without a nonce middleware.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  // A gateway run locally (packages/gateway) is plain http and ws on another port, which
  // neither 'self' nor the https and wss schemes cover. Development only.
  `connect-src 'self' https: wss:${isDev ? ' http://localhost:* ws://localhost:*' : ''}`,
  'frame-src https://auth.privy.io https://*.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com',
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

/**
 * The web app renders the same React Native screens the phone does, through
 * react-native-web. Everything below is what that costs: the RN packages ship
 * untranspiled source, and `react-native` has to resolve to its web build.
 */
const config: NextConfig = {
  // `KANON_DIST_DIR=.next-perf next build` builds beside a running `next dev` without clobbering it.
  distDir: process.env.KANON_DIST_DIR || '.next',
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
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  experimental: {
    // `@kanon/ui` and `@kanon/spec` are barrels: one `import { X } from '@kanon/ui'` otherwise
    // pulls in every screen, the chart engine and the chain clients into every route. This
    // rewrites each such import to the module that defines X.
    optimizePackageImports: ['@kanon/ui', '@kanon/spec'],
  },
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
