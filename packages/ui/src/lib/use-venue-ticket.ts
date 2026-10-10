import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHaptics } from '../platform';
import { useKanonSelector } from './data';
import { useSession, useVenueAccount } from './domains';
import { ORDER_UNREAD, outcomeView, ticketView, type OutcomeView, type TicketView } from './venue-trade';
import type { TicketSending, VenueNetwork, VenueOrderResult, VenueSide } from './venue-types';

/** The longest a ticket stays locked after an answer, waiting on the account read that follows it. */
const SETTLE_LIMIT_MS = 10_000;

/**
 * The order ticket's state, held once per chart and drawn twice: the desktop
 * panel and the phone's bar and sheet are one tree, so they share one account
 * read, one choice of size and leverage, and one order in flight. A ticket
 * component only renders what this returns and calls what it offers.
 */
export interface VenueTicket {
  /** The asset on the chart. Every order placed here is for it. */
  asset: string;
  /** What to draw: the limits in force, the sizes and leverages offered, the open position, the hold. */
  view: TicketView;
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
  /** Opens a position on `side` at the size and leverage in force. Does nothing while the ticket holds. */
  open(side: VenueSide): void;
  /** Closes the whole of the open position on this asset. */
  close(): void;
  dismiss(): void;
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
  const [outcome, setOutcome] = useState<OutcomeView | null>(null);
  /** An order has answered and the account read that follows it is still out. */
  const [settling, setSettling] = useState(false);

  const view = useMemo(
    () => ticketView(account.state, asset, { usd: wantedUsd, leverage: wantedLeverage }),
    [account.state, asset, wantedUsd, wantedLeverage],
  );

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
      setOutcome(null);
      let result: VenueOrderResult;
      try {
        result = await call();
      } catch {
        // The source promises a value. One that breaks the promise is still not an unhandled rejection.
        result = { status: 'unavailable', message: ORDER_UNREAD };
      }
      setSending(null);
      setSettling(true);
      setOutcome(outcomeView(result, context));
      // A refusal is felt before it is read, as everywhere else. It is an answer, not a fault.
      if (result.status === 'filled') success();
      else if (result.status === 'refused') refusal();
    },
    [success, refusal],
  );

  const open = useCallback(
    (side: VenueSide) => {
      const { usd, leverage, network } = view;
      if (view.hold !== null || usd === null || leverage === null || network === null) return;
      void send({ action: 'open', side }, () => placeVenueOrder({ asset, side, usd, leverage }), { asset, network });
    },
    [view, asset, send, placeVenueOrder],
  );

  const close = useCallback(() => {
    const { position, network } = view;
    if (!position || network === null) return;
    void send({ action: 'close' }, () => closeVenuePosition(position.asset), { asset: position.asset, network });
  }, [view, send, closeVenuePosition]);

  const dismiss = useCallback(() => setOutcome(null), []);
  const canRefresh = session.signedIn && !session.pending;

  return useMemo<VenueTicket>(
    () => ({
      asset,
      view,
      refreshing: account.refreshing,
      canRefresh,
      refresh: account.refresh,
      chooseUsd: setWantedUsd,
      chooseLeverage: setWantedLeverage,
      sending,
      locked,
      outcome,
      open,
      close,
      dismiss,
    }),
    [asset, view, account.refreshing, account.refresh, canRefresh, sending, locked, outcome, open, close, dismiss],
  );
}
