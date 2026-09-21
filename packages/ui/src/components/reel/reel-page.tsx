import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { abbreviateHash, canTakeSide, marketPhase, type MarketPhase, type MarketSide } from '@kanon/spec';
import type { ColorToken } from '@kanon/tokens';
import { changeOver24h, decimalToNumber } from '../../lib/chart-series';
import { useKanonSelector } from '../../lib/data';
import { cx } from '../../lib/cx';
import { withAlpha } from '../../lib/elevation';
import { formatCountdown, formatUtc } from '../../lib/predict-map';
import { candleCountFor, chartGeometry, closesOf } from '../../lib/predict-chart';
import type { MarketAvailability } from '../../lib/market-client';
import {
  assetCode,
  displayPrice,
  distanceLabel,
  dollars,
  outcomeCopy,
  pageState,
  positionLines,
  sideCopy,
  splitFigures,
  windowLength,
  windowRemaining,
  type PageState,
} from '../../lib/predict-reel';
import type { PredictMarket } from '../../lib/predict-types';
import { useTheme } from '../../theme';
import { Badge } from '../badge';
import { Chip } from '../chip';
import { Icon } from '../icons';
import { ProgressRing } from '../progress-ring';
import { Label } from '../stat';
import type { Tone } from '../tone';
import { Num } from '../ui';
import { ChartPlaceholder, ReelChart } from './reel-chart';
import { NoteLine, PAGE_SNAP, Move, Question, Rail, SideButton, usePageClock } from './reel-parts';

/** What the person just did on a market, kept for the page to say. */
export interface TakenNote {
  taken: boolean;
  text: string;
}

export interface ReelPageProps {
  market: PredictMarket;
  width: number;
  height: number;
  /** The page on screen. Only it runs a clock. */
  active: boolean;
  /** Shows the swipe hint under the action zone. */
  hint: boolean;
  availability: MarketAvailability;
  nativeSymbol: string;
  /** The contract's `hasCrossed` said so. */
  crossedOnChain: boolean;
  taken: TakenNote | undefined;
  onSide: (market: PredictMarket, side: MarketSide) => void;
  onEvidence: (market: PredictMarket) => void;
  onInfo: (market: PredictMarket) => void;
  onShare: (market: PredictMarket) => void;
  /** Asks the contract whether the market is crossed. Called once when the page comes on screen. */
  onCheckCrossed: (market: PredictMarket) => void;
}

/** Room at the top for the filter strip that floats over the feed. */
export const TOP_INSET = 58;
/**
 * How far the raised AI tab button stands above the tab bar (its -mt-4.5 lift plus its shadow).
 * The action zone keeps this clear at the foot of every page, so the hint and the sides never sit under it.
 */
export const TAB_PROTRUSION = 28;
/** A page shorter than this (a 667px phone, less its chrome) tightens up instead of overflowing. */
export const COMPACT_BELOW = 640;
/** The rail's column, kept clear of the line so nothing draws under a control. */
const RAIL_COLUMN = 68;

const PHASE_BADGE: Record<MarketPhase, { label: string; tone: Tone; icon: 'activity' | 'clock' | 'target' | 'check' | 'minus' }> = {
  open: { label: 'Live', tone: 'neutral', icon: 'activity' },
  upcoming: { label: 'Opens soon', tone: 'neutral', icon: 'clock' },
  crossed: { label: 'Touched', tone: 'neutral', icon: 'target' },
  expired: { label: 'Ended', tone: 'neutral', icon: 'clock' },
  settled: { label: 'Settled', tone: 'neutral', icon: 'check' },
  unresolvable: { label: 'No result', tone: 'neutral', icon: 'minus' },
};

/**
 * One full-screen market. Memoised on stable props, so a page that is not the
 * active one does no work when the clock ticks, and a stake on one card does not
 * redraw the others.
 */
export const ReelPage = memo(function ReelPage(props: ReelPageProps) {
  const { market, width, height, active, availability, crossedOnChain, onCheckCrossed } = props;
  const now = usePageClock(active);
  const at = now ?? Math.floor(Date.now() / 1000);
  const state = pageState({ market, nowSeconds: at, crossedOnChain, availability });
  const resolved = state.phase === 'settled' || state.phase === 'unresolvable';
  const onChain = Boolean(market.chain) && !market.demo;

  // A market on-chain can be crossed before the backend's sweep has noticed. Ask the contract once the page is shown.
  useEffect(() => {
    if (!active || !onChain || crossedOnChain) return;
    if (canTakeSide(marketPhase(market, Math.floor(Date.now() / 1000)))) onCheckCrossed(market);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, market.id, onChain]);

  return (
    <View className="overflow-hidden bg-void" style={[{ width, height }, PAGE_SNAP]}>
      {resolved ? (
        <SettledBody {...props} state={state} />
      ) : (
        <LiveBody {...props} state={state} now={now} at={at} />
      )}
    </View>
  );
});

function Backdrop({ tone }: { tone: ColorToken | null }) {
  const { colors } = useTheme();
  const top = tone ? withAlpha(colors[tone], 0.16) : colors.raised;
  return <LinearGradient colors={[top, colors.void]} locations={[0, 0.62]} style={StyleSheet.absoluteFill} />;
}

/** Asset, its window, and where the market stands; then the question, big. */
function Header({ market, state, compact }: { market: PredictMarket; state: PageState; compact: boolean }) {
  const badge = PHASE_BADGE[state.phase];
  return (
    <View className="px-5" style={{ paddingTop: TOP_INSET }}>
      <View className="flex-row items-center gap-2">
        <Text className="font-mono-bold text-15 tracking-w08 text-bone">{assetCode(market.asset)}</Text>
        <Chip label={market.timeframe} />
        <Badge label={badge.label} tone={badge.tone} icon={badge.icon} size="md" />
        {market.demo ? <Badge label="Demo" tone="signal" size="md" /> : null}
      </View>
      <View className={compact ? 'mt-2' : 'mt-3'}>
        <Question market={market} size={compact ? 'md' : 'lg'} />
      </View>
    </View>
  );
}

/** Two big sides in the thumb zone, or a plain sentence saying why not. */
function ActionZone({
  market,
  state,
  taken,
  hint,
  nativeSymbol,
  onSide,
  compact,
}: {
  market: PredictMarket;
  state: PageState;
  taken: TakenNote | undefined;
  hint: boolean;
  compact: boolean;
  nativeSymbol: string;
  onSide: (market: PredictMarket, side: MarketSide) => void;
}) {
  const yours = positionLines(market.positions, nativeSymbol)[0];
  return (
    <View className="px-5" style={{ paddingBottom: TAB_PROTRUSION }}>
      {state.showSides ? (
        <View className="flex-row gap-3">
          <SideButton
            side="above"
            copy={sideCopy(market, 'above')}
            disabled={!state.canStake}
            onPress={() => onSide(market, 'above')}
          />
          <SideButton
            side="below"
            copy={sideCopy(market, 'below')}
            disabled={!state.canStake}
            onPress={() => onSide(market, 'below')}
          />
        </View>
      ) : (
        <View className="h-16 items-center justify-center rounded-sm border border-hairline bg-panel px-4">
          <Text className="text-center font-mono text-12 leading-4 text-ash">
            {state.note?.text ?? 'Closed to new sides.'}
          </Text>
        </View>
      )}
      {state.showSides && state.note ? (
        <NoteLine text={state.note.text} />
      ) : taken ? (
        <NoteLine text={taken.text} icon={taken.taken ? 'check-circle' : 'info'} strong={taken.taken} />
      ) : yours ? (
        <NoteLine text={`Your side · ${yours}`} strong />
      ) : hint && !compact ? (
        <NoteLine text="Swipe up for the next market" icon="chevron-up" />
      ) : (
        <View className={compact ? 'min-h-2' : 'min-h-8'} />
      )}
    </View>
  );
}

/** The asset's recent closes and its move over the day. Only a live page reads them. */
function useAssetLine(market: PredictMarket) {
  const useSeries = useKanonSelector((s) => s.useSeries);
  const state = useSeries(market.asset, 900);
  const series = state.status === 'ready' || state.status === 'demo' ? state.series : null;
  const window = windowLength(market);
  const closes = useMemo(
    () => (series ? closesOf(series, candleCountFor(window, series.bucketSeconds)) : []),
    [series, window],
  );
  const change = useMemo(() => (series ? changeOver24h(series) : null), [series]);
  return { closes, change, loading: state.status === 'loading' };
}

function LiveBody(props: ReelPageProps & { state: PageState; now: number | null; at: number }) {
  const { market, state, now, at, taken, hint, nativeSymbol, onSide, onEvidence, onInfo, onShare, height } = props;
  const compact = height < COMPACT_BELOW;
  const { closes, change, loading } = useAssetLine(market);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  const tone: ColorToken | null =
    change?.direction === 'up' ? 'long' : change?.direction === 'down' ? 'short' : null;
  const price = market.price ? decimalToNumber(market.price) : null;
  const geometry = useMemo(
    () =>
      box
        ? chartGeometry(closes, decimalToNumber(market.target), price, {
            width: box.w,
            height: box.h,
            plotRight: Math.max(60, box.w - RAIL_COLUMN),
            padTop: 34,
            padBottom: 48,
          })
        : null,
    [box, closes, market.target, price],
  );

  const upcoming = state.phase === 'upcoming';
  const endsAt = upcoming ? market.windowStart : market.windowEnd;
  const clock = now === null ? '--:--:--' : formatCountdown(endsAt - now);
  const timeLabel = upcoming ? 'Opens in' : state.phase === 'crossed' ? 'Final in' : state.phase === 'expired' ? 'Ended' : 'Time left';
  const distance = distanceLabel(market);

  return (
    <>
      <Backdrop tone={tone} />
      <Header market={market} state={state} compact={compact} />

      <View className={cx('flex-row items-end gap-3 px-5', compact ? 'mt-2' : 'mt-4')}>
        <Num className={cx('font-mono-medium tracking-t30', compact ? 'text-26' : 'text-32')}>
          {market.price ? `$${displayPrice(market.price)}` : '—'}
        </Num>
        {change ? (
          <View className="pb-1.5">
            <Move text={change.percentText} direction={change.direction} suffix="24h" />
          </View>
        ) : null}
      </View>

      <View className="mt-2 min-h-32 flex-1" onLayout={onLayout}>
        {box && geometry && closes.length > 1 ? (
          <ReelChart
            geometry={geometry}
            width={box.w}
            height={box.h}
            plotRight={Math.max(60, box.w - RAIL_COLUMN)}
            tone={tone ?? 'bone'}
            uid={market.id.replace(/[^a-zA-Z0-9]/g, '')}
            targetText={dollars(market.target)}
          />
        ) : (
          <ChartPlaceholder text={loading ? 'Loading the price line' : 'No price line recorded yet'} />
        )}
        {/* A chart too short for a column of three goes horizontal, on the bottom edge. */}
        <View className="absolute bottom-1 right-3">
          <Rail
            horizontal={box !== null && box.h < 250}
            onEvidence={() => onEvidence(market)}
            onShare={() => onShare(market)}
            onInfo={() => onInfo(market)}
          />
        </View>
      </View>

      <View className={cx('flex-row items-center justify-between px-5', compact ? 'py-2' : 'py-3')}>
        <View className="flex-row items-center gap-3">
          <ProgressRing value={upcoming ? 1 : windowRemaining(market, at)} size={compact ? 36 : 44} thickness={4} tone="signal">
            <Icon name="timer" size={16} color="ash" />
          </ProgressRing>
          <View className="gap-0.5">
            <Label>{timeLabel}</Label>
            <Num className="font-mono-medium text-18 tracking-t20">{clock}</Num>
          </View>
        </View>
        {distance ? (
          <View className="items-end gap-0.5">
            <Label>To target</Label>
            <Num className="font-mono-medium text-18 tracking-t20">{distance}</Num>
          </View>
        ) : null}
      </View>

      <ActionZone
        market={market}
        state={state}
        taken={taken}
        hint={hint}
        compact={compact}
        nativeSymbol={nativeSymbol}
        onSide={onSide}
      />
    </>
  );
}

/** A result, said plainly: what decided it, the price, and the evidence one tap away. */
function SettledBody(props: ReelPageProps & { state: PageState }) {
  const { market, state, taken, onEvidence, onInfo, onShare, nativeSymbol, height } = props;
  const compact = height < COMPACT_BELOW;
  const outcome = outcomeCopy(market);
  const s = market.settlement;
  const hash = s?.evidenceHash ?? market.termsHash ?? '';
  const yours = positionLines(market.positions, nativeSymbol);
  const at = s?.decidingAt ?? s?.windowExtreme?.at ?? null;

  return (
    <>
      <Backdrop tone={null} />
      <Header market={market} state={state} compact={compact} />

      <View className="mt-4 flex-1 justify-center px-5">
        <View className="mb-5 size-12 items-center justify-center rounded-sm border border-hairline bg-raised">
          <Icon
            name={outcome.hit === true ? 'check-circle' : outcome.hit === false ? 'minus' : 'clock'}
            size={22}
            color={outcome.hit === true ? 'bone' : 'ash'}
          />
        </View>
        <Text className="font-sans text-24 font-medium text-bone" style={{ lineHeight: 31 }}>
          {splitFigures(outcome.headline).map((p, i) =>
            p.mono ? (
              <Text key={i} className="font-mono-medium" style={{ fontVariant: ['tabular-nums'] }}>
                {p.text}
              </Text>
            ) : (
              <Text key={i}>{p.text}</Text>
            ),
          )}
        </Text>

        {outcome.figure ? (
          <View className="mt-6 gap-1.5 border-t border-hairline pt-5">
            <Label>{outcome.figureLabel}</Label>
            <Num className="font-mono-medium text-32 tracking-t30">${displayPrice(outcome.figure)}</Num>
            {at !== null ? <Num className="text-11 text-ash">{formatUtc(at)}</Num> : null}
          </View>
        ) : null}

        {yours.length > 0 ? (
          <View className="mt-5 gap-1">
            {yours.map((line, i) => (
              <Num key={i} className="text-12 text-bone">
                Your side · {line}
              </Num>
            ))}
          </View>
        ) : null}
      </View>

      <View className="absolute right-3" style={{ bottom: 64 + 32 + TAB_PROTRUSION + 16 }}>
        <Rail
          horizontal={compact}
          onEvidence={() => onEvidence(market)}
          onShare={() => onShare(market)}
          onInfo={() => onInfo(market)}
        />
      </View>

      <View className="px-5" style={{ paddingBottom: TAB_PROTRUSION }}>
        <Pressable
          role="button"
          aria-label="Open the settlement evidence"
          onPress={() => onEvidence(market)}
          className={cx(
            'h-16 flex-row items-center justify-between rounded-sm border border-verified/50 bg-verified/10 px-4',
            'active:opacity-80 hover:bg-verified/15',
          )}
        >
          <View className="flex-row items-center gap-2.5">
            <Icon name="shield-check" size={20} color="verified" />
            <Text className="font-mono-medium text-14 text-verified">See the evidence</Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <Num className="text-11 text-verified">{hash ? abbreviateHash(hash) : '—'}</Num>
            <Icon name="arrow-up-right" size={14} color="verified" />
          </View>
        </Pressable>
        {taken ? (
          <NoteLine text={taken.text} icon={taken.taken ? 'check-circle' : 'info'} strong={taken.taken} />
        ) : (
          <View className={compact ? 'min-h-2' : 'min-h-8'} />
        )}
      </View>
    </>
  );
}
