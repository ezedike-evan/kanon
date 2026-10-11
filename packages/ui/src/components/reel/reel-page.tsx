import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { formatBps } from '@kanon/spec';
import type { ColorToken } from '@kanon/tokens';
import { decimalToNumber } from '../../lib/chart-series';
import { cx } from '../../lib/cx';
import { useKanonSelector } from '../../lib/data';
import { web } from '../../lib/desktop';
import type { PairTicker } from '../../lib/domain-types';
import { useTicker } from '../../lib/domains';
import { withAlpha } from '../../lib/elevation';
import { candleCountFor, chartGeometry, closesOf } from '../../lib/predict-chart';
import {
  accountLine,
  lineBucketSeconds,
  runningNote,
  runningTitle,
  sideClaim,
  slideBadge,
  slideMode,
  slideTitle,
  type ReelSlide,
  type SlideMode,
  type TitlePart,
} from '../../lib/timed-reel';
import { routes } from '../../lib/routes';
import {
  SAMPLE_LEAD,
  choiceFacts,
  countdownText,
  directionAction,
  durationLabel,
  elapsedFraction,
  finishedView,
  formatTimedPrice,
  liveMove,
  requestOf,
  runningView,
  sendingLine,
  timedView,
  type RunningView,
  type TimedView,
} from '../../lib/timed-trade';
import type { TimedDirection, TimedTrade } from '../../lib/timed-types';
import { useCountdownClock, useDue } from '../../lib/use-clock';
import type { TimedTicket } from '../../lib/use-timed-ticket';
import { formatUsd } from '../../lib/venue-trade';
import { useNavigator } from '../../nav';
import { isWeb, useHaptics } from '../../platform';
import { useTheme } from '../../theme';
import { Badge } from '../badge';
import { Chip } from '../chip';
import { Icon, type Icon as IconName } from '../icons';
import { ProgressRing } from '../progress-ring';
import { SignInLink } from '../sign-in-link';
import { Label } from '../stat';
import type { Tone } from '../tone';
import { Num } from '../ui';
import { ChartPlaceholder, ReelChart } from './reel-chart';
import { Move, NoteLine, PAGE_SNAP, Rail, SideButton, SlideTitle, usePageClock } from './reel-parts';
import { ChoiceChips, DirectionMark, FOCUS, Facts, MoveMark, OutcomeBlock, TxInline } from './trade-parts';

/*
 * One full-screen slide of the reel: a pair and a time.
 *
 * The market is the time. A slide asks which way its pair moves in its time,
 * shows the pair's price and line, and holds UP and DOWN at the foot, under the
 * thumb, with the stake as chips above them and, above those, what a press
 * means: the size it opens, that it closes itself after the slide's time, the
 * most it can lose and how far from the mark price it may fill. A press sends
 * the trade. There is no second step and no wallet prompt.
 *
 * While one of the caller's trades is running on the pair, every slide of that
 * pair shows the trade in place of the two actions: the countdown as the
 * largest figure, the entry as a dashed line across the price, how far the
 * price is from the entry (a direction and a distance in price, never money),
 * and "End now". When it ends the slide shows what was called and what the
 * price did, until it is put away. A pair that can take no trade says why.
 */

/** Which half of the trades sheet a press on the rail asks for. */
export type TradesTab = 'running' | 'history';

export interface ReelPageProps {
  slide: ReelSlide;
  width: number;
  height: number;
  /** The slide on screen. Only it runs a clock. */
  active: boolean;
  /** Shows the swipe hint over the foot of the line. */
  hint: boolean;
  /** The screen's one state: what can be traded, the stake, what is out, the caller's trades. */
  ticket: TimedTicket;
  /** Opens the caller's trades: what is running, or what has finished. */
  onTrades: (tab: TradesTab) => void;
  /** Opens a finished trade's details, where its result and both transactions are. */
  onDetails: (tradeId: string) => void;
}

/** Room at the top for the filter strip that floats over the reel. */
export const TOP_INSET = 58;
/**
 * How far the raised AI tab button stands above the tab bar (its -mt-4.5 lift plus its shadow).
 * The foot of every slide keeps this clear, so nothing that can be pressed sits under it.
 */
export const TAB_PROTRUSION = 28;
/** A slide shorter than this (a 667px phone, less its chrome) tightens up instead of overflowing. */
export const COMPACT_BELOW = 640;
/** The rail's column, kept clear of the line so nothing draws under a control. */
const RAIL_COLUMN = 68;

/**
 * One slide. Memoised on stable props; what it reads off the ticket is its own
 * pair's, so the same state drawn on the slide before and the slide after
 * agrees with it.
 */
export const ReelPage = memo(function ReelPage(props: ReelPageProps) {
  const { slide, width, height, ticket } = props;
  const view = useMemo(
    () => timedView(ticket.state, { asset: slide.asset, stakeUsd: ticket.stake, seconds: slide.seconds }),
    [ticket.state, ticket.stake, slide.asset, slide.seconds],
  );
  const mode = slideMode(slide, view, ticket.running, ticket.ended);
  return (
    <View className="overflow-hidden bg-void" style={[{ width, height }, PAGE_SNAP]}>
      <SlideBody {...props} view={view} mode={mode} />
    </View>
  );
});

function Backdrop({ tone }: { tone: ColorToken | null }) {
  const { colors } = useTheme();
  const top = tone ? withAlpha(colors[tone], 0.16) : colors.raised;
  return <LinearGradient colors={[top, colors.void]} locations={[0, 0.62]} style={StyleSheet.absoluteFill} />;
}

/** A pair's newest price, or null while there is none to show. */
function useLivePair(asset: string): PairTicker | null {
  const ticker = useTicker(asset);
  return ticker.status === 'ready' || ticker.status === 'demo' ? ticker.ticker : null;
}

/** The pair's recent closes: about three of the slide's own windows. Only a mounted slide reads them. */
function useSlideLine(slide: ReelSlide) {
  const useSeries = useKanonSelector((s) => s.useSeries);
  const bucket = lineBucketSeconds(slide.seconds);
  const state = useSeries(slide.asset, bucket);
  const series = state.status === 'ready' || state.status === 'demo' ? state.series : null;
  const closes = useMemo(
    () => (series ? closesOf(series, candleCountFor(slide.seconds, series.bucketSeconds)) : []),
    [series, slide.seconds],
  );
  return { closes, loading: state.status === 'loading' };
}

const BADGE_ICON: Record<string, IconName> = {
  OPEN: 'activity',
  // The mark every other demo label in the app carries.
  SAMPLE: 'sparkles',
  RUNNING: 'timer',
  CLOSING: 'timer',
  'IN A TRADE': 'timer',
  HELD: 'lock',
  CLOSED: 'minus',
  'NOT OPEN': 'minus',
};

/** Pair, the time, and where the slide stands; then its title, big. */
function Header({
  base,
  seconds,
  badge,
  badgeTone,
  trade,
  title,
  compact,
}: {
  base: string;
  seconds: number;
  badge: string;
  badgeTone: Tone;
  /** The trade the slide is showing, running or just ended: what was called sits beside the pair. */
  trade: TimedTrade | null;
  title: readonly TitlePart[];
  compact: boolean;
}) {
  return (
    // `pt-[58px]` is TOP_INSET, room for the filter strip that floats over a phone's reel. From `lg` the
    // filters are in the left panel and the slide starts closer to its top.
    <View className={cx('px-5 pt-[58px]', web('lg:pt-6'))}>
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="font-mono-bold text-15 tracking-w08 text-bone">{base}</Text>
        <Chip label={durationLabel(seconds)} icon="timer" />
        {trade ? <DirectionMark direction={trade.direction} large /> : null}
        <Badge label={badge} tone={badgeTone} icon={BADGE_ICON[badge] ?? 'check'} size="md" />
      </View>
      <View className={compact ? 'mt-2' : 'mt-3'}>
        <SlideTitle parts={title} size={compact ? 'md' : 'lg'} />
      </View>
    </View>
  );
}

/**
 * The time left, as digits: the largest figure on a slide with a trade running.
 * Its own clock, lined up with the countdown's own seconds, so the slide around
 * it does not render to move them.
 */
function Countdown({ expiresAt, compact }: { expiresAt: number; compact: boolean }) {
  const now = useCountdownClock(expiresAt);
  const text = countdownText(expiresAt, now);
  return (
    <Text
      role="timer"
      aria-label={`Time left ${text}`}
      className={cx('font-mono-medium tracking-t30 text-bone', compact ? 'text-30' : 'text-34')}
      style={{ fontVariant: ['tabular-nums'], lineHeight: compact ? 32 : 38 }}
    >
      {text}
    </Text>
  );
}

/** A plain outlined block at the foot: the one thing that can be done to what the slide is showing. */
function FootButton({
  label,
  name,
  onPress,
  disabled,
  busy,
  quiet,
  compact,
}: {
  label: string;
  /** What a press does, for a screen reader. */
  name: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** A second action beside the first: drawn in the hairline, not in bone. */
  quiet?: boolean;
  compact: boolean;
}) {
  const { tap } = useHaptics();
  return (
    <Pressable
      role="button"
      aria-label={name}
      aria-busy={busy === true}
      disabled={disabled === true}
      onPressIn={tap}
      onPress={onPress}
      className={cx(
        'flex-1 items-center justify-center rounded-sm border',
        compact ? 'h-14' : 'h-16',
        quiet ? 'border-hairline hover:bg-raised/60 active:bg-raised' : 'border-bone hover:bg-bone/10 active:bg-bone/15',
        disabled && 'opacity-40',
        FOCUS,
      )}
    >
      <Text className={cx('font-mono-bold text-15 tracking-w14', quiet ? 'text-ash' : 'text-bone')}>{label}</Text>
    </Pressable>
  );
}

/**
 * The foot of a slide whose pair is free: what a press means, the stake, and the two actions.
 *
 * Signed out it is the sample: the same foot, with the choices live so they can
 * be tried, and UP and DOWN leading to sign-in. Nothing is sent from it.
 */
function ActionsFoot({ slide, view, ticket, compact }: { slide: ReelSlide; view: TimedView; ticket: TimedTicket; compact: boolean }) {
  const { sending, locked } = ticket;
  const nav = useNavigator();
  // An order is this slide's when it was sent from it. Another slide is locked by it, and says nothing about it.
  const here = sending?.action === 'open' && sending.asset === slide.asset && sending.seconds === slide.seconds ? sending : null;
  const up = directionAction(view, 'up', here, locked);
  const down = directionAction(view, 'down', here, locked);
  const press = (direction: TimedDirection) =>
    view.sample ? nav.push(routes.landing) : ticket.open(requestOf(view, direction));
  return (
    <>
      <View className={cx('px-5', compact ? 'gap-2 pt-2' : 'gap-3 pt-3')} aria-busy={here !== null}>
        <Facts rows={choiceFacts(view)} dense />
        <View className="flex-row items-center gap-3">
          <Label>Stake</Label>
          <View className="min-w-0 flex-1">
            <ChoiceChips
              label="Stake"
              options={view.stakes}
              value={view.stakeUsd}
              format={formatUsd}
              describe={(usd) => `Stake ${Math.trunc(usd)} dollars`}
              onChoose={ticket.chooseStake}
              disabled={locked}
              dense={compact}
            />
          </View>
        </View>
      </View>
      <View className={cx('px-5', compact ? 'pt-2' : 'pt-3')} style={{ paddingBottom: TAB_PROTRUSION }}>
        <View className="flex-row gap-3">
          <SideButton
            direction="up"
            word={up.word}
            claim={sideClaim(view, 'up')}
            label={up.accessibilityLabel}
            disabled={up.disabled}
            sending={up.sending}
            compact={compact}
            onPress={() => press('up')}
          />
          <SideButton
            direction="down"
            word={down.word}
            claim={sideClaim(view, 'down')}
            label={down.accessibilityLabel}
            disabled={down.disabled}
            sending={down.sending}
            compact={compact}
            onPress={() => press('down')}
          />
        </View>
        {/* What is on its way is read out as it changes. Whose account this is, is said once and quietly. */}
        {here ? (
          <NoteLine live strong text={sendingLine(here)} icon="send" />
        ) : view.sample ? (
          // The one place a slide says to sign in, and the way to: the row a NoteLine would take.
          <View className="min-h-8 items-center justify-center pt-2.5">
            <SignInLink lead={SAMPLE_LEAD} />
          </View>
        ) : (
          <NoteLine text={accountLine(view.network)} />
        )}
      </View>
    </>
  );
}

/** The foot of a slide with a trade running on its pair: the countdown, the entry, and "End now". */
function RunningFoot({
  slide,
  trade,
  row,
  due,
  ticket,
  active,
  compact,
}: {
  slide: ReelSlide;
  trade: TimedTrade;
  /** The trade as its slide draws it. */
  row: RunningView;
  /** Its time has passed. */
  due: boolean;
  ticket: TimedTicket;
  active: boolean;
  compact: boolean;
}) {
  const now = usePageClock(active);
  const left = now === null ? 1 : 1 - elapsedFraction(trade.openedAt, trade.expiresAt, now * 1000);
  return (
    <>
      <View className={cx('flex-row items-center justify-between gap-3 px-5', compact ? 'py-2' : 'py-3')}>
        <View className="flex-row items-center gap-3">
          <ProgressRing value={left} size={compact ? 40 : 48} thickness={4} tone="signal">
            <Icon name="timer" size={16} color="ash" />
          </ProgressRing>
          <View>
            <Label>{row.closing ? 'Closing' : 'Time left'}</Label>
            <Countdown expiresAt={trade.expiresAt} compact={compact} />
          </View>
        </View>
        <View className="items-end gap-0.5">
          <Label>Entry</Label>
          <Num className="font-mono-medium text-18 tracking-t20">{row.entry}</Num>
          <Num className="text-11 text-ash">{row.terms}</Num>
          {/* The evidence for the entry, one press away, once the venue has reported it. */}
          {row.openTx ? <TxInline tx={row.openTx} name="Open" /> : null}
        </View>
      </View>
      <View className="px-5" style={{ paddingBottom: TAB_PROTRUSION }}>
        <View className="flex-row">
          <FootButton
            label={row.end.label}
            name={row.end.accessibilityLabel}
            disabled={row.end.disabled}
            busy={row.end.label === 'ENDING…'}
            compact={compact}
            onPress={() => ticket.end(trade.id)}
          />
        </View>
        <NoteLine live text={runningNote(trade, slide, due)} icon="timer" strong={due || trade.reason !== null} />
      </View>
    </>
  );
}

/** The foot of a slide whose trade just ended: how it ended, its details, and putting it away. */
function EndedFoot({
  trade,
  ticket,
  onDetails,
  compact,
}: {
  trade: TimedTrade;
  ticket: TimedTicket;
  onDetails: (tradeId: string) => void;
  compact: boolean;
}) {
  const view = finishedView(trade);
  return (
    <>
      <View role="status" accessibilityLiveRegion="polite" className={cx('gap-1 px-5', compact ? 'py-2' : 'py-3')}>
        <Text className="font-sans text-13 leading-5 text-bone">{view.endedLine}</Text>
        {view.awaiting ? (
          <Text className="font-sans text-12 leading-[18px] text-ash">The exit price arrives a few seconds after the close.</Text>
        ) : null}
      </View>
      <View className="px-5" style={{ paddingBottom: TAB_PROTRUSION }}>
        <View className="flex-row gap-3">
          <FootButton
            label="DETAILS"
            name={`Details of the ${view.asset} ${view.word.toLowerCase()} trade`}
            quiet
            compact={compact}
            onPress={() => onDetails(trade.id)}
          />
          <FootButton
            label="DONE"
            name="Put this trade in the history and bring back up and down"
            compact={compact}
            onPress={() => ticket.dismissEnded(trade.id)}
          />
        </View>
        <NoteLine text="Done brings back UP and DOWN. The trade stays in the history." />
      </View>
    </>
  );
}

/** The foot of a slide whose pair can take no trade: why, in a sentence. It offers nothing. */
function HeldFoot({ line, view, compact }: { line: string; view: TimedView; compact: boolean }) {
  return (
    <View className={cx('px-5', compact ? 'pt-2' : 'pt-3')} style={{ paddingBottom: TAB_PROTRUSION }}>
      <View
        role="status"
        className={cx('items-center justify-center rounded-sm border border-hairline bg-panel px-4 py-3', compact ? 'min-h-14' : 'min-h-16')}
      >
        <Text className="text-center font-mono text-12 leading-[18px] text-bone" style={{ fontVariant: ['tabular-nums'] }}>
          {line}
        </Text>
      </View>
      {/* Whose account it is, when that is known. With trading unavailable the line above is all there is to say. */}
      {view.network ? <NoteLine text={accountLine(view.network)} /> : <View className={compact ? 'min-h-2' : 'min-h-8'} />}
    </View>
  );
}

/** How to reach the next slide, shown on the first one until the reel has moved. */
function SwipeHint() {
  return (
    <View className="absolute bottom-2 left-5 flex-row items-center gap-1.5" style={{ pointerEvents: 'none' }}>
      <Icon name="chevron-up" size={14} color="ash" />
      <Text className={cx('font-mono text-11 text-ash', web('lg:hidden'))}>Swipe up for the next</Text>
      {/* A desktop has no swipe: the wheel and the arrow keys page the reel. */}
      {isWeb ? <Text className="hidden font-mono text-11 text-ash lg:flex">Scroll or press the arrow keys for the next</Text> : null}
    </View>
  );
}

function SlideBody(props: ReelPageProps & { view: TimedView; mode: SlideMode }) {
  const { slide, view, mode, ticket, active, hint, height, onTrades, onDetails } = props;
  const compact = height < COMPACT_BELOW;
  const pair = useLivePair(slide.asset);
  const { closes, loading } = useSlideLine(slide);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  const running = mode.kind === 'running' ? mode.trade : null;
  const ended = mode.kind === 'ended' ? mode.trade : null;
  const shown = running ?? ended;
  const live = running ? liveMove(running, pair?.price ?? null) : null;
  const finished = ended ? finishedView(ended) : null;
  // With no trade running there is no deadline: `Infinity` never passes.
  const due = useDue(running ? running.expiresAt : Number.POSITIVE_INFINITY);
  const row = running
    ? runningView(running, { due, sending: ticket.sending, locked: ticket.locked, asked: ticket.asked.has(running.id) })
    : null;

  // The line's colour is a direction, and a figure beside it always says which: the price against the
  // entry while a trade runs, the exit against the entry once it has ended, the pair over the day otherwise.
  const direction = running
    ? (live?.move.direction ?? 'flat')
    : finished
      ? (finished.move?.direction ?? 'flat')
      : pair && pair.changeBps !== null
      ? pair.changeBps > 0
        ? 'up'
        : pair.changeBps < 0
          ? 'down'
          : 'flat'
      : 'flat';
  const tone: ColorToken | null = direction === 'up' ? 'long' : direction === 'down' ? 'short' : null;

  const price = pair ? decimalToNumber(pair.price) : null;
  const entry = shown ? decimalToNumber(shown.entryPrice) : null;
  const plotRight = box ? Math.max(60, box.w - RAIL_COLUMN) : 0;
  const geometry = useMemo(
    () => (box ? chartGeometry(closes, entry, price, { width: box.w, height: box.h, plotRight, padTop: 34, padBottom: 48 }) : null),
    [box, closes, entry, price, plotRight],
  );

  const badge = finished ? finished.ended : slideBadge(mode, row?.closing ?? false, view.sample);
  const title: readonly TitlePart[] = running
    ? runningTitle(running)
    : finished
      ? [{ text: finished.awaiting ? 'Closed. The exit price is on its way.' : finished.called, mono: false }]
      : slideTitle(slide);
  // An answer that was not a trade is shown on the slide it was asked from.
  const outcome =
    ticket.outcome && ticket.outcome.asset === slide.asset && (ticket.outcome.seconds === null || ticket.outcome.seconds === slide.seconds)
      ? ticket.outcome
      : null;
  const railAcross = box !== null && box.h < 250;

  return (
    <>
      <Backdrop tone={tone} />
      <Header
        base={slide.base}
        seconds={shown ? shown.seconds : slide.seconds}
        badge={badge}
        // `signal` for a trade that is running, and for the sample's label, as every demo label in the app is.
        badgeTone={(row && !row.closing) || badge === 'SAMPLE' ? 'signal' : 'neutral'}
        trade={shown}
        title={title}
        compact={compact}
      />

      <View className={cx('flex-row flex-wrap items-end gap-x-3 gap-y-1 px-5', compact ? 'mt-2' : 'mt-4')}>
        {finished ? (
          <>
            <View className="flex-row items-baseline gap-2">
              <Num className="font-mono-medium text-24 tracking-t25">{finished.entry}</Num>
              <Icon name="arrow-right" size={16} color="ash" />
              <Num className={cx('font-mono-medium text-24 tracking-t25', finished.awaiting && 'text-13 text-ash')}>{finished.exit}</Num>
            </View>
            {finished.move ? (
              <View className="pb-1">
                <MoveMark move={finished.move} large />
              </View>
            ) : null}
          </>
        ) : (
          <>
            {/* With a trade running the countdown below is the largest figure, so the price steps down a size. */}
            <Num className={cx('font-mono-medium tracking-t30', running || compact ? 'text-26' : 'text-32')}>
              {pair ? formatTimedPrice(pair.price) : '—'}
            </Num>
            {running ? (
              live ? (
                <View className="flex-row items-center gap-1.5 pb-1">
                  <MoveMark move={live.move} large />
                  <Label>from entry</Label>
                </View>
              ) : null
            ) : pair && pair.changeBps !== null ? (
              <View className="pb-1.5">
                <Move text={formatBps(Math.abs(pair.changeBps))} direction={direction} suffix="24h" />
              </View>
            ) : null}
          </>
        )}
      </View>

      <View className={cx('mt-2 flex-1', compact ? 'min-h-20' : 'min-h-32')} onLayout={onLayout}>
        {box && geometry && closes.length > 1 ? (
          <ReelChart
            geometry={geometry}
            width={box.w}
            height={box.h}
            plotRight={plotRight}
            tone={tone ?? 'bone'}
            uid={slide.id.replace(/[^a-zA-Z0-9]/g, '')}
            levelText={shown ? `ENTRY ${formatTimedPrice(shown.entryPrice)}` : undefined}
          />
        ) : (
          <ChartPlaceholder text={loading ? 'Loading the price line' : 'No price line to draw yet'} />
        )}
        {/* A line too short for a column of two goes horizontal, on the bottom edge. */}
        <View className="absolute bottom-1 right-3">
          <Rail
            horizontal={railAcross}
            running={ticket.running.length}
            onRunning={() => onTrades('running')}
            onHistory={() => onTrades('history')}
          />
        </View>
        {outcome ? (
          // Over the foot of the line, clear of the rail: the answer is in view without moving what is under the thumb.
          <View className="absolute left-5" style={{ right: railAcross ? 20 : RAIL_COLUMN + 12, bottom: railAcross ? 56 : 8 }}>
            <OutcomeBlock outcome={outcome} onDismiss={ticket.dismiss} />
          </View>
        ) : hint && !compact ? (
          <SwipeHint />
        ) : null}
      </View>

      {running && row ? (
        <RunningFoot slide={slide} trade={running} row={row} due={due} ticket={ticket} active={active} compact={compact} />
      ) : ended ? (
        <EndedFoot trade={ended} ticket={ticket} onDetails={onDetails} compact={compact} />
      ) : mode.kind === 'held' ? (
        <HeldFoot line={mode.line} view={view} compact={compact} />
      ) : (
        <ActionsFoot slide={slide} view={view} ticket={ticket} compact={compact} />
      )}
    </>
  );
}
