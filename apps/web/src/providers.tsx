'use client';

import type { ReactNode } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PlatformProvider, type PlatformCapabilities } from '@kanon/ui';
import { NextNavProvider } from './nav';

/**
 * A browser has no device passkey, and the pinning ceremony is told so rather
 * than being allowed to imply it took a signature it could not take.
 */
const browserPlatform: PlatformCapabilities = {
  hasBiometrics: false,
  authenticate: async () => false,
};

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL || 'https://placeholder.convex.cloud');

export function Providers({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID || ''}
      config={{
        loginMethods: ['email', 'wallet', 'google', 'twitter'],
        appearance: {
          theme: 'dark',
          accentColor: '#D4A017',
          showWalletLoginFirst: false,
        },
      }}
    >
      <ConvexProvider client={convex}>
        <SafeAreaProvider>
          <PlatformProvider capabilities={browserPlatform}>
            <NextNavProvider>{children}</NextNavProvider>
          </PlatformProvider>
        </SafeAreaProvider>
      </ConvexProvider>
    </PrivyProvider>
  );
}
