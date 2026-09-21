import { memo, useMemo } from 'react';
import { Text, View } from 'react-native';
import { formatBps, formatDecimal, isMarketAsset } from '@kanon/spec';
import { Link } from '../../nav';
import { assetTitle, baseOf } from '../../lib/chart-assets';
import { cx } from '../../lib/cx';
import type { PairTicker } from '../../lib/domain-types';
import { useMarkets, useSession, useSparkline, useTicker } from '../../lib/domains';
import { chartRoute } from '../../lib/routes';
import { useHaptics } from '../../platform';
import { Avatar } from '../avatar';
import { Card } from '../card';
import { Delta } from '../stat';
import { EmptyState } from '../empty-state';
import { Icon } from '../icons';
import { SectionHeader } from '../section-header';
import { Skeleton, SkeletonRow } from '../skeleton';
import { Sparkline } from '../sparkline';
import { DIRECTION_TONE, directionOf } from '../tone';
import { Num } from '../ui';

const SPARK_W = 64;
const SPARK_H = 28;

/** The pair's last-day line. Its own subscription: a new print re-renders this and nothing around it. */
const PairSpark = memo(function PairSpark({ asset, changeBps }: { asset: string; changeBps: number | null }) {
  const line = useSparkline(asset);
  if (line.status === 'loading') return <Skeleton width={SPARK_W} height={SPARK_H} />;
  if (line.status === 'empty') return <View style={{ width: SPARK_W, height: SPARK_H }} />;
  return (
    <Sparkline
      data={line.points}
      width={SPARK_W}
      height={SPARK_H}
      // The colour follows the figure beside it (the 24h move), never a second opinion.
      {...(changeBps === null ? { tone: 'neutral' as const } : { tone: DIRECTION_TONE[directionOf(changeBps)] })}
    />
  );
});

function Change({ changeBps }: { changeBps: number | null }) {
  // "No earlier print to compare with" is a dash, never 0%.
  if (changeBps === null) return <Num className="text-12 text-ash">{'—'}</Num>;
  return <Delta value={formatBps(Math.abs(changeBps))} direction={directionOf(changeBps)} />;
}

/**
 * One pair. It subscribes to its own ticker, so another pair's tick does not
 * re-render it; `memo` on the asset string means the list re-rendering does not
 * either.
 */
const PairRow = memo(function PairRow({ asset, divider }: { asset: string; divider: boolean }) {
  const ticker = useTicker(asset);
  const { tap } = useHaptics();
  const base = baseOf(asset);
  const t: PairTicker | null = ticker.status === 'ready' || ticker.status === 'demo' ? ticker.ticker : null;
  const title = assetTitle(asset).split(' / ')[0] ?? base;

  return (
    <Link
      href={chartRoute(asset)}
      onPressIn={tap}
      aria-label={
        t
          ? `${asset} ${formatDecimal(t.price)}${t.changeBps === null ? '' : `, ${formatBps(t.changeBps, { signed: true })} over 24 hours`}. Open chart.`
          : `${asset}. Open chart.`
      }
      className={cx(
        'min-h-16 flex-row items-center gap-3 px-4 py-3 hover:bg-raised active:bg-raised',
        divider && 'border-b border-hairline',
      )}
    >
      <Avatar name={base} size="sm" />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="font-sans text-14 font-medium text-bone">
          {base}
          <Text className="font-mono text-11 text-ash">{`  /USD`}</Text>
        </Text>
        <Text numberOfLines={1} className="font-sans text-12 text-ash">
          {title}
        </Text>
      </View>
      <PairSpark asset={asset} changeBps={t ? t.changeBps : null} />
      <View className="w-24 items-end gap-0.5">
        {ticker.status === 'loading' ? (
          <>
            <Skeleton width={72} height={14} />
            <Skeleton width={44} height={11} />
          </>
        ) : t ? (
          <>
            <Num className="font-mono-medium text-14 tracking-t20">{formatDecimal(t.price)}</Num>
            <Change changeBps={t.changeBps} />
          </>
        ) : (
          <Num className="text-12 text-ash">{'—'}</Num>
        )}
      </View>
    </Link>
  );
});

/**
 * Tradeable pairs: only assets with a signed price feed, each opening its chart.
 * The list re-renders on any tick but only hands its rows a string, so a tick
 * costs one row.
 */
export function MarketsSection() {
  const markets = useMarkets();
  const session = useSession();
  const assets = useMemo(
    () =>
      markets.status === 'ready' || markets.status === 'demo'
        ? markets.pairs.map((p) => p.asset).filter(isMarketAsset)
        : [],
    [markets],
  );
  const demo = markets.status === 'demo';

  return (
    <View className="gap-2.5">
      <SectionHeader
        title="Tradeable pairs"
        {...(assets.length > 0 ? { count: assets.length } : {})}
        action={{ label: 'Chart', href: chartRoute(assets[0] ?? 'BTC/USD') }}
      />
      <Card pad="none">
        {markets.status === 'loading' || session.pending ? (
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : assets.length === 0 ? (
          <EmptyState
            icon="line-chart"
            title="Waiting on the feeds"
            body="Prices for BTC, ETH, SOL and MON appear here as soon as their signed feeds print."
          />
        ) : (
          <>
            {assets.map((asset, i) => (
              <PairRow key={asset} asset={asset} divider={i < assets.length - 1} />
            ))}
            <View className="flex-row items-center gap-1.5 border-t border-hairline px-4 py-2.5">
              <Icon name="info" size={12} color="ash" />
              <Text className="flex-1 font-mono text-10 leading-[1.4] text-ash">
                {demo ? 'Sample prices. Sign in for the live signed feeds.' : 'Pyth feeds, signed. Change is over 24 hours.'}
              </Text>
            </View>
          </>
        )}
      </Card>
    </View>
  );
}
