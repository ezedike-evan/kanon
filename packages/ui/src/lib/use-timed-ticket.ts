import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHaptics } from '../platform';
import { useKanonSelector } from './data';
import { useSession, useTimedState } from './domains';
import {
  OVERDUE_RECHECKS,
  TIMED_CLOSE_UNREAD,
  TIMED_OPEN_UNREAD,
  closeOutcomeView,
  finishedTrades,
  justEnded,
  openOutcomeView,
  runningSignature,
  runningTrades,
  stateRecheck,
  timedView,
  tradeFromOpened,
  watchRunning,
  withOpened,
  type TimedOutcomeView,
  type TimedView,
} from './timed-trade';
import type {
  TimedCloseResult,
  TimedOpenResult,
  TimedRequest,
  TimedSending,
  TimedState,
  TimedTrade,
  TimedTradesState,
} from './timed-types';

/** The longest the screen stays locked after an answer, waiting on the state read that follows it. */
const SETTLE_LIMIT_MS = 10_000;
/** A trade known only from its answer is forgotten this long after it was due, if its row never arrived. */
const ANSWER_ONLY_LIMIT_MS = 30_000;

const NO_TRADES: readonly TimedTrade[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/** What the trade list is doing. `unread` is the list having thrown: trades can still be opened. */
export type TimedTradesStatus = 'loading' | 'ready' | 'empty' | 'unread';

/**
 * Predict's state, held once by the screen and drawn by every slide of the
 * reel, the sheets and the desktop's panels: one read of what can be traded,
 * one stake carried from slide to slide, and one request in flight. A
 * component only draws what this returns and calls what it offers.
 *
 * The pair and the time are not held here. They are the slide's: a slide is a
 * pair and a time, and the one in view is the one a press is about.
 */
export interface TimedTicket {
  /** What can be traded, as the server last said it. A slide reads its own pair and time out of this (`timedView`). */
  state: TimedState;
  /**
   * What the reel's slides are built from: `state`, except that when a read
   * fails after one has succeeded it stays the last one that did. A slide with
   * a trade running on it then keeps its place, with its actions off and the
   * reason said, instead of the whole reel vanishing under a countdown.
   */
  listed: TimedState;
  /**
   * The same with no pair in mind: whether trading is available and why not,
   * whose account it is, and the stakes on offer with the one in force.
   */
  base: TimedView;
  /** The stake the person picked, or null while they have picked none. It is kept as the reel moves on. */
  stake: number | null;
  /** What can be traded is being read again. The last answer stays on screen meanwhile. */
  refreshing: boolean;
  /** Somebody is signed in, so there is something to read again. */
  canRefresh: boolean;
  refresh(): void;
  chooseStake(stakeUsd: number): void;
  /** A request is out and has not answered. */
  sending: TimedSending;
  /**
   * Nothing can be sent: a request is out, or one has answered and the state
   * has not been read since. The second half is what stops a press meant for
   * the trade that just opened from opening another.
   */
  locked: boolean;
  /** The last answer that was not a trade, shown on the slide it was asked from until the next request or `dismiss()`. */
  outcome: TimedOutcomeView | null;
  dismiss(): void;
  /**
   * Opens the trade a slide's press asks for. One press, no prompt. Does
   * nothing for no request (the slide is held) or while something is out.
   */
  open(request: TimedRequest | null): void;
  /** Asks the server to end one of the caller's running trades now. */
  end(tradeId: string): void;
  /** Trades the server took a request to end, until their own rows say they are closing. */
  asked: ReadonlySet<string>;
  /** Running trades, the soonest to end first. */
  running: readonly TimedTrade[];
  /** Trades that ended while this screen was looking, the latest first. Drawn where they ran. */
  ended: readonly TimedTrade[];
  dismissEnded(tradeId: string): void;
  /** Every finished trade, the latest first. */
  history: readonly TimedTrade[];
  tradesStatus: TimedTradesStatus;
  /** Hands in the caller's trades as the list changes, or `null` when it could not be read. */
  followTrades(state: TimedTradesState | null): void;
}

type Answer =
  | { kind: 'open'; result: TimedOpenResult; request: TimedRequest }
  | { kind: 'close'; result: TimedCloseResult; trade: TimedTrade };

export function useTimedTicket(): TimedTicket {
  const read = useTimedState();
  const session = useSession();
  const openTimedTrade = useKanonSelector((s) => s.openTimedTrade);
  const closeTimedTrade = useKanonSelector((s) => s.closeTimedTrade);
  const { success, refusal, tap } = useHaptics();
  const { state, refreshing, refresh } = read;

  // The stake the person picked. What is in force is on a view: a pick the server no longer
  // offers falls back to one it does.
  const [stake, setStake] = useState<number | null>(null);
  const [sending, setSending] = useState<TimedSending>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  /** A request has answered and the state read that follows it is still out. */
  const [settling, setSettling] = useState(false);
  /** Trades known from the answer to an open, until their rows land. */
  const [opened, setOpened] = useState<readonly TimedTrade[]>(NO_TRADES);
  const [asked, setAsked] = useState<ReadonlySet<string>>(NO_IDS);
  const [list, setList] = useState<TimedTradesState | null>({ status: 'loading' });
  const [watched, setWatched] = useState<ReadonlySet<string>>(NO_IDS);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(NO_IDS);

  const base = useMemo(() => timedView(state, { asset: null, stakeUsd: stake, seconds: null }), [state, stake]);
  const network = state.status === 'ready' ? state.network : 'testnet';
  const canRefresh = session.signedIn && !session.pending;

  // The last state that listed anything, kept for as long as somebody is signed in.
  // The signed-out sample is never kept: it is no server's answer to fall back on.
  const [lastReady, setLastReady] = useState<TimedState | null>(null);
  useEffect(() => {
    if (state.status === 'ready' && !state.sample) setLastReady(state);
    else if (!canRefresh) setLastReady(null);
  }, [state, canRefresh]);
  const listed = state.status === 'unavailable' && canRefresh && lastReady ? lastReady : state;

  const rows = list?.status === 'ready' ? list.trades : NO_TRADES;
  const trades = useMemo(() => opened.reduce<readonly TimedTrade[]>(withOpened, rows), [rows, opened]);
  const running = useMemo(() => runningTrades(trades), [trades]);
  const history = useMemo(() => finishedTrades(trades), [trades]);
  const ended = useMemo(() => justEnded(trades, watched, dismissed), [trades, watched, dismissed]);
  const tradesStatus: TimedTradesStatus =
    list === null ? 'unread' : trades.length > 0 ? 'ready' : list.status === 'loading' ? 'loading' : 'empty';

  // A trade seen running is remembered, so its ending is shown where it ran.
  useEffect(() => {
    setWatched((seen) => watchRunning(seen, trades));
  }, [trades]);

  // An ending is felt as it lands. Light: it is the timer doing what it said, not an alarm.
  const endedCount = useRef(0);
  useEffect(() => {
    if (ended.length > endedCount.current) tap();
    endedCount.current = ended.length;
  }, [ended.length, tap]);

  // A trade drawn from its answer gives way to its row. If the row never comes, it is let go
  // once it is well past due, so a list that cannot be read never leaves a countdown stuck at zero.
  useEffect(() => {
    if (opened.length === 0) return undefined;
    const waiting = opened.filter((trade) => !rows.some((row) => row.id === trade.id));
    if (waiting.length !== opened.length) {
      setOpened(waiting);
      return undefined;
    }
    const soonest = Math.min(...opened.map((trade) => trade.expiresAt)) + ANSWER_ONLY_LIMIT_MS;
    const timer = setTimeout(
      () => setOpened((held) => held.filter((trade) => trade.expiresAt + ANSWER_ONLY_LIMIT_MS > Date.now())),
      Math.max(0, soonest - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [opened, rows]);

  // A request to end is forgotten once the trade's own row says what became of it.
  useEffect(() => {
    if (asked.size === 0) return;
    const still = [...asked].filter((id) => trades.some((trade) => trade.id === id && trade.status === 'live'));
    if (still.length !== asked.size) setAsked(new Set(still));
  }, [asked, trades]);

  // The state is read again when one of the caller's own trades starts closing or closes: a market
  // was freed. Not when the list first loads, which is the list arriving and not anything changing.
  const signature = runningSignature(rows);
  const loaded = list !== null && list.status !== 'loading';
  const previous = useRef<{ signature: string; loaded: boolean } | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = { signature, loaded };
    if (before?.loaded && loaded && before.signature !== signature) refresh();
  }, [signature, loaded, refresh]);

  // And just after a trade holding a market is due to end, whoever opened it: everyone shares the
  // account, so a market can be freed by a trade this screen never lists. A market still held past
  // its time is read again a few times, then left to the slow interval.
  const overdueReads = useRef(0);
  useEffect(() => {
    const recheck = stateRecheck(state, Date.now());
    if (!recheck) {
      overdueReads.current = 0;
      return undefined;
    }
    if (recheck.overdue) {
      if (overdueReads.current >= OVERDUE_RECHECKS) return undefined;
      overdueReads.current += 1;
    } else {
      overdueReads.current = 0;
    }
    const timer = setTimeout(refresh, recheck.delayMs);
    return () => clearTimeout(timer);
  }, [state, refresh]);

  // The source reads the state again as a request returns, so `refreshing` is already true by the
  // render that shows the answer. A source that reads nothing clears this at once, and a read that
  // never lands does not hold the screen shut for good.
  useEffect(() => {
    if (!settling) return undefined;
    if (!refreshing) {
      setSettling(false);
      return undefined;
    }
    const timer = setTimeout(() => setSettling(false), SETTLE_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [settling, refreshing]);

  const locked = sending !== null || settling;
  // Refs as well as state: two presses in one frame both read the state as it was.
  const busy = useRef(false);
  busy.current = locked;

  const open = useCallback(
    (request: TimedRequest | null) => {
      if (!request || busy.current) return;
      busy.current = true;
      setSending({ action: 'open', ...request });
      setAnswer(null);
      void (async () => {
        let result: TimedOpenResult;
        try {
          result = await openTimedTrade(request);
        } catch {
          // The source promises a value. One that breaks the promise is still not an unhandled rejection.
          result = { status: 'unavailable', message: TIMED_OPEN_UNREAD };
        }
        setSending(null);
        setSettling(true);
        if (result.status === 'opened') {
          const trade = tradeFromOpened(result.trade, network);
          setOpened((held) => [trade, ...held.filter((other) => other.id !== trade.id)]);
          success();
          return;
        }
        setAnswer({ kind: 'open', result, request });
        // A refusal is felt before it is read, as everywhere else. It is an answer, not a fault.
        if (result.status === 'refused') refusal();
      })();
    },
    [network, openTimedTrade, success, refusal],
  );

  const end = useCallback(
    (tradeId: string) => {
      const trade = running.find((candidate) => candidate.id === tradeId);
      if (!trade || busy.current) return;
      busy.current = true;
      setSending({ action: 'close', tradeId });
      setAnswer(null);
      void (async () => {
        let result: TimedCloseResult;
        try {
          result = await closeTimedTrade(tradeId);
        } catch {
          result = { status: 'unavailable', message: TIMED_CLOSE_UNREAD };
        }
        setSending(null);
        setSettling(true);
        if (result.status === 'closing') {
          setAsked((ids) => new Set(ids).add(tradeId));
          return;
        }
        setAnswer({ kind: 'close', result, trade });
        if (result.status === 'refused') refusal();
      })();
    },
    [running, closeTimedTrade, refusal],
  );

  const outcome = useMemo(
    () =>
      answer === null
        ? null
        : answer.kind === 'open'
          ? openOutcomeView(answer.result, answer.request)
          : closeOutcomeView(answer.result, answer.trade),
    [answer],
  );

  const dismiss = useCallback(() => setAnswer(null), []);
  const dismissEnded = useCallback((tradeId: string) => setDismissed((ids) => new Set(ids).add(tradeId)), []);
  const followTrades = useCallback((next: TimedTradesState | null) => setList(next), []);

  return useMemo<TimedTicket>(
    () => ({
      state,
      listed,
      base,
      stake,
      refreshing,
      canRefresh,
      refresh,
      chooseStake: setStake,
      sending,
      locked,
      outcome,
      dismiss,
      open,
      end,
      asked,
      running,
      ended,
      dismissEnded,
      history,
      tradesStatus,
      followTrades,
    }),
    [
      state,
      listed,
      base,
      stake,
      refreshing,
      canRefresh,
      refresh,
      sending,
      locked,
      outcome,
      dismiss,
      open,
      end,
      asked,
      running,
      ended,
      dismissEnded,
      history,
      tradesStatus,
      followTrades,
    ],
  );
}
