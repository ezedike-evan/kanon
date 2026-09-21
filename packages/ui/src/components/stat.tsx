import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { cx } from '../lib/cx';
import { Icon } from './icons';
import { Num } from './ui';
import { Card } from './card';
import { DIRECTION_TONE, TONE_COLOR, TONE_TEXT, type Direction, type Tone } from './tone';

/** The 11px ash uppercase label every figure sits under (or beside). */
export function Label({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <Text className={cx('font-mono text-11 uppercase tracking-w10 text-ash', className)}>
      {children}
    </Text>
  );
}

export interface DeltaProps {
  /** Already formatted, unsigned: `1.42%`. The glyph carries the sign. */
  value: string;
  direction: Direction;
  className?: string | undefined;
}

/**
 * A change, always with a glyph. Green and red never appear alone
 * (docs/DESIGN.md), so the arrow is not optional; flat is neutral, not green.
 */
export function Delta({ value, direction, className }: DeltaProps) {
  const tone = DIRECTION_TONE[direction];
  return (
    <View className={cx('flex-row items-center gap-0.5', className)}>
      {direction === 'flat' ? null : (
        <Icon
          name={direction === 'up' ? 'arrow-up' : 'arrow-down'}
          size={12}
          color={TONE_COLOR[tone]}
          strokeWidth={2}
        />
      )}
      <Num className={cx('text-12', TONE_TEXT[tone])}>{value}</Num>
    </View>
  );
}

export interface StatTileProps {
  label: string;
  /** The figure. Monospaced and tabular; pass a string or a `<Num>`. */
  value: ReactNode;
  /** Unit or qualifier next to the figure: `USDC`, `/ 30D`. */
  unit?: string | undefined;
  delta?: { value: string; direction: Direction } | undefined;
  /** A line under the figure, ash. */
  sub?: string | undefined;
  /** Colours the figure. Use `long`/`short` only for a direction, `signal` for a rule. */
  tone?: Tone | undefined;
  /** Rendered bare, for use inside a StatRow that supplies the card. */
  bare?: boolean | undefined;
  className?: string | undefined;
}

/**
 * A label over a figure, optionally with a delta and a sub-line.
 *
 *   <StatTile label="Adherence" value="94.2%" delta={{ value: '1.4%', direction: 'up' }} />
 */
export function StatTile({
  label,
  value,
  unit,
  delta,
  sub,
  tone = 'neutral',
  bare,
  className,
}: StatTileProps) {
  const body = (
    <View className="gap-1.5">
      <Label>{label}</Label>
      <View className="flex-row items-baseline gap-1.5">
        {typeof value === 'string' || typeof value === 'number' ? (
          <Num className={cx('text-20 tracking-t20', TONE_TEXT[tone])}>{value}</Num>
        ) : (
          value
        )}
        {unit ? <Num className="text-11 text-ash">{unit}</Num> : null}
      </View>
      {delta || sub ? (
        <View className="flex-row items-center gap-2">
          {delta ? <Delta value={delta.value} direction={delta.direction} /> : null}
          {sub ? <Num className="text-11 text-ash">{sub}</Num> : null}
        </View>
      ) : null}
    </View>
  );
  if (bare) return <View className={cx('flex-1 p-3.5', className)}>{body}</View>;
  return (
    <Card pad="md" className={cx('flex-1', className)}>
      {body}
    </Card>
  );
}

/**
 * Two to four tiles in one card, divided by hairlines. Denser than separate
 * cards and it reads as one instrument panel.
 */
export function StatRow({ stats, className }: { stats: StatTileProps[]; className?: string | undefined }) {
  return (
    <Card pad="none" className={cx('flex-row', className)}>
      {stats.map((stat, i) => (
        <View key={stat.label} className={cx('flex-1', i > 0 && 'border-l border-hairline')}>
          <StatTile {...stat} bare />
        </View>
      ))}
    </Card>
  );
}
