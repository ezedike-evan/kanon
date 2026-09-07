import { Text, View } from 'react-native';
import { Body, Screen, StatusBar } from '../components/chrome';
import { Meta, Num } from '../components/ui';
import { Link } from '../nav';
import { device } from '@kanon/tokens';
import { SCREEN_INDEX } from '../lib/routes';

/**
 * The canvas, on a device.
 *
 * `docs/DESIGN.md` asks for a consistency check across screens; in a browser
 * that is thirteen artboards side by side, which a phone cannot show. Here it
 * is a jump list instead — the same purpose, which is reaching any screen in
 * the demo without walking the whole flow.
 */
export function ScreenIndexScreen() {
  return (
    <Screen rail="bg-hairline" label="11 · SCREEN INDEX">
      <StatusBar />
      <View className="shrink-0 gap-2 px-5 pt-5.5">
        <Text className="font-mono-bold text-12 tracking-w22 text-bone">KANON</Text>
        <Meta className="tracking-w16">
          {SCREEN_INDEX.length} SCREENS · {device.width} × {device.height}
        </Meta>
      </View>

      <Body>
        <View className="mt-5 pb-8">
          {SCREEN_INDEX.map((screen) => (
            <Link
              key={screen.label}
              href={screen.href}
              className="flex-row items-center justify-between gap-3 border-t border-hairline py-3.75"
            >
              <Text className="font-mono text-11 tracking-w16 text-bone">
                {screen.label}
              </Text>
              <Num className="text-11 text-ash">→</Num>
            </Link>
          ))}
        </View>
      </Body>
    </Screen>
  );
}
