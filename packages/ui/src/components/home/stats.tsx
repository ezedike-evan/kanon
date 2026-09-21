import { memo, type ReactNode } from 'react';
import { View } from 'react-native';
import { formatBps } from '@kanon/spec';
import type { BehaviourStats } from '../../lib/domain-types';
import { routes, tradeRoute } from '../../lib/routes';
import { Card } from '../card';
import { Icon, type Icon as IconName } from '../icons';
import { ProgressRing } from '../progress-ring';
import { Skeleton } from '../skeleton';
import { Label } from '../stat';
import { Num } from '../ui';
import { cx } from '../../lib/cx';
import { web } from '../../lib/desktop';
import type { ColorToken } from '@kanon/tokens';

interface TileProps {
  label: string;
  figure: string;
  sub: string;
  icon: IconName;
  iconColor?: ColorToken | undefined;
  href: string;
  a11y: string;
  /** Replaces the corner icon, e.g. the adherence ring. */
  corner?: ReactNode;
}

/**
 * One behaviour figure. Every tile is a door to its evidence: the whole card
 * opens the log or the trade the number came from.
 */
const Tile = memo(function Tile({ label, figure, sub, icon, iconColor = 'ash', href, a11y, corner }: TileProps) {
  return (
    <Card href={href} label={a11y} pad="none" className="flex-1 basis-0">
      <View className={cx('min-h-24 justify-between p-3.5', web('lg:min-h-28 lg:p-4'))}>
        <View className="flex-row items-start justify-between gap-2">
          <Label className="flex-1">{label}</Label>
          {corner ?? <Icon name={icon} size={16} color={iconColor} />}
        </View>
        <View className="mt-3 gap-1">
          <Num className="font-mono-medium text-24 tracking-t25">{figure}</Num>
          <Num className="text-11 text-ash">{sub}</Num>
        </View>
      </View>
    </Card>
  );
});

/**
 * From `xl` the four tiles sit in one row: the two phone rows become the two halves
 * of it. Below `xl` (and on a device) they are the 2x2 they always were; the main
 * column is under 500px wide between 1024 and 1279, too narrow for four labels.
 */
const ROW_OF_FOUR = web('xl:flex-row');
const ROW_CHILD = web('xl:min-w-0 xl:flex-1');

export interface StatsGridProps {
  stats: BehaviourStats;
  /** Rules pinned over the account's life, and how many are enforcing now. */
  rules: { pinned: number; active: number };
  /** The newest executed trade, so "taken" opens a trade rather than a list. */
  latestTakenId: string | undefined;
}


/**
 * The behaviour strip: rules, trades taken, refusals, adherence. No profit here:
 * Home leads with what the rule did, because leading with P&L drives the
 * behaviour this product exists to prevent. A refusal is counted as the rule
 * doing its job and worded that way.
 */
export const StatsGrid = memo(function StatsGrid({ stats, rules, latestTakenId }: StatsGridProps) {
  const untested = stats.attempts === 0;
  return (
    <View className={cx('gap-3', ROW_OF_FOUR)}>
      <View className={cx('flex-row gap-3', ROW_CHILD)}>
        <Tile
          label="Rules pinned"
          figure={String(rules.pinned)}
          sub={rules.active > 0 ? `${rules.active} enforcing` : 'none enforcing'}
          icon="scroll"
          href={rules.pinned > 0 ? routes.compileReview : routes.create}
          a11y={`${rules.pinned} rules pinned, ${rules.active} enforcing. Open the rule.`}
        />
        <Tile
          label="Trades taken"
          figure={String(stats.taken)}
          sub={untested ? 'no setups yet' : `of ${stats.attempts} setups`}
          icon="check-circle"
          href={latestTakenId ? tradeRoute(latestTakenId) : routes.blocked}
          a11y={`${stats.taken} trades taken. Open the latest trade and its evidence.`}
        />
      </View>
      <View className={cx('flex-row gap-3', ROW_CHILD)}>
        <Tile
          label="Refused"
          figure={String(stats.blocked)}
          sub={stats.blocked === 0 ? 'nothing to hold yet' : 'held by your rule'}
          icon="ban"
          iconColor="refused"
          href={routes.blocked}
          a11y={`${stats.blocked} entries refused by your rule. Open the refusal log.`}
        />
        <Tile
          label="Adherence"
          figure={untested ? '—' : formatBps(stats.adherenceBps, { dp: 1 })}
          sub={untested ? 'after the first setup' : 'met the rule'}
          icon="target"
          href={routes.analytics}
          a11y={
            untested
              ? 'Adherence has no setups to measure yet. Open analytics.'
              : `Adherence ${formatBps(stats.adherenceBps, { dp: 1 })}. Open analytics.`
          }
          corner={
            <ProgressRing value={untested ? 0 : stats.adherenceBps / 10_000} size={22} thickness={3} tone="signal" />
          }
        />
      </View>
    </View>
  );
});

/** The strip's loading shape: the same four tiles, so nothing jumps when they arrive. */
export function StatsSkeleton() {
  return (
    <View className={cx('gap-3', ROW_OF_FOUR)}>
      {[0, 1].map((row) => (
        <View key={row} className={cx('flex-row gap-3', ROW_CHILD)}>
          {[0, 1].map((col) => (
            <Card key={col} pad="none" className="flex-1 basis-0">
              <View className="min-h-24 justify-between p-3.5">
                <Skeleton width="60%" height={10} />
                <View className="mt-3 gap-1.5">
                  <Skeleton width="45%" height={22} />
                  <Skeleton width="65%" height={10} />
                </View>
              </View>
            </Card>
          ))}
        </View>
      ))}
    </View>
  );
}
