import { useRef } from 'react';
import { Animated, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../icons';
import { Link } from '../../nav';
import { cx } from '../../lib/cx';
import { withAlpha } from '../../lib/elevation';
import { isWeb, useHaptics } from '../../platform';
import { useTheme } from '../../theme';
import { useRegisterActiveTab } from './context';
import { TABS, type TabDef, type TabKey } from './tabs';

/**
 * A regular tab: icon over label, a short signal bar on the top edge when it is
 * the current one. The bar, the bone icon and the bone label all change
 * together, so the state does not rest on colour alone.
 */
function Tab({ tab, on }: { tab: TabDef; on: boolean }) {
  const { select } = useHaptics();
  return (
    <Link
      href={tab.href}
      role="tab"
      aria-selected={on}
      aria-label={tab.label}
      onPressIn={on ? undefined : select}
      className="relative flex-1 items-center gap-1 pb-1 pt-2.5 active:opacity-70"
    >
      <View
        className={cx('absolute top-0 h-0.5 w-6 bg-signal', on ? 'opacity-100' : 'opacity-0')}
      />
      <Icon name={tab.icon} size={22} color={on ? 'bone' : 'ash'} strokeWidth={on ? 2 : 1.75} />
      <Text
        className={cx(
          'font-mono-medium text-10 tracking-w08',
          on ? 'text-bone' : 'text-ash',
        )}
      >
        {tab.label}
      </Text>
    </Link>
  );
}

/**
 * The centre tab: the AI strategy builder. A raised `signal` button carrying the
 * sparkles glyph and, like every tab, a label under it that says what it is.
 * There is one spring on press and nothing that animates on its own.
 */
function AiTab({ tab, on }: { tab: TabDef; on: boolean }) {
  const { colors } = useTheme();
  const { tap } = useHaptics();
  const scale = useRef(new Animated.Value(1)).current;
  const spring = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: to === 1 ? 6 : 0 }).start();

  return (
    <Link
      href={tab.href}
      role="tab"
      aria-selected={on}
      aria-label="AI strategy builder"
      onPressIn={() => {
        tap();
        spring(0.93);
      }}
      onPressOut={() => spring(1)}
      className="flex-[1.15] items-center gap-1 pb-1"
    >
      {/* className does not reach Animated.View, so the spring wraps a plain View. */}
      <View className="-mt-4.5">
        <Animated.View style={{ transform: [{ scale }] }}>
          <View
            className="size-11 items-center justify-center rounded-md bg-signal"
            style={{
              // Static lift: a signal-tinted shadow and a 1px top highlight, and a
              // bone ring when this is the current tab.
              boxShadow: on
                ? `0px 0px 0px 2px ${colors.bone}, 0px 6px 14px ${withAlpha(colors.signal, 0.35)}`
                : `0px 6px 14px ${withAlpha(colors.signal, 0.35)}, inset 0px 1px 0px ${withAlpha(colors.bone, 0.28)}`,
            }}
          >
            <Icon name="sparkles" size={22} color="void" strokeWidth={2} />
          </View>
        </Animated.View>
      </View>
      <Text className={cx('font-mono-bold text-10 tracking-w08', on ? 'text-bone' : 'text-signal')}>
        {tab.label}
      </Text>
    </Link>
  );
}

/**
 * The bottom bar: phones and tablets. From `lg` the side rail replaces it and
 * this hides itself with a class, so the server markup is right at any width.
 *
 * `active` is also handed to the enclosing `Screen`, which is how the rail knows
 * which item to light; a screen names its tab once, here, and never twice.
 */
export function TabBar({ active }: { active: TabKey }) {
  const insets = useSafeAreaInsets();
  useRegisterActiveTab(active);
  return (
    <View
      className={cx(
        'shrink-0 flex-row border-t border-hairline bg-panel px-1 pb-4',
        isWeb && 'lg:hidden',
      )}
      style={isWeb ? undefined : { paddingBottom: Math.max(insets.bottom, 8) + 6 }}
      role="tablist"
    >
      {TABS.map((tab) =>
        tab.key === 'create' ? (
          <AiTab key={tab.key} tab={tab} on={tab.key === active} />
        ) : (
          <Tab key={tab.key} tab={tab} on={tab.key === active} />
        ),
      )}
    </View>
  );
}
