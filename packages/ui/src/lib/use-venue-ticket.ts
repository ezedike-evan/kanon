import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHaptics } from '../platform';
import { useKanonSelector } from './data';
import { useSession, useVenueAccount } from './domains';
import {
  ORDER_UNREAD,
  completeFill,
  fillAwaitsFigures,
  outcomeView,
  positionOf,
  sideHold,
  ticketView,
  type OutcomeView,
  type TicketView,
} from './venue-trade';
import type {
  TicketSending,
  VenueNetwork,
  VenueOrder,
  VenueOrderResult,
  VenuePositionView,
  VenueSide,
} from './venue-types';

/** The longest a ticket stays locked after an answer, waiting on the account read that follows it. */
const SETTLE_LIMIT_MS = 10_000;

const NO_POSITIONS: readonly VenuePositionView[] = [];

/**
 * The order ticket's state, held once per chart and drawn twice: the desktop
 * panel and the phone's bar and sheet are one tree, so they share one account
 * read, one choice of size and leverage, and one order in flight. A ticket
 * component only renders what this returns and calls what it offers.
 */
export interface VenueTicket {
  /** The asset on the chart. Every order opened here is for it. */
  asset: string;
  /** What to draw: the limits in force, the sizes and leverages offered, the open position, the hold. */
  view: TicketView;
  /** Every position open on the shared account, on any market. Empty until the account is read. */
  positions: readonly VenuePositionView[];
  /** The account is being read again. The last answer stays on screen meanwhile. */
  refreshing: boolean;
  /** Somebody is signed in, so there is an account to read again. */
  canRefresh: boolean;
  refresh(): void;
  chooseUsd(usd: number): void;
  chooseLeverage(leverage: number): void;
  /** An order is out and has not answered. */
  sending: TicketSending;
  /**
   * Nothing can be sent: an order is out, or one has answered and the account
   * has not been read since. The second half is what stops a press meant for
   * the order that just went from landing on whatever replaced its button.
   */
  locked: boolean;
  /** The last order's answer, shown in place until the next order or `dismiss()`. */
  outcome: OutcomeView | null;
  /**
   * The id of the order whose answer is showing as a fill the venue has not
   * finished reporting (no price, fee, block or transaction yet). Null
   * otherwise. Whatever follows the caller's orders does so only while this is
   * set, and hands the rows to `followFill`.
   */
  awaitingFill: string | null;
  /** Puts into the answer on screen whatever its order's row has gained. Does nothing when the rows add nothing. */
  followFill(orders: readonly VenueOrder[]): void;
  /**
   * Sends an order on `side` at the size and leverage in force: an open, or an
   * add when the account already holds that side here. Does nothing while the
   * ticket holds that side.
   */
  open(side: VenueSide): void;
  /** Closes the whole of the open position on the chart's asset. */
  close(): void;
  /**
   * Closes the whole of the account's position on any market. It goes through
   * the same one-order-at-a-time state as every other order, and its answer is
   * shown where the ticket shows answers.
   */
  closeAsset(asset: string): void;
  dismiss(): void;
}

/** An answer and what the request knew that the answer does not repeat. Kept whole, so a fill can gain its figures. */
interface Answer {
  result: VenueOrderResult;
  context: { asset: string; network: VenueNetwork };
}

export function useVenueTicket(asset: string): VenueTicket {
  const account = useVenueAccount();
  const session = useSession();
  const placeVenueOrder = useKanonSelector((s) => s.placeVenueOrder);
  const closeVenuePosition = useKanonSelector((s) => s.closeVenuePosition);
  const { success, refusal } = useHaptics();

  // What the person picked. What is in force is `view.usd` / `view.leverage`: a pick the
  // limits or the market no longer offer falls back to one they do.
  const [wantedUsd, setWantedUsd] = useState<number | null>(null);
  const [wantedLeverage, setWantedLeverage] = useState<number | null>(null);
  const [sending, setSending] = useState<TicketSending>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  /** An order has answered and the account read that follows it is still out. */
  const [settling, setSettling] = useState(false);

  const view = useMemo(
    () => ticketView(account.state, asset, { usd: wantedUsd, leverage: wantedLeverage }),
    [account.state, asset, wantedUsd, wantedLeverage],
  );
  const positions = account.state.status === 'ready' ? account.state.positions : NO_POSITIONS;
  const outcome = useMemo(() => (answer ? outcomeView(answer.result, answer.context) : null), [answer]);
  const awaitingFill =
    answer && answer.result.status === 'filled' && fillAwaitsFigures(answer.result) ? answer.result.orderId : null;

  // The source reads the account again as an order returns, so `refreshing` is already true
  // by the render that shows the answer. A source that reads nothing clears this at once, and
  // a read that never lands does not hold the ticket shut for good.
  useEffect(() => {
    if (!settling) return undefined;
    if (!account.refreshing) {
      setSettling(false);
      return undefined;
    }
    const timer = setTimeout(() => setSettling(false), SETTLE_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [settling, account.refreshing]);

  const locked = sending !== null || settling;
  // Refs as well as state: two presses in one frame both read the state as it was.
  const busy = useRef(false);
  busy.current = locked;

  const send = useCallback(
    async (
      what: Exclude<TicketSending, null>,
      call: () => Promise<VenueOrderResult>,
      context: { asset: string; network: VenueNetwork },
    ) => {
      if (busy.current) return;
      busy.current = true;
      setSending(what);
      setAnswer(null);
      let result: VenueOrderResult;
      try {
        result = await call();
      } catch {
        // The source promises a value. One that breaks the promise is still not an unhandled rejection.
        result = { status: 'unavailable', message: ORDER_UNREAD };
      }
      setSending(null);
      setSettling(true);
      setAnswer({ result, context });
      // A refusal is felt before it is read, as everywhere else. It is an answer, not a fault.
      if (result.status === 'filled') success();
      else if (result.status === 'refused') refusal();
    },
    [success, refusal],
  );

  const open = useCallback(
    (side: VenueSide) => {
      const { usd, leverage, network } = view;
      // The other side of an open position, a size past the position limit, a leverage that is
      // not the position's: none of them leaves this ticket, since the server would refuse each.
      if (sideHold(view, side) !== null || usd === null || leverage === null || network === null) return;
      void send({ action: 'open', side }, () => placeVenueOrder({ asset, side, usd, leverage }), { asset, network });
    },
    [view, asset, send, placeVenueOrder],
  );

  const closeAsset = useCallback(
    (target: string) => {
      const state = account.state;
      if (state.status !== 'ready') return;
      const position = positionOf(state, target);
      if (!position) return;
      void send({ action: 'close', asset: position.asset }, () => closeVenuePosition(position.asset), {
        asset: position.asset,
        network: state.network,
      });
    },
    [account.state, send, closeVenuePosition],
  );

  const close = useCallback(() => closeAsset(asset), [closeAsset, asset]);

  const followFill = useCallback((orders: readonly VenueOrder[]) => {
    setAnswer((shown) => {
      if (!shown) return shown;
      const result = completeFill(shown.result, orders);
      // The same object means the rows added nothing: no new state, so no render.
      return result === shown.result ? shown : { ...shown, result };
    });
  }, []);

  const dismiss = useCallback(() => setAnswer(null), []);
  const canRefresh = session.signedIn && !session.pending;

  return useMemo<VenueTicket>(
    () => ({
      asset,
      view,
      positions,
      refreshing: account.refreshing,
      canRefresh,
      refresh: account.refresh,
      chooseUsd: setWantedUsd,
      chooseLeverage: setWantedLeverage,
      sending,
      locked,
      outcome,
      awaitingFill,
      followFill,
      open,
      close,
      closeAsset,
      dismiss,
    }),
    [
      asset,
      view,
      positions,
      account.refreshing,
      account.refresh,
      canRefresh,
      sending,
      locked,
      outcome,
      awaitingFill,
      followFill,
      open,
      close,
      closeAsset,
      dismiss,
    ],
  );
}
