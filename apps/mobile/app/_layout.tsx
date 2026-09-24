import '../polyfill';
import { useEffect, useState } from 'react';
import { View, LogBox } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import { PlatformProvider, ThemeProvider, useTheme } from '@kanon/ui';
import { colors } from '@kanon/tokens';
import { ExpoNavProvider } from '../src/nav';
import { devicePlatform } from '../src/platform';
import { CHAIN, ConvexDataProviders } from '../src/providers';
import '../global.css';

LogBox.ignoreLogs([
  'Attempted to import the module',
  'ReactNativeFeatureFlags',
  'ImageBackground is deprecated',
]);

import { PrivyProvider } from '@privy-io/expo';

/** Status bar icons follow the chosen theme: light icons on dark, dark on light. */
function ThemedStatusBar() {
  const { scheme } = useTheme();
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
}

/**
 * Nothing renders until the mono face is loaded.
 *
 * Every figure in this product is monospaced and tabular; a first paint in the
 * system font would reflow every price on screen a frame later, which is the
 * one thing an instrument reading must never do.
 */
export default function RootLayout() {
  const [loaded, error] = useFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (loaded || error) setReady(true);
  }, [loaded, error]);

  return (
    <SafeAreaProvider>
      <PrivyProvider
        appId={process.env.EXPO_PUBLIC_PRIVY_APP_ID!}
        clientId={process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID!}
        // The configured chain (Monad mainnet 143, or testnet 10143 for the beta).
        // Embedded wallets default to the first supported chain, so the pin
        // transaction is sent where the StrategyRegistry lives.
        supportedChains={[CHAIN]}
      >
        <PlatformProvider capabilities={devicePlatform}>
          <ThemeProvider>
            <ThemedStatusBar />
            <ConvexDataProviders>
              <ExpoNavProvider>
                {ready ? <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }} /> : <View style={{ flex: 1, backgroundColor: colors.void }} />}
              </ExpoNavProvider>
            </ConvexDataProviders>
          </ThemeProvider>
        </PlatformProvider>
      </PrivyProvider>
    </SafeAreaProvider>
  );
}
