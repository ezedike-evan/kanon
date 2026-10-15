import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

// The hook plays haptics through the platform, which is react-native's. Here it plays none.
vi.mock('../platform', () => ({
  isWeb: true,
  useHaptics: () => ({ tap: () => undefined, select: () => undefined, success: () => undefined, warning: () => undefined, refusal: () => undefined }),
}));

import { KanonDataProvider, demoDataSource, type KanonDataSource } from './data';
import { createHarness, settle } from './render-harness';
import {
  REVERTED_LINE,
  SPOT_BOOK_STALE,
  SPOT_NO_WALLET,
  SPOT_READING_WALLET,
  SPOT_WALLET_UNREAD,
  type SpotMarket,
  type SpotOrder,
  type SpotOrderReceipt,
  type SpotStep,
  type SpotWallet,
} from './spot';
import { SpotError, spotAvailability, type SpotClient } from './spot-client';
import { createSpotStore, useSpotStore } from './spot-reads';
import { useSpotTicket, type SpotTicket } from './use-spot-ticket';

/**
 * The spot ticket's state, mounted under a real renderer over the real market
 * store and a scripted wallet client: what the foot of the screen says and
 * whether an order can leave, in each state a person can be in, and what an
 * answer leaves behind.
 */

const ME = '0x00000000000000000000000000000000000000aa';
const TX = `0x${'cd'.repeat(32)}`;

const view = (blockNumber = 7) => ({
  ok: true,
  asset: 'tkBTC/USDC',
  network: 'testnet',
  chainId: 10143,
  market: '0x4aC0501686D10048d083Ae8d1e13b9817FF1FF41',
  base: { address: '0x85495222Fd7069B987Ca38C2142732EbBFb7175D', name: 'Kanon Test BTC', symbol: 'tkBTC', decimals: 8, kind: 'test token, open mint' },
  quote: { address: '0x89b928df3A0F929578a3c93E1d6E3Be3433e539C', name: 'Mock USDC', symbol: 'USDC', decimals: 6, kind: 'mock, open mint' },
  note: 'tkBTC is a test token. It is not bitcoin.',
  priceDecimals: 4,
  sizeDecimals: 9,
  minSize: { atoms: '100000', decimals: 9 },
  maxSize: { atoms: '1000000000', decimals: 9 },
  takerFeeBps: 30,
  bids: [{ price: { atoms: '824475248', decimals: 4 }, size: { atoms: '250000000', decimals: 9 } }],
  asks: [{ price: { atoms: '832720000', decimals: 4 }, size: { atoms: '248756210', decimals: 9 } }],
  blockNumber,
  readAt: 1_760_000_000_000,
  listing: {},
});

const holding = (over: Partial<SpotWallet> = {}): SpotWallet => ({
  address: ME,
  native: { atoms: '500000000000000000', decimals: 18 },
  nativeSymbol: 'MON',
  base: { atoms: '0', decimals: 8 },
  quote: { atoms: '1000000000', decimals: 6 },
  baseAllowance: { atoms: '0', decimals: 8 },
  quoteAllowance: { atoms: '0', decimals: 6 },
  ...over,
});

interface Deferred<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

async function mount(
  input: {
    signedIn?: boolean;
    hasWallet?: boolean;
    chainId?: number;
    /** What each read of the wallet answers, in order; the last one stays. An `Error` is a read that fails. */
    wallets?: Array<SpotWallet | Error>;
    /** What each read of the market answers, in order; the last one stays. */
    markets?: Array<unknown | Error>;
  } = {},
) {
  const wallets = [...(input.wallets ?? [holding()])];
  const markets = [...(input.markets ?? [view()])];
  const reads: SpotMarket[] = [];
  const orders: Array<{ order: SpotOrder; onStep: ((step: SpotStep) => void) | undefined } & Deferred<SpotOrderReceipt>> = [];
  const mints: Array<Deferred<{ txHash: string }>> = [];

  const client: SpotClient = {
    chainId: input.chainId ?? 10143,
    availability: () => spotAvailability({ hasWallet: input.hasWallet ?? true }),
    async readWallet(market) {
      reads.push(market);
      const next = wallets.length > 1 ? wallets.shift()! : wallets[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    mint: () => new Promise((resolve, reject) => mints.push({ resolve, reject })),
    placeOrder: (_market, order, onStep) => new Promise((resolve, reject) => orders.push({ order, onStep, resolve, reject })),
  };

  let poll: () => void = () => undefined;
  const store = createSpotStore({
    get: async () => {
      const next = markets.length > 1 ? markets.shift() : markets[0];
      if (next instanceof Error) throw next;
      return next;
    },
    setTimer: (fn) => {
      poll = fn;
      return 0;
    },
    clearTimer: () => undefined,
  });

  const signedIn = input.signedIn ?? true;
  const source: KanonDataSource = {
    ...demoDataSource,
    useSpotMarket: () => useSpotStore(store),
    spotClient: client,
    session: { mode: signedIn ? 'live' : 'demo', pending: false, signedIn, hasWallet: input.hasWallet ?? true },
  };

  const h = createHarness();
  let latest: SpotTicket | undefined;
  function Probe(): null {
    latest = useSpotTicket();
    return null;
  }
  await h.render(createElement(KanonDataProvider, { source, children: createElement(Probe) }));
  await settle();
  const ticket = (): SpotTicket => {
    if (!latest) throw new Error('not mounted');
    return latest;
  };
  const type = async (amount: string) => {
    ticket().setAmount(amount);
    await settle();
  };
  /** The gateway is asked again, as its timer would. */
  const readBook = async () => {
    poll();
    await settle();
  };
  return { h, ticket, type, readBook, reads, orders, mints };
}

const FILL: SpotOrderReceipt = {
  txHash: TX,
  fill: { size: { atoms: '1000000', decimals: 9 }, averagePrice: { atoms: `83272${'0'.repeat(18)}`, decimals: 18 }, trades: 1 },
};

describe('useSpotTicket', () => {
  it('shows the book to a visitor and asks for sign-in: nothing about a wallet is read or sent', async () => {
    const t = await mount({ signedIn: false });
    expect(t.ticket().market?.asset).toBe('tkBTC/USDC');
    expect(t.ticket().gate).toEqual({ kind: 'sign_in' });
    expect(t.ticket().line).toBeNull();
    await t.type('100');
    expect(t.ticket().sizing).toBeNull();
    expect(t.ticket().canSend).toBe(false);
    expect(t.ticket().canMint).toBe(false);
    t.ticket().send();
    t.ticket().mint();
    await settle();
    expect(t.reads).toHaveLength(0);
    expect(t.orders).toHaveLength(0);
    expect(t.mints).toHaveLength(0);
    await t.h.unmount();
  });

  it('reads the wallet once signed in, then states the order for what is typed', async () => {
    const t = await mount();
    expect(t.reads).toHaveLength(1);
    expect(t.ticket().gate?.kind).toBe('open');
    expect(t.ticket().wallet?.quote).toEqual({ atoms: '1000000000', decimals: 6 });
    expect(t.ticket().line).toBe('Enter how much USDC to spend.');
    expect(t.ticket().canSend).toBe(false);

    await t.type('83.272');
    expect(t.ticket().line).toBe('Spend 83.272 USDC for at least 0.00098703 tkBTC.');
    expect(t.ticket().needsApproval).toBe(true);
    expect(t.ticket().canSend).toBe(true);

    // The bound is the person's to change, and the least received moves with it.
    t.ticket().chooseSlippage(200);
    await settle();
    expect(t.ticket().line).toBe('Spend 83.272 USDC for at least 0.00097706 tkBTC.');
    await t.h.unmount();
  });

  it('sends the order as stated, says where it has got to, and leaves what filled with its transaction', async () => {
    const t = await mount();
    await t.type('83.272');
    t.ticket().send();
    await settle();
    expect(t.orders).toHaveLength(1);
    expect(t.orders[0]!.order).toMatchObject({ side: 'buy', sizeArg: { atoms: '832720', decimals: 4 }, minOut: { atoms: '98703', decimals: 8 } });
    expect(t.ticket().sending).toBe('checking');
    expect(t.ticket().canSend).toBe(false);

    t.orders[0]!.onStep?.('approving');
    await settle();
    expect(t.ticket().line).toBe('Approve the spend in your wallet. Step 1 of 2.');

    // A second press, and a mint, while one transaction is out: neither goes anywhere.
    t.ticket().send();
    t.ticket().mint();
    await settle();
    expect(t.orders).toHaveLength(1);
    expect(t.mints).toHaveLength(0);

    t.orders[0]!.resolve(FILL);
    await settle();
    expect(t.ticket().sending).toBeNull();
    expect(t.ticket().outcome).toMatchObject({
      mark: 'done',
      title: 'BUY FILLED',
      facts: [
        ['Filled size', '0.001 tkBTC'],
        ['Average price', '83,272.0000 USDC'],
      ],
    });
    expect(t.ticket().outcome?.links.map((l) => [l.name, l.tx.url])).toEqual([['Order', `https://testnet.monadscan.com/tx/${TX}`]]);
    // The amount is spent, so it is cleared; the balances are read again.
    expect(t.ticket().amount).toBe('');
    expect(t.reads).toHaveLength(2);

    t.ticket().dismiss();
    await settle();
    expect(t.ticket().outcome).toBeNull();
    await t.h.unmount();
  });

  it('says a revert calmly and keeps the amount, so the bound can be changed and the order sent again', async () => {
    const t = await mount();
    await t.type('83.272');
    t.ticket().send();
    await settle();
    t.orders[0]!.reject(new SpotError('reverted', REVERTED_LINE));
    await settle();
    expect(t.ticket().outcome).toMatchObject({ mark: 'note', title: 'NOT FILLED', line: REVERTED_LINE, facts: [], links: [] });
    expect(t.ticket().amount).toBe('83.272');
    expect(t.ticket().canSend).toBe(true);
    await t.h.unmount();
  });

  it('never shows a fill it was not given: a receipt with none says the fill could not be read', async () => {
    const t = await mount();
    await t.type('83.272');
    t.ticket().send();
    await settle();
    t.orders[0]!.resolve({ txHash: TX, fill: null });
    await settle();
    expect(t.ticket().outcome).toMatchObject({ mark: 'note', title: 'SENT, FILL NOT READ', facts: [] });
    expect(t.ticket().outcome?.links.map((l) => l.tx.hash)).toEqual([TX]);
    await t.h.unmount();
  });

  it('holds a wallet with no gas in one calm sentence: no order and no mint can be asked for', async () => {
    const t = await mount({ wallets: [holding({ native: { atoms: '0', decimals: 18 } })] });
    await t.type('83.272');
    expect(t.ticket().gate?.kind).toBe('hold');
    expect(t.ticket().line).toBe(
      'This wallet holds no testnet MON. Every transaction needs a little for gas, so nothing can be sent until it has some.',
    );
    expect(t.ticket().canSend).toBe(false);
    expect(t.ticket().canMint).toBe(false);
    t.ticket().send();
    t.ticket().mint();
    await settle();
    expect(t.orders).toHaveLength(0);
    expect(t.mints).toHaveLength(0);
    await t.h.unmount();
  });

  it('names both chains when the app is set to another than the market, and reads no wallet there', async () => {
    const t = await mount({ chainId: 143 });
    expect(t.ticket().line).toBe(
      'This market is on Monad Testnet (chain 10143). This build of the app is set to Monad mainnet (chain 143), so orders are off here.',
    );
    expect(t.ticket().canSend).toBe(false);
    expect(t.reads).toHaveLength(0);
    await t.h.unmount();
  });

  it('says there is no wallet yet, and that the wallet could not be read, each in its own sentence', async () => {
    const none = await mount({ hasWallet: false });
    expect(none.ticket().line).toBe(SPOT_NO_WALLET);
    expect(none.reads).toHaveLength(0);
    await none.h.unmount();

    const unread = await mount({ wallets: [new SpotError('failed', SPOT_WALLET_UNREAD)] });
    expect(unread.ticket().line).toBe(SPOT_WALLET_UNREAD);
    expect(unread.ticket().wallet).toBeNull();
    expect(unread.ticket().line).not.toBe(SPOT_READING_WALLET);
    await unread.h.unmount();
  });

  it('holds orders while the book on screen is not the current one', async () => {
    const t = await mount({ markets: [view(7), new Error('offline'), view(8)] });
    await t.type('83.272');
    expect(t.ticket().canSend).toBe(true);
    await t.readBook();
    expect(t.ticket().stale).toBe(true);
    // The last good book is still drawn, and nothing can be sized against it.
    expect(t.ticket().market?.blockNumber).toBe(7);
    expect(t.ticket().line).toBe(SPOT_BOOK_STALE);
    expect(t.ticket().canSend).toBe(false);
    t.ticket().send();
    await settle();
    expect(t.orders).toHaveLength(0);
    await t.readBook();
    expect(t.ticket().stale).toBe(false);
    expect(t.ticket().canSend).toBe(true);
    await t.h.unmount();
  });

  it('holds the amount to what the wallet has, on the side being spent', async () => {
    const t = await mount({ wallets: [holding({ quote: { atoms: '25500000', decimals: 6 }, base: { atoms: '99700', decimals: 8 } })] });
    await t.type('100');
    expect(t.ticket().line).toBe('This wallet holds 25.5 USDC. Get test USDC or enter less.');
    // A sell is typed in the base token, so the figure does not carry over.
    t.ticket().chooseSide('sell');
    await settle();
    expect(t.ticket().amount).toBe('');
    expect(t.ticket().line).toBe('Enter how much tkBTC to sell.');
    await t.type('0.5');
    expect(t.ticket().line).toBe('This wallet holds 0.000997 tkBTC. Buy some first or enter less.');
    await t.type('0.0005');
    expect(t.ticket().line).toBe('Sell 0.0005 tkBTC for at least 40.68909 USDC.');
    expect(t.ticket().canSend).toBe(true);
    await t.h.unmount();
  });

  it('mints test money to the wallet, says so with its transaction, and reads the balances again', async () => {
    const t = await mount();
    expect(t.ticket().canMint).toBe(true);
    t.ticket().mint();
    await settle();
    expect(t.ticket().minting).toBe(true);
    expect(t.ticket().canMint).toBe(false);
    t.mints[0]!.resolve({ txHash: TX });
    await settle();
    expect(t.ticket().minting).toBe(false);
    expect(t.ticket().mintNote?.line).toBe('1,000 Mock USDC minted to this wallet.');
    expect(t.ticket().mintNote?.links.map((l) => [l.name, l.tx.hash])).toEqual([['Mint', TX]]);
    expect(t.reads).toHaveLength(2);

    t.ticket().mint();
    await settle();
    t.mints[1]!.reject(new SpotError('rejected', 'The request was declined in the wallet. Nothing was minted.'));
    await settle();
    expect(t.ticket().mintNote).toEqual({ line: 'The request was declined in the wallet. Nothing was minted.', links: [] });
    await t.h.unmount();
  });

  it('says so in place of a book when none is listed, and offers nothing to send', async () => {
    const t = await mount({ markets: [{ ok: false, code: 'not_listed', message: 'No market is listed on Kuru from this deployment yet.' }] });
    expect(t.ticket().feed).toEqual({
      status: 'unavailable',
      code: 'not_listed',
      message: 'No market is listed on Kuru from this deployment yet.',
    });
    expect(t.ticket().market).toBeNull();
    expect(t.ticket().gate).toBeNull();
    expect(t.ticket().canSend).toBe(false);
    expect(t.reads).toHaveLength(0);
    await t.h.unmount();
  });
});
