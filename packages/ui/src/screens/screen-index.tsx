import { Text, View } from 'react-native';
import { Body, Screen, StatusBar } from '../components/chrome';
import { Meta, Num } from '../components/ui';
import { Link } from '../nav';
import { SCREEN_INDEX } from '../lib/routes';

/**
 * The canvas, as a list.
 *
 * `docs/DESIGN.md` asks for a consistency check across screens. There is no
 * artboard to lay them side by side on any more (every screen now fills its
 * viewport), so this is a jump list: the same purpose, which is reaching any
 * screen in the demo without walking the whole flow. Mounted at `/screens` on
 * the web and on a device.
 */
export function ScreenIndexScreen() {
  return (
    <Screen rail="bg-hairline">
      <StatusBar />
      <View className="shrink-0 gap-2 px-5 pt-5.5">
        <Text className="font-mono-bold text-12 tracking-w22 text-bone">KANON</Text>
        <Meta className="tracking-w16">
          {SCREEN_INDEX.length} SCREENS
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
