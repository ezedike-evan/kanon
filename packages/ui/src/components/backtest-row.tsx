import { memo } from 'react';
import { Text, View } from 'react-native';
import { cx } from '../lib/cx';
import { Link } from '../nav';
import { useHaptics } from '../platform';
import { FiguredText } from './figured-text';
import { Icon } from './icons';
import { FOCUS } from './reel/trade-parts';

/**
 * The way to test a rule on recorded prices, as a row on a rule's card. Drawn
 * like the autopilot row above it: a glyph tile, the word, one line of what it
 * does. It opens the test screen and runs nothing by itself: the run is the
 * action at the foot of that screen.
 */
export const BacktestRow = memo(function BacktestRow({
  href,
  pair,
  className,
}: {
  href: string;
  /** `BTC/USD 15M`, when the rule's spec can be read. */
  pair?: string | null | undefined;
  className?: string | undefined;
}) {
  const { tap } = useHaptics();
  const line = pair
    ? `How its stop and target did on recorded ${pair} candles.`
    : 'How its stop and target did on recorded candles.';
  return (
    <Link
      href={href}
      aria-label={`Test on recorded prices. ${line}`}
      onPressIn={tap}
      className={cx('min-h-14 flex-row items-center gap-3 px-4 py-3 hover:bg-raised active:bg-raised', FOCUS, className)}
    >
      <View className="size-8 items-center justify-center rounded-sm border border-hairline bg-raised">
        <Icon name="history" size={16} color="ash" />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="font-mono-medium text-12 uppercase tracking-w10 text-bone">Test on recorded prices</Text>
        <FiguredText text={line} className="font-sans text-12 leading-[17px] text-ash" />
      </View>
      <Icon name="chevron-right" size={16} color="ash" />
    </Link>
  );
});
