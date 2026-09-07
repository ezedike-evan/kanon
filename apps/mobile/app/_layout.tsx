import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import { PlatformProvider } from '@kanon/ui';
import { colors } from '@kanon/tokens';
import { ExpoNavProvider } from '../src/nav';
import { devicePlatform } from '../src/platform';
import '../global.css';

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
      <StatusBar style="light" backgroundColor={colors.void} />
      <PlatformProvider capabilities={devicePlatform}>
        <ExpoNavProvider>
          {ready ? <Slot /> : <View style={{ flex: 1, backgroundColor: colors.void }} />}
        </ExpoNavProvider>
      </PlatformProvider>
    </SafeAreaProvider>
  );
}
