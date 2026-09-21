import { memo, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { formatBps, formatDecimal, marketPhase } from '@kanon/spec';
import { assetTitle } from '../../lib/chart-assets';
import { cx } from '../../lib/cx';
import type { PairTicker } from '../../lib/domain-types';
import { useTicker } from '../../lib/domains';
import { formatCountdown, formatAmount, phaseLabel, positionResultLabel, sideLabel } from '../../lib/predict-map';
import { assetCode, questionText, settleTerms, type ReelFilter } from '../../lib/predict-reel';
import type { PredictMarket, PredictPosition } from '../../lib/predict-types';
import { useHaptics } from '../../platform';
import { Avatar } from '../avatar';
import { Badge } from '../badge';
import { EmptyState } from '../empty-state';
import { Icon } from '../icons';
import { SectionHeader } from '../section-header';
import { Delta, Label } from '../stat';
import { directionOf } from '../tone';
import { Num } from '../ui';
import { SETTLE_STEPS } from './reel-sheets';

/*
 * The two panels either side of the reel on a desktop. The left is `hidden` below
 * `lg` and `flex` from it, the right from `xl` (at 1024 the pane has room for the
 * 440px reel and one panel, not two), by class. The screen renders them on the web only and
 * gives them content only once the window is a desktop's, so a phone pays for none
 * of it. Everything they show is what the reel already holds: the feed's markets,
 * the live tickers, and `settleTerms`. Nothing here decides a result.
 */

const PANEL = 'hidden min-h-0 shrink-0 bg-panel lg:flex';

/* -------------------------------------------------------------------------- */
/* Left: what to look at                                                       */
/* -------------------------------------------------------------------------- */

/** One asset in the filter list, with its live price. Its own subscription, so another asset's tick re-renders nothing here. */
const AssetRow = memo(function AssetRow({
  code,
  count,
  selected,
  onPress,
}: {
  code: string;
  count: number;
  selected: boolean;
  onPress: () => void;
}) {
  const symbol = `${code}/USD`;
  const ticker = useTicker(symbol);
  const { select } = useHaptics();
  const t: PairTicker | null = ticker.status === 'ready' || ticker.status === 'demo' ? ticker.ticker : null;
  return (
    <Pressable
      role="button"
      aria-pressed={selected}
      aria-label={`${selected ? 'Showing' : 'Show'} ${code} markets, ${count}`}
      onPress={() => {
        select();
        onPress();
      }}
      className={cx(
        'relative min-h-14 flex-row items-center gap-3 px-4 py-2.5',
        selected ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised',
      )}
    >
      <View className={cx('absolute inset-y-2 left-0 w-0.5 bg-signal', selected ? 'opacity-100' : 'opacity-0')} />
      <Avatar name={code} size="sm" tone={selected ? 'signal' : 'neutral'} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="font-sans text-13 font-medium text-bone">
          {code}
          <Text className="font-mono text-11 text-ash">{`  ${count} ${count === 1 ? 'market' : 'markets'}`}</Text>
        </Text>
        <Text numberOfLines={1} className="font-sans text-11 text-ash">
          {assetTitle(symbol).split(' / ')[0]}
        </Text>
      </View>
      <View className="items-end gap-0.5">
        {t ? (
          <>
            <Num className="font-mono-medium text-13 tracking-t20">{formatDecimal(t.price)}</Num>
            {t.changeBps === null ? (
              <Num className="text-11 text-ash">{'—'}</Num>
            ) : (
              <Delta value={formatBps(Math.abs(t.changeBps))} direction={directionOf(t.changeBps)} />
            )}
          </>
        ) : (
          <Num className="text-12 text-ash">{'—'}</Num>
        )}
      </View>
    </Pressable>
  );
});

/** A market in the list: its asset and window, how long it has, and the question. The one on screen is lit. */
function MarketRow({
  market,
  now,
  current,
  onPress,
}: {
  market: PredictMarket;
  now: number;
  current: boolean;
  onPress: () => void;
}) {
  const phase = marketPhase(market, now);
  const live = phase === 'open' || phase === 'upcoming';
  const clock = phase === 'upcoming' ? market.windowStart - now : market.windowEnd - now;
  return (
    <Pressable
      role="button"
      aria-current={current ? 'true' : undefined}
      aria-label={`Go to: ${questionText(market)}`}
      onPress={onPress}
      className={cx('relative gap-1 px-4 py-3', current ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised')}
    >
      <View className={cx('absolute inset-y-2 left-0 w-0.5 bg-signal', current ? 'opacity-100' : 'opacity-0')} />
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-row items-center gap-2">
          <Text className="font-mono-bold text-12 tracking-w08 text-bone">{assetCode(market.asset)}</Text>
          <Text className="font-mono text-11 text-ash">{market.timeframe}</Text>
        </View>
        {live ? (
          <Num className="text-11 text-ash">{formatCountdown(clock)}</Num>
        ) : (
          <Text className="font-mono text-9 tracking-w14 text-ash">{phaseLabel(phase)}</Text>
        )}
      </View>
      <Text numberOfLines={2} className="font-sans text-13 leading-[18px] text-bone">
        {questionText(market)}
      </Text>
    </Pressable>
  );
}

/** Timeframe as a strip: any window, or one of those the feed has. */
function WindowStrip({
  value,
  options,
  onChange,
}: {
  value: string | null;
  options: readonly string[];
  onChange: (timeframe: string | null) => void;
}) {
  const { select } = useHaptics();
  const all: ReadonlyArray<string | null> = [null, ...options];
  return (
    <View role="tablist" aria-label="Window" className="flex-row rounded-sm border border-hairline bg-sunken p-0.5">
      {all.map((tf) => {
        const on = tf === value;
        return (
          <Pressable
            key={tf ?? 'any'}
            role="tab"
            aria-selected={on}
            aria-label={tf === null ? 'Any window' : `Window ${tf}`}
            onPress={() => {
              if (on) return;
              select();
              onChange(tf);
            }}
            className={cx(
              'h-7 flex-1 items-center justify-center rounded-xs border',
              on ? 'border-hairline bg-lift' : 'border-transparent hover:bg-raised',
            )}
          >
            <Text className={cx('text-11', on ? 'font-mono-bold text-bone' : 'font-mono text-ash')}>{tf ?? 'Any'}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Left of the reel: the assets that have markets, with live prices, as a filter;
 * the window; and the markets in view as a list with the current one lit. Every row
 * moves the reel, so the feed is navigable without swiping.
 */
export function ReelLeftPanel({
  live,
  assets,
  counts,
  total,
  windows,
  filter,
  onAsset,
  onTimeframe,
  markets,
  activeId,
  now,
  onPick,
}: {
  /** The window is a desktop's: mount the rows (they subscribe to prices). */
  live: boolean;
  assets: readonly string[];
  counts: Readonly<Record<string, number>>;
  total: number;
  windows: readonly string[];
  filter: ReelFilter;
  onAsset: (asset: string | null) => void;
  onTimeframe: (timeframe: string | null) => void;
  markets: readonly PredictMarket[];
  activeId: string | null;
  now: number;
  onPick: (marketId: string) => void;
}) {
  return (
    <View role="complementary" aria-label="Markets" className={cx(PANEL, 'w-[264px] border-r border-hairline xl:w-[296px]')}>
      <ScrollView className="min-h-0 flex-1" showsVerticalScrollIndicator={false}>
        <SectionHeader
          title="Assets"
          {...(assets.length > 0 ? { count: assets.length } : {})}
          className="px-4 pb-2.5 pt-4"
        />
        {live ? (
          <>
            <Pressable
              role="button"
              aria-pressed={filter.asset === null}
              aria-label={`Show all markets, ${total}`}
              onPress={() => onAsset(null)}
              className={cx(
                'relative min-h-12 flex-row items-center gap-3 px-4 py-2.5',
                filter.asset === null ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised',
              )}
            >
              <View
                className={cx(
                  'absolute inset-y-2 left-0 w-0.5 bg-signal',
                  filter.asset === null ? 'opacity-100' : 'opacity-0',
                )}
              />
              <View className="size-8 items-center justify-center rounded-sm border border-hairline bg-raised">
                <Icon name="layers" size={16} color="ash" />
              </View>
              <Text className="min-w-0 flex-1 font-sans text-13 font-medium text-bone">All markets</Text>
              <Num className="text-12 text-ash">{total}</Num>
            </Pressable>
            {assets.map((code) => (
              <AssetRow
                key={code}
                code={code}
                count={counts[code] ?? 0}
                selected={filter.asset === code}
                onPress={() => onAsset(filter.asset === code ? null : code)}
              />
            ))}
          </>
        ) : null}

        {windows.length > 1 ? (
          <View className="gap-2 px-4 pb-1 pt-4">
            <Label>Window</Label>
            <WindowStrip value={filter.timeframe} options={windows} onChange={onTimeframe} />
          </View>
        ) : null}

        <View className="mt-3 border-t border-hairline">
          <SectionHeader title="In view" count={markets.length} className="px-4 pb-1.5 pt-4" />
          {markets.length === 0 ? (
            <Text className="px-4 pb-4 pt-1 font-sans text-12 leading-[18px] text-ash">
              No market matches this filter right now.
            </Text>
          ) : (
            markets.map((m) => (
              <MarketRow key={m.id} market={m} now={now} current={m.id === activeId} onPress={() => onPick(m.id)} />
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Right: how it settles, and what you hold                                    */
/* -------------------------------------------------------------------------- */

interface Held {
  key: string;
  market: PredictMarket;
  position: PredictPosition;
}

function HeldRow({ held, symbol, onPress }: { held: Held; symbol: string; onPress: () => void }) {
  const { market, position } = held;
  const up = position.side === 'above';
  return (
    <Pressable
      role="button"
      aria-label={`${sideLabel(position.side)} on ${assetCode(market.asset)}, ${positionResultLabel(position.result)}. Go to the market.`}
      onPress={onPress}
      className="gap-1.5 border-b border-hairline px-4 py-3 hover:bg-raised/60 active:bg-raised"
    >
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-row items-center gap-2">
          <Icon name={up ? 'arrow-up' : 'arrow-down'} size={14} color={up ? 'long' : 'short'} strokeWidth={2} />
          <Text className="font-mono-bold text-12 tracking-w08 text-bone">
            {sideLabel(position.side)} {assetCode(market.asset)}
          </Text>
          <Text className="font-mono text-11 text-ash">{market.timeframe}</Text>
        </View>
        <Badge label={positionResultLabel(position.result)} />
      </View>
      <Text numberOfLines={1} className="font-sans text-12 text-ash">
        {questionText(market)}
      </Text>
      {position.stake ? (
        <Num className="text-11 text-bone">
          {formatAmount(position.stake)} {symbol}
        </Num>
      ) : null}
    </Pressable>
  );
}

/**
 * Right of the reel: how a market settles (the same three lines as the sheet, then
 * this market's own terms and the evidence one tap away), and what the person
 * holds, open and settled, each row taking the reel to its market.
 */
export function ReelRightPanel({
  market,
  markets,
  nativeSymbol,
  onEvidence,
  onPick,
}: {
  /** The market on screen, if any. */
  market: PredictMarket | undefined;
  /** Every market in the feed, for the predictions list. */
  markets: readonly PredictMarket[];
  nativeSymbol: string;
  onEvidence: (market: PredictMarket) => void;
  onPick: (marketId: string) => void;
}) {
  const [tab, setTab] = useState<'open' | 'settled'>('open');
  const held = useMemo<Held[]>(
    () => markets.flatMap((m) => m.positions.map((position, i): Held => ({ key: `${m.id}:${i}`, market: m, position }))),
    [markets],
  );
  const open = useMemo(() => held.filter((h) => h.position.result === null), [held]);
  const settled = useMemo(() => held.filter((h) => h.position.result !== null), [held]);
  const shown = tab === 'open' ? open : settled;
  const { select } = useHaptics();

  return (
    <View
      role="complementary"
      aria-label="How it settles, and your predictions"
      className="hidden min-h-0 w-[320px] shrink-0 border-l border-hairline bg-panel xl:flex"
    >
      <ScrollView className="min-h-0 flex-1" showsVerticalScrollIndicator={false}>
        <SectionHeader title="How it settles" className="px-4 pb-3 pt-4" />
        <View className="gap-3 px-4">
          {SETTLE_STEPS.map((step, i) => (
            <View key={i} className="flex-row items-start gap-3">
              <View className="size-5 items-center justify-center rounded-xs border border-hairline bg-raised">
                <Num className="text-10 text-ash">{i + 1}</Num>
              </View>
              <Text className="min-w-0 flex-1 font-sans text-12 leading-[18px] text-ash">{step}</Text>
            </View>
          ))}
        </View>

        {market ? (
          <View className="gap-2 px-4 pt-5">
            <Label>{`This market · ${assetCode(market.asset)} ${market.timeframe}`}</Label>
            <View className="border border-hairline bg-void">
              {settleTerms(market).map(([name, value], i, all) => (
                <View
                  key={name}
                  className={cx(
                    'flex-row items-center justify-between gap-3 px-3 py-2',
                    i < all.length - 1 && 'border-b border-hairline',
                  )}
                >
                  <Text className="font-mono text-11 text-ash">{name}</Text>
                  <Num className="shrink text-11">{value}</Num>
                </View>
              ))}
            </View>
            <Pressable
              role="button"
              aria-label="See the evidence"
              onPress={() => onEvidence(market)}
              className="h-10 flex-row items-center justify-center gap-2 rounded-sm border border-verified/50 bg-verified/10 hover:bg-verified/15 active:opacity-80"
            >
              <Icon name="shield-check" size={16} color="verified" />
              <Text className="font-mono-medium text-12 text-verified">See the evidence</Text>
            </Pressable>
          </View>
        ) : null}

        <View className="mt-6 border-t border-hairline">
          <SectionHeader title="Your predictions" count={held.length} className="px-4 pb-3 pt-4" />
          <View className="px-4 pb-3">
            <View
              role="tablist"
              aria-label="Predictions"
              className="flex-row rounded-sm border border-hairline bg-sunken p-0.5"
            >
              {(
                [
                  ['open', 'Open', open.length],
                  ['settled', 'Settled', settled.length],
                ] as const
              ).map(([key, label, n]) => {
                const on = tab === key;
                return (
                  <Pressable
                    key={key}
                    role="tab"
                    aria-selected={on}
                    aria-label={`${label}, ${n}`}
                    onPress={() => {
                      if (on) return;
                      select();
                      setTab(key);
                    }}
                    className={cx(
                      'h-7 flex-1 flex-row items-center justify-center gap-1.5 rounded-xs border',
                      on ? 'border-hairline bg-lift' : 'border-transparent hover:bg-raised',
                    )}
                  >
                    <Text className={cx('text-11', on ? 'font-mono-bold text-bone' : 'font-mono text-ash')}>{label}</Text>
                    <Num className="text-10 text-ash">{n}</Num>
                  </Pressable>
                );
              })}
            </View>
          </View>
          {shown.length === 0 ? (
            <EmptyState
              icon={tab === 'open' ? 'target' : 'check-circle'}
              title={tab === 'open' ? 'No open predictions' : 'Nothing settled yet'}
              body={
                tab === 'open'
                  ? 'Take UP or DOWN on a market and it is listed here until it settles.'
                  : 'A market you took a side on lands here with its evidence once it settles.'
              }
              className="py-8"
            />
          ) : (
            shown.map((h) => <HeldRow key={h.key} held={h} symbol={nativeSymbol} onPress={() => onPick(h.market.id)} />)
          )}
        </View>
      </ScrollView>
    </View>
  );
}
