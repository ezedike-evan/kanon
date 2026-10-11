import { Linking, Pressable, Text, View } from 'react-native';
import { cx } from '../../lib/cx';
import { web } from '../../lib/desktop';
import { DIRECTION_WORD, moveLine, type PriceMove, type TimedOutcomeView } from '../../lib/timed-trade';
import type { TimedDirection } from '../../lib/timed-types';
import { NOT_REPORTED_YET, type TxRef } from '../../lib/venue-trade';
import { useHaptics } from '../../platform';
import { Badge } from '../badge';
import { Icon } from '../icons';
import { Label } from '../stat';
import { Num } from '../ui';

/*
 * The small pieces a timed trade is drawn from, on a slide of the reel and in
 * the sheets beside it. Each is a fixed shape that says one thing, so a slide,
 * a row and a sheet stay consistent with each other and with the order ticket
 * on the chart.
 *
 * Two rules hold in every one of them. Direction colour never stands alone:
 * an arrow and a word, or an arrow and a figure, are always beside it. And an
 * answer from the server is set the same neutral way whatever it says.
 */

/** Keyboard focus, drawn as the side nav and the panel toggles draw it. Web only: a device has no focus ring. */
export const FOCUS = web(
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal',
);

/** A direction's arrow. Its word, or a figure, is always beside it. */
export function DirectionGlyph({
  direction,
  size = 14,
  onFill,
}: {
  direction: TimedDirection;
  size?: number;
  /** Drawn on a block of the direction's own colour. */
  onFill?: boolean;
}) {
  return (
    <Icon
      name={direction === 'up' ? 'arrow-up' : 'arrow-down'}
      size={size}
      color={onFill ? 'void' : direction === 'up' ? 'long' : 'short'}
      strokeWidth={2}
    />
  );
}

/** What was called: the arrow and `UP` or `DOWN`, in the direction's colour. */
export function DirectionMark({ direction, large }: { direction: TimedDirection; large?: boolean }) {
  return (
    <View className="shrink-0 flex-row items-center gap-1">
      <DirectionGlyph direction={direction} size={large ? 16 : 12} />
      <Text
        className={cx(
          'font-mono-bold tracking-w14',
          large ? 'text-13' : 'text-11',
          direction === 'up' ? 'text-long' : 'text-short',
        )}
      >
        {DIRECTION_WORD[direction]}
      </Text>
    </View>
  );
}

/**
 * How far a price has moved: an arrow, the distance in price and the percent of
 * the price it moved from. Never money. A price that has not moved is neutral.
 */
export function MoveMark({ move, large }: { move: PriceMove; large?: boolean }) {
  const size = large ? 'text-15' : 'text-12';
  if (move.direction === 'flat') {
    return <Num className={cx(size, 'text-ash')}>No change</Num>;
  }
  const up = move.direction === 'up';
  return (
    <View aria-label={moveLine(move)} className="flex-row items-center gap-1">
      <Icon name={up ? 'arrow-up' : 'arrow-down'} size={large ? 14 : 12} color={up ? 'long' : 'short'} strokeWidth={2} />
      <Num className={cx(size, up ? 'text-long' : 'text-short')}>{`${move.diff} · ${move.percent}`}</Num>
    </View>
  );
}

/** Label then figure, one per row. Dense for the desktop panel; a ruled table elsewhere. */
export function Facts({ rows, dense }: { rows: ReadonlyArray<readonly [string, string]>; dense?: boolean }) {
  if (dense) {
    return (
      <View className="gap-1.5">
        {rows.map(([name, value]) => (
          <View key={name} className="flex-row items-baseline justify-between gap-3">
            <Label>{name}</Label>
            <Num className="shrink text-right text-11">{value}</Num>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View className="rounded-sm border border-hairline bg-panel">
      {rows.map(([name, value], i) => (
        <View
          key={name}
          className={cx(
            'min-h-9 flex-row items-center justify-between gap-3 px-3.5 py-2',
            i < rows.length - 1 && 'border-b border-hairline',
          )}
        >
          <Text className="font-mono text-12 text-ash">{name}</Text>
          <Num className="shrink text-right text-12">{value}</Num>
        </View>
      ))}
    </View>
  );
}

/** The evidence for a trade, one press away: a transaction on the block explorer. */
export function TxLink({ tx, name }: { tx: TxRef; /** `Open`, `Close`: which transaction of the trade this is. */ name: string }) {
  return (
    <Pressable
      role="link"
      aria-label={`${name} transaction ${tx.short} on ${tx.explorer}`}
      hitSlop={6}
      // A device with nothing to open a link with rejects; that is not this screen's to report.
      onPress={() => void Linking.openURL(tx.url).catch(() => undefined)}
      className={cx('min-h-11 flex-row items-center justify-between gap-3 px-3.5 hover:bg-raised/60 active:bg-raised', FOCUS)}
    >
      <Text className="font-mono text-12 text-ash">{`${name} transaction`}</Text>
      <View className="flex-row items-center gap-1.5">
        <Num className="text-12 text-verified">{tx.short}</Num>
        <Icon name="arrow-up-right" size={14} color="verified" />
      </View>
    </Pressable>
  );
}

/** A transaction the venue has not reported yet: said, not left blank. */
export function TxMissing({ name }: { name: string }) {
  return (
    <View className="min-h-11 flex-row items-center justify-between gap-3 px-3.5">
      <Text className="font-mono text-12 text-ash">{`${name} transaction`}</Text>
      <Num className="text-12 text-ash">{NOT_REPORTED_YET}</Num>
    </View>
  );
}

/** The same evidence as one short line, for a card with no room for a row: `OPEN TX 0x12ab…cd56`. */
export function TxInline({ tx, name }: { tx: TxRef; name: string }) {
  return (
    <Pressable
      role="link"
      aria-label={`${name} transaction ${tx.short} on ${tx.explorer}`}
      hitSlop={10}
      onPress={() => void Linking.openURL(tx.url).catch(() => undefined)}
      className={cx('flex-row items-center gap-1.5 self-start rounded-xs py-0.5 active:opacity-70', FOCUS)}
    >
      <Text className="font-mono text-11 uppercase tracking-w04 text-verified">{`${name} tx`}</Text>
      <Num className="text-11 text-verified">{tx.short}</Num>
      <Icon name="arrow-up-right" size={12} color="verified" />
    </Pressable>
  );
}

/**
 * An answer that was not a trade, in place: what was asked for and the server's
 * own sentence. A refusal is the limits doing their job, so it takes no alarm
 * colour and no warning glyph, and is set exactly as any other answer is.
 */
export function OutcomeBlock({ outcome, onDismiss }: { outcome: TimedOutcomeView; onDismiss: () => void }) {
  return (
    <View role="status" accessibilityLiveRegion="polite" className="gap-1.5 rounded-sm border border-hairline bg-panel px-3 py-2.5">
      <View className="flex-row items-center justify-between gap-2">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <Badge label={outcome.label} className="self-center" />
          <Num className="shrink text-10 text-ash">{outcome.context}</Num>
        </View>
        <Pressable
          role="button"
          aria-label="Dismiss this answer"
          hitSlop={12}
          onPress={onDismiss}
          className={cx('size-5 items-center justify-center rounded-xs hover:bg-raised active:bg-raised', FOCUS)}
        >
          <Icon name="x" size={12} color="ash" />
        </Pressable>
      </View>
      <Num className="text-12 leading-[18px]">{outcome.text}</Num>
    </View>
  );
}

/**
 * One choice out of a few, as a row of chips. No keyboard: every value on offer
 * is one the server takes. The chosen chip inverts to bone, which reads in both
 * themes and borrows no direction colour.
 */
export function ChoiceChips({
  label,
  options,
  value,
  format,
  describe,
  onChoose,
  disabled,
  dense,
}: {
  /** The group's name for a screen reader: `Stake`. */
  label: string;
  options: readonly number[];
  value: number | null;
  format: (option: number) => string;
  /** What one chip says to a screen reader: `Stake 25 dollars`. */
  describe: (option: number) => string;
  onChoose: (option: number) => void;
  disabled: boolean;
  /** 32px for the desktop panel; 44px for a thumb. */
  dense?: boolean;
}) {
  const { select } = useHaptics();
  return (
    <View role="radiogroup" aria-label={label} className="flex-row flex-wrap gap-1.5">
      {options.map((option) => {
        const on = option === value;
        return (
          <Pressable
            key={option}
            role="radio"
            aria-checked={on}
            aria-label={describe(option)}
            disabled={disabled}
            onPress={() => {
              if (on) return;
              select();
              onChoose(option);
            }}
            className={cx(
              'flex-1 items-center justify-center rounded-xs border px-1',
              dense ? 'h-8 min-w-10' : 'h-11 min-w-14',
              on ? 'border-bone bg-bone' : 'border-hairline bg-panel hover:bg-raised active:bg-raised',
              disabled && 'opacity-40',
              FOCUS,
            )}
          >
            <Num className={cx('font-mono-medium text-13', on ? 'text-void' : 'text-bone')}>{format(option)}</Num>
          </Pressable>
        );
      })}
    </View>
  );
}
