import { memo, useMemo } from 'react';
import { Text, View } from 'react-native';
import { formatBps, formatDecimal, isMarketAsset } from '@kanon/spec';
import { Link } from '../../nav';
import { assetTitle, baseOf } from '../../lib/chart-assets';
import { cx } from '../../lib/cx';
import type { PairTicker } from '../../lib/domain-types';
import { useMarkets, useSession, useSparkline, useTicker } from '../../lib/domains';
import { web } from '../../lib/desktop';
import { chartRoute } from '../../lib/routes';
import { isWeb, useHaptics } from '../../platform';
import { Avatar } from '../avatar';
import { Card } from '../card';
import { Delta, Label } from '../stat';
import { EmptyState } from '../empty-state';
import { Icon } from '../icons';
import { SectionHeader } from '../section-header';
import { Skeleton, SkeletonRow } from '../skeleton';
import { Sparkline } from '../sparkline';
import { DIRECTION_TONE, directionOf } from '../tone';
import { Num } from '../ui';

const SPARK_W = 64;
const SPARK_H = 28;
/** From `xl` the table's line is wider: it has a column to itself. */
const SPARK_W_WIDE = 112;

/**
 * The columns of the desktop table, as one set of classes shared by its header and
 * every row so they line up. The phone row is `avatar, name, line, price over
 * change`; from `lg` the same cells are reordered into `pair, price, change, line`,
 * each in a column of its own, a little wider and with a chevron from `xl`. On a device
 * none of this applies.
 */
const COL_PRICE = web('lg:order-2 lg:w-24 xl:w-32');
const COL_CHANGE = 'lg:order-3 lg:w-[84px] xl:w-28';
const COL_LINE = web('lg:order-4 lg:w-20 xl:w-32');

/**
 * The pair's last-day line. Its own subscription: a new print re-renders this and nothing around it.
 * On the web it is drawn twice from the one read, a compact line for the phone row and a wider one for the
 * table, and a class shows one of them.
 */
const PairSpark = memo(function PairSpark({ asset, changeBps }: { asset: string; changeBps: number | null }) {
  const line = useSparkline(asset);
  // The colour follows the figure beside it (the 24h move), never a second opinion.
  const tone = changeBps === null ? ('neutral' as const) : DIRECTION_TONE[directionOf(changeBps)];
  const draw = (width: number) => {
    if (line.status === 'loading') return <Skeleton width={width} height={SPARK_H} />;
    if (line.status === 'empty') return <View style={{ width, height: SPARK_H }} />;
    return <Sparkline data={line.points} width={width} height={SPARK_H} tone={tone} />;
  };
  return (
    <>
      <View className={cx('items-end', web('lg:order-4 lg:w-20 xl:hidden'))}>{draw(SPARK_W)}</View>
      {isWeb ? <View className="hidden items-end xl:order-4 xl:flex xl:w-32">{draw(SPARK_W_WIDE)}</View> : null}
    </>
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
      <View className={cx('w-24 items-end gap-0.5', COL_PRICE)}>
        {ticker.status === 'loading' ? (
          <>
            <Skeleton width={72} height={14} />
            <View className={web('lg:hidden')}>
              <Skeleton width={44} height={11} />
            </View>
          </>
        ) : t ? (
          <>
            <Num className="font-mono-medium text-14 tracking-t20">{formatDecimal(t.price)}</Num>
            <View className={web('lg:hidden')}>
              <Change changeBps={t.changeBps} />
            </View>
          </>
        ) : (
          <Num className="text-12 text-ash">{'—'}</Num>
        )}
      </View>
      {isWeb ? (
        <View className={cx('hidden items-end', COL_CHANGE, 'lg:flex')}>
          {ticker.status === 'loading' ? <Skeleton width={52} height={12} /> : <Change changeBps={t ? t.changeBps : null} />}
        </View>
      ) : null}
      {isWeb ? (
        <View className="hidden w-4 items-end xl:order-5 xl:flex">
          <Icon name="chevron-right" size={14} color="ash" />
        </View>
      ) : null}
    </Link>
  );
});

/** The desktop table's column titles. Hidden below `lg`, where a row is its own label. */
function TableHead() {
  return (
    <View className="hidden h-9 flex-row items-center gap-3 border-b border-hairline bg-raised/60 px-4 lg:flex">
      <Label className="flex-1 pl-11">Pair</Label>
      <Label className={cx('text-right', COL_PRICE)}>Price</Label>
      <Label className={cx('text-right', COL_CHANGE)}>24h change</Label>
      <Label className={cx('text-right', COL_LINE)}>Last 24h</Label>
      <View className="hidden w-4 xl:order-5 xl:flex" />
    </View>
  );
}

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
            {isWeb ? <TableHead /> : null}
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
