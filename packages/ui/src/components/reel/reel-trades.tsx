import { Component, memo, useEffect, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { cx } from '../../lib/cx';
import { useTicker, useTimedTrades } from '../../lib/domains';
import { relativeTime } from '../../lib/home-format';
import { CUT_NOTE, accountNote, countdownText, finishedDetail, finishedView, liveMove, runningView } from '../../lib/timed-trade';
import type { TimedSending, TimedTrade, TimedTradesState } from '../../lib/timed-types';
import { useCountdownClock, useDue } from '../../lib/use-clock';
import { useNowMs } from '../../lib/use-now';
import type { TimedTicket, TimedTradesStatus } from '../../lib/use-timed-ticket';
import { useHaptics } from '../../platform';
import { AutopilotEvidenceLink, AutopilotEvidenceRow, AutopilotMark } from '../autopilot';
import { Badge } from '../badge';
import { BottomSheet } from '../bottom-sheet';
import { EmptyState } from '../empty-state';
import { Icon } from '../icons';
import { SectionHeader } from '../section-header';
import { SegmentedControl } from '../segmented-control';
import { Skeleton } from '../skeleton';
import { Num } from '../ui';
import type { TradesTab } from './reel-page';
import { DirectionMark, FOCUS, Facts, MoveMark, TxLink, TxMissing } from './trade-parts';

/*
 * The caller's trades beside the reel: what is running, what has finished, and
 * the detail of one. A slide shows the trade on its own pair; this is where the
 * ones on other pairs are, one press from any slide (the rail), and always in
 * view on a wide desktop (the right panel).
 *
 * A trade the person's rule opened on autopilot is among them, and says so: its
 * mark is the way to the proposal that is its evidence, one press from a running
 * row and one from a finished trade's details.
 *
 * A running row is the trade's countdown and how far the price is from its
 * entry, with its own "End now"; a press on it goes to its slide. A finished
 * row says what was called, how the trade ended and what the price did. Neither
 * carries money. A press on a finished row opens the detail, a bottom sheet,
 * which is the one place a trade's result is stated: a row in a table of its
 * figures, in the same neutral type as the rest, above the two transactions
 * that are its evidence.
 */

/* -------------------------------------------------------------------------- */
/* The subscription                                                            */
/* -------------------------------------------------------------------------- */

interface FeedProps {
  /** The caller's trades each time the list changes, or null when it could not be read. */
  onTrades: (state: TimedTradesState | null) => void;
}

function Subscription({ onTrades }: FeedProps) {
  const state = useTimedTrades();
  useEffect(() => {
    onTrades(state);
  }, [state, onTrades]);
  return null;
}

/**
 * The trade list is a query, and a query the server cannot answer throws while
 * it renders. That must not take the screen with it: a trade can still be
 * opened, and its countdown is drawn from the answer to the open.
 */
class Boundary extends Component<FeedProps & { children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onTrades(null);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Predict's subscription to the caller's own trades. It draws nothing, and lives exactly as long as the screen does. */
export function TimedTradesFeed({ onTrades }: FeedProps) {
  return (
    <Boundary onTrades={onTrades}>
      <Subscription onTrades={onTrades} />
    </Boundary>
  );
}

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

/** The time a trade has left, as digits, on its own clock. */
function RowCountdown({ expiresAt }: { expiresAt: number }) {
  const now = useCountdownClock(expiresAt);
  const text = countdownText(expiresAt, now);
  return (
    <Text
      role="timer"
      aria-label={`Time left ${text}`}
      className="font-mono-medium text-15 tracking-t20 text-bone"
      style={{ fontVariant: ['tabular-nums'] }}
    >
      {text}
    </Text>
  );
}

const RunningRow = memo(function RunningRow({
  trade,
  sending,
  locked,
  asked,
  last,
  onEnd,
  onGo,
}: {
  trade: TimedTrade;
  sending: TimedSending;
  locked: boolean;
  /** The server took a request to end this trade. */
  asked: boolean;
  last: boolean;
  onEnd: (tradeId: string) => void;
  /** Shows the trade's slide. */
  onGo: (trade: TimedTrade) => void;
}) {
  const { tap } = useHaptics();
  const due = useDue(trade.expiresAt);
  const ticker = useTicker(trade.asset);
  const price = ticker.status === 'ready' || ticker.status === 'demo' ? ticker.ticker.price : null;
  const row = runningView(trade, { due, sending, locked, asked });
  const live = liveMove(trade, price);
  return (
    <View className={cx('min-h-14 flex-row items-center gap-3 pl-3.5 pr-2.5', !last && 'border-b border-hairline')}>
      <View className="min-w-0 flex-1 self-stretch">
        <Pressable
          role="button"
          aria-label={`Go to the ${row.asset} slide. ${row.word}, ${row.terms}, ${row.label.toLowerCase()}${trade.origin === 'autopilot' ? ', opened by autopilot' : ''}`}
          onPress={() => onGo(trade)}
          className={cx('grow justify-center gap-1.5 py-2.5 hover:opacity-80 active:opacity-70', FOCUS)}
        >
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
            <DirectionMark direction={row.direction} />
            <Text className="font-mono-medium text-12 text-bone">{row.asset}</Text>
            <Num className="text-11 text-ash">{row.terms}</Num>
          </View>
          <View className="flex-row flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <RowCountdown expiresAt={trade.expiresAt} />
            {live ? <MoveMark move={live.move} /> : <Num className="text-11 text-ash">Reading the price</Num>}
          </View>
        </Pressable>
        {/* Its own press, under the row's: the proposal the rule passed is this trade's evidence. */}
        {trade.origin === 'autopilot' ? (
          trade.proposalId ? (
            <AutopilotEvidenceLink proposalId={trade.proposalId} className="mb-2" />
          ) : (
            <AutopilotMark className="mb-2.5 self-start" />
          )
        ) : null}
      </View>
      <Pressable
        role="button"
        aria-label={row.end.accessibilityLabel}
        aria-busy={row.end.label === 'ENDING…'}
        disabled={row.end.disabled}
        onPressIn={tap}
        onPress={() => onEnd(trade.id)}
        className={cx(
          'h-9 min-w-[88px] shrink-0 items-center justify-center rounded-xs border border-bone px-2.5 hover:bg-bone/10 active:bg-bone/15',
          row.end.disabled && 'opacity-40',
          FOCUS,
        )}
      >
        <Text className="font-mono-bold text-11 tracking-w14 text-bone">{row.end.label}</Text>
      </Pressable>
    </View>
  );
});

/**
 * The caller's running trades, the soonest to end first, in one ruled block.
 * With none it says so in a line: nothing running is a state, not a gap.
 */
export const RunningList = memo(function RunningList({
  ticket,
  onGo,
  bare,
  className,
}: {
  ticket: TimedTicket;
  onGo: (trade: TimedTrade) => void;
  /** No heading: the tab or the panel above already names it. */
  bare?: boolean;
  className?: string | undefined;
}) {
  const { running } = ticket;
  return (
    <View {...(className ? { className } : {})}>
      {bare ? null : <SectionHeader title="Running" {...(running.length > 0 ? { count: running.length } : {})} className="pb-3" />}
      {running.length > 0 ? (
        <View className="rounded-sm border border-hairline bg-panel">
          {running.map((trade, i) => (
            <RunningRow
              key={trade.id}
              trade={trade}
              sending={ticket.sending}
              locked={ticket.locked}
              asked={ticket.asked.has(trade.id)}
              last={i === running.length - 1}
              onEnd={ticket.end}
              onGo={onGo}
            />
          ))}
        </View>
      ) : (
        <Text className="font-sans text-13 leading-5 text-ash">
          Nothing is running. A trade you open counts down here, and on every slide of its pair.
        </Text>
      )}
    </View>
  );
});

/** The three things every timed trade is held to, said once where the trades are listed. */
export function TradeRules({ ticket, className }: { ticket: TimedTicket; className?: string | undefined }) {
  return (
    <View className={cx('gap-1', className)}>
      <Text className="font-sans text-12 leading-[18px] text-ash">{accountNote(ticket.base.network)}</Text>
      <Text className="font-sans text-12 leading-[18px] text-ash">{CUT_NOTE}</Text>
      <Text className="font-sans text-12 leading-[18px] text-ash">A market takes one timed trade at a time.</Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Finished                                                                    */
/* -------------------------------------------------------------------------- */

const HistoryRow = memo(function HistoryRow({
  trade,
  now,
  last,
  onOpen,
}: {
  trade: TimedTrade;
  now: number;
  last: boolean;
  onOpen: (tradeId: string) => void;
}) {
  const view = finishedView(trade);
  return (
    <Pressable
      role="button"
      aria-label={trade.origin === 'autopilot' ? `Opened by autopilot. ${view.accessibilityLabel}` : view.accessibilityLabel}
      onPress={() => onOpen(trade.id)}
      className={cx(
        'min-h-14 justify-center gap-1.5 px-3.5 py-2.5 hover:bg-raised/60 active:bg-raised',
        !last && 'border-b border-hairline',
        FOCUS,
      )}
    >
      <View className="flex-row items-center justify-between gap-2">
        <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
          <DirectionMark direction={view.direction} />
          <Text className="font-mono-medium text-12 text-bone">{view.asset}</Text>
          <Num className="text-11 text-ash">{view.terms}</Num>
          {/* The row opens the details, where the way to its evidence is. */}
          {trade.origin === 'autopilot' ? <AutopilotMark label="Autopilot" /> : null}
        </View>
        <Badge label={view.ended} className="self-center" />
      </View>
      <View className="flex-row items-center justify-between gap-2">
        <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
          <View className="flex-row items-center gap-1.5">
            <Num className="text-12">{view.entry}</Num>
            <Icon name="arrow-right" size={12} color="ash" />
            <Num className={cx('text-12', view.awaiting && 'text-ash')}>{view.exit}</Num>
          </View>
          {view.move ? <MoveMark move={view.move} /> : null}
        </View>
        <View className="flex-row items-center gap-1">
          <Num className="text-10 text-ash">{relativeTime(view.at, now)}</Num>
          <Icon name="chevron-right" size={12} color="ash" />
        </View>
      </View>
    </Pressable>
  );
});

/**
 * Every finished trade, the latest first, in one ruled block. Loading draws the
 * shape of a row; an empty list says what will fill it; a list that could not
 * be read says so and that trading is not affected.
 */
export const History = memo(function History({
  trades,
  status,
  onOpen,
  bare,
  className,
}: {
  trades: readonly TimedTrade[];
  status: TimedTradesStatus;
  onOpen: (tradeId: string) => void;
  /** No heading: the tab above already names it. */
  bare?: boolean;
  className?: string | undefined;
}) {
  const now = useNowMs();
  return (
    <View {...(className ? { className } : {})}>
      {bare ? null : <SectionHeader title="History" {...(trades.length > 0 ? { count: trades.length } : {})} className="pb-3" />}
      {trades.length > 0 ? (
        <View className="rounded-sm border border-hairline bg-panel">
          {trades.map((trade, i) => (
            <HistoryRow key={trade.id} trade={trade} now={now} last={i === trades.length - 1} onOpen={onOpen} />
          ))}
        </View>
      ) : status === 'loading' ? (
        <View aria-busy aria-label="Loading your trades" className="rounded-sm border border-hairline bg-panel">
          {[0, 1].map((i) => (
            <View key={i} className={cx('min-h-14 justify-center gap-2 px-3.5 py-3', i === 0 && 'border-b border-hairline')}>
              <Skeleton width="55%" height={12} />
              <Skeleton width="75%" height={10} />
            </View>
          ))}
        </View>
      ) : status === 'unread' ? (
        <Text role="status" className="font-sans text-13 leading-5 text-ash">
          Your trades could not be read. Trades can still be opened, and each one counts down on its slide while this screen is open.
        </Text>
      ) : (
        <EmptyState
          icon="history"
          title="No finished trades"
          body="A trade is listed here when it ends, with its entry, its exit and both transactions."
          className="rounded-sm border border-hairline py-8"
        />
      )}
    </View>
  );
});

/* -------------------------------------------------------------------------- */
/* The sheet                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The caller's trades as a bottom sheet, opened from the rail on any slide:
 * what is running, or what has finished, whichever was asked for, and the
 * other one tab away.
 */
export function TradesSheet({
  open,
  tab,
  onTab,
  onClose,
  ticket,
  onGo,
  onDetails,
}: {
  open: boolean;
  tab: TradesTab;
  onTab: (tab: TradesTab) => void;
  onClose: () => void;
  ticket: TimedTicket;
  /** Shows a running trade's slide. */
  onGo: (trade: TimedTrade) => void;
  /** Opens a finished trade's details. */
  onDetails: (tradeId: string) => void;
}) {
  const options = [
    { value: 'running', label: `Running ${ticket.running.length}` },
    { value: 'history', label: `History ${ticket.history.length}` },
  ] as const;
  return (
    <BottomSheet open={open} onClose={onClose} title="YOUR TRADES">
      <View className="gap-4 pb-5">
        <SegmentedControl options={options} value={tab} onChange={onTab} label="Running or finished trades" />
        {tab === 'running' ? (
          <RunningList ticket={ticket} onGo={onGo} bare />
        ) : (
          <History trades={ticket.history} status={ticket.tradesStatus} onOpen={onDetails} bare />
        )}
        <TradeRules ticket={ticket} />
      </View>
    </BottomSheet>
  );
}

/* -------------------------------------------------------------------------- */
/* One trade                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything about one finished trade, as a bottom sheet. The headline is the
 * direction called and what the price did. Its figures follow as a table, the
 * result among them, then the opening and the closing transaction. One the
 * rule opened on autopilot says so first, with the proposal that is its
 * evidence one press away.
 */
export function TradeSheet({ trade, onClose }: { trade: TimedTrade | null; onClose: () => void }) {
  if (!trade) return null;
  const view = finishedView(trade);
  const detail = finishedDetail(trade);
  return (
    <BottomSheet open onClose={onClose} title={`TRADE · ${view.asset}`}>
      <View className="gap-4 pb-5">
        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-3">
            <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-2 gap-y-1">
              <DirectionMark direction={view.direction} large />
              <Num className="text-12 text-ash">{view.terms}</Num>
            </View>
            {/* In the body, not beside the sheet's own CLOSE, where `CLOSED ELSEWHERE` would read as part of it. */}
            <Badge label={view.ended} size="md" className="self-center" />
          </View>
          <View className="flex-row flex-wrap items-baseline gap-x-2">
            <Num className="font-mono-medium text-24 tracking-t25">{view.entry}</Num>
            <Icon name="arrow-right" size={16} color="ash" />
            <Num className={cx('font-mono-medium text-24 tracking-t25', view.awaiting && 'text-13 text-ash')}>{view.exit}</Num>
          </View>
          {view.move ? <MoveMark move={view.move} large /> : null}
          <Text className="font-sans text-15 leading-[22px] text-bone">
            {view.awaiting ? 'The exit price arrives a few seconds after the close.' : view.called}
          </Text>
          <Text className="font-sans text-13 leading-5 text-ash">{view.endedLine}</Text>
        </View>

        {trade.origin === 'autopilot' ? <AutopilotEvidenceRow proposalId={trade.proposalId} /> : null}

        <Facts rows={detail.facts} />

        <View className="rounded-sm border border-hairline bg-panel">
          {detail.openTx ? <TxLink tx={detail.openTx} name="Open" /> : <TxMissing name="Open" />}
          <View className="h-px bg-hairline" />
          {detail.closeTx ? <TxLink tx={detail.closeTx} name="Close" /> : <TxMissing name="Close" />}
        </View>
      </View>
    </BottomSheet>
  );
}
