import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHaptics } from '../platform';
import { useSession, useSpotClient, useSpotMarket } from './domains';
import {
  DEFAULT_SLIPPAGE_BPS,
  SPOT_BOOK_STALE,
  STEP_LINE,
  approvalNeeded,
  failedOutcome,
  filledOutcome,
  mintFailedNote,
  mintedNote,
  orderLine,
  sizeSpotOrder,
  spotGate,
  testMintAmount,
  type SpotGate,
  type SpotMarket,
  type SpotMintNote,
  type SpotOutcomeView,
  type SpotSide,
  type SpotSizing,
  type SpotStep,
  type SpotWallet,
  type SpotWalletRead,
} from './spot';
import { spotFailure } from './spot-client';
import type { SpotMarketState } from './spot-reads';

/** How often the wallet is read again while the screen is open: funds can arrive from elsewhere. */
const WALLET_EVERY_MS = 20_000;

/**
 * The spot screen's state, held once and drawn by the book, the ticket and the
 * confirmation sheet: one read of the market, one read of the wallet, what the
 * person has typed, and one transaction in flight. A component only draws what
 * this returns and calls what it offers. Every decision it surfaces is made in
 * `spot.ts`, where it is tested.
 */
export interface SpotTicket {
  feed: SpotMarketState;
  market: SpotMarket | null;
  /** The newest read of the book failed. What is on screen is the last good one, and orders wait. */
  stale: boolean;
  side: SpotSide;
  chooseSide(side: SpotSide): void;
  amount: string;
  setAmount(text: string): void;
  slippageBps: number;
  chooseSlippage(bps: number): void;
  /** Whether the ticket can take an order, and why not. Null while there is no market to trade. */
  gate: SpotGate | null;
  /** The signing wallet as last read, or null. */
  wallet: SpotWallet | null;
  /** The wallet is being read for the first time: its rows are a skeleton, not an absence. */
  walletLoading: boolean;
  /** The order for what is typed, or the sentence saying why there is none. Null while the gate is not open. */
  sizing: SpotSizing | null;
  /** Whether the order needs an approval first. Null while there is no order. */
  needsApproval: boolean | null;
  /** The one line at the foot: where a transaction has got to, why nothing can be sent, or what the order is. */
  line: string | null;
  /** An order is sized, the book is current and nothing is in flight. */
  canSend: boolean;
  /** Where the order in flight has got to, or null. */
  sending: SpotStep | null;
  /** The answer to the last order, until the next one or `dismiss()`. */
  outcome: SpotOutcomeView | null;
  dismiss(): void;
  /** Sends the order as it is sized right now. One press, from the confirmation. */
  send(): void;
  minting: boolean;
  /** A mint can be asked for: the gate is open and nothing is in flight. */
  canMint: boolean;
  mintNote: SpotMintNote | null;
  /** Mints test money to the wallet from the quote token's open mint. */
  mint(): void;
}

export function useSpotTicket(): SpotTicket {
  const feed = useSpotMarket();
  const client = useSpotClient();
  const session = useSession();
  const { success, tap } = useHaptics();

  const market = feed.status === 'ready' ? feed.market : null;
  const stale = feed.status === 'ready' && feed.failed;

  const [side, setSide] = useState<SpotSide>('buy');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [walletRead, setWalletRead] = useState<SpotWalletRead>({ status: 'idle' });
  const [sending, setSending] = useState<SpotStep | null>(null);
  const [outcome, setOutcome] = useState<SpotOutcomeView | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintNote, setMintNote] = useState<SpotMintNote | null>(null);

  // The book is read again every few seconds, so the market is a new object each time. What a
  // wallet read depends on is which contracts it names, and that is this key.
  const marketRef = useRef(market);
  marketRef.current = market;
  const marketKey = market ? `${market.chainId}:${market.market}:${market.base.address}:${market.quote.address}` : null;

  const availability = client.availability();
  const canRead =
    marketKey !== null &&
    market !== null &&
    session.signedIn &&
    !session.pending &&
    availability.state === 'ready' &&
    market.chainId === client.chainId;

  // Bumped with each read, so an answer to an earlier one (another wallet, another market) is dropped.
  const readRun = useRef(0);
  const readWallet = useCallback(async () => {
    const current = marketRef.current;
    if (!current) return;
    const mine = ++readRun.current;
    try {
      const wallet = await client.readWallet(current);
      if (mine === readRun.current) setWalletRead({ status: 'ready', wallet });
    } catch (err) {
      if (mine !== readRun.current) return;
      // A read that fails after one has succeeded keeps the last good balances on screen.
      setWalletRead((prev) => (prev.status === 'ready' ? prev : { status: 'unread', message: spotFailure(err).message }));
    }
  }, [client]);

  useEffect(() => {
    if (!canRead) {
      readRun.current += 1;
      setWalletRead({ status: 'idle' });
      return;
    }
    setWalletRead({ status: 'loading' });
    void readWallet();
    const id = setInterval(() => void readWallet(), WALLET_EVERY_MS);
    return () => clearInterval(id);
  }, [canRead, marketKey, readWallet]);

  const gate = useMemo(
    () =>
      market
        ? spotGate({
            session: { pending: session.pending, signedIn: session.signedIn },
            availability,
            clientChainId: client.chainId,
            market,
            wallet: walletRead,
          })
        : null,
    // `availability` is a fresh object each render; its state is what it says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [market?.chainId, session.pending, session.signedIn, availability.state, client.chainId, walletRead],
  );

  const wallet = walletRead.status === 'ready' ? walletRead.wallet : null;

  const sizing = useMemo(
    () =>
      market && gate?.kind === 'open'
        ? sizeSpotOrder({
            market,
            side,
            amount,
            slippageBps,
            balance: side === 'buy' ? gate.wallet.quote : gate.wallet.base,
          })
        : null,
    [market, gate, side, amount, slippageBps],
  );

  const needsApproval = sizing?.ok && wallet ? approvalNeeded(sizing.order, wallet) : null;
  const busy = sending !== null || minting;
  const canSend = Boolean(sizing?.ok) && !stale && !busy;
  const canMint = gate?.kind === 'open' && !busy;

  let line: string | null = null;
  if (sending) line = STEP_LINE[sending];
  else if (gate?.kind === 'hold') line = gate.message;
  else if (gate?.kind === 'open' && stale) line = SPOT_BOOK_STALE;
  else if (sizing) line = sizing.ok ? orderLine(sizing.order) : sizing.message;

  // One transaction at a time from this wallet. A ref, so a second press inside the same frame is dropped.
  const inFlight = useRef(false);

  const send = useCallback(() => {
    if (inFlight.current || !market || !sizing?.ok || stale) return;
    const order = sizing.order;
    inFlight.current = true;
    setOutcome(null);
    setSending('checking');
    void (async () => {
      try {
        const receipt = await client.placeOrder(market, order, setSending);
        setOutcome(filledOutcome(receipt, order, market));
        if (receipt.fill) success();
        else tap();
        setAmount('');
      } catch (err) {
        setOutcome(failedOutcome(spotFailure(err), market));
        tap();
      } finally {
        inFlight.current = false;
        setSending(null);
        void readWallet();
      }
    })();
  }, [client, market, sizing, stale, readWallet, success, tap]);

  const mint = useCallback(() => {
    if (inFlight.current || !market || gate?.kind !== 'open') return;
    inFlight.current = true;
    setMintNote(null);
    setMinting(true);
    void (async () => {
      try {
        const { txHash } = await client.mint(market, 'quote', testMintAmount(market));
        setMintNote(mintedNote(market, txHash));
        success();
      } catch (err) {
        setMintNote(mintFailedNote(spotFailure(err), market));
        tap();
      } finally {
        inFlight.current = false;
        setMinting(false);
        void readWallet();
      }
    })();
  }, [client, market, gate, readWallet, success, tap]);

  // A buy is typed in the quote token and a sell in the base token, so a figure does not carry over.
  const chooseSide = useCallback((next: SpotSide) => {
    setSide(next);
    setAmount('');
  }, []);
  const dismiss = useCallback(() => setOutcome(null), []);

  return {
    feed,
    market,
    stale,
    side,
    chooseSide,
    amount,
    setAmount,
    slippageBps,
    chooseSlippage: setSlippageBps,
    gate,
    wallet,
    walletLoading: walletRead.status === 'loading',
    sizing,
    needsApproval,
    line,
    canSend,
    sending,
    outcome,
    dismiss,
    send,
    minting,
    canMint,
    mintNote,
    mint,
  };
}
