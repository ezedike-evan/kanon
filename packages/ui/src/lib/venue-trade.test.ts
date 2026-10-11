import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_UNKNOWN_SHAPE,
  NOT_REPORTED_YET,
  ORDER_UNKNOWN_SHAPE,
  SIGN_IN_ACTION,
  SIGN_IN_TO_TRADE,
  STALE_SENDING_MS,
  TX_NOT_REPORTED,
  addOrderLabel,
  asAccount,
  asOrderResult,
  asksToSignIn,
  barLine,
  barSummary,
  chosenOption,
  closePositionLabel,
  completeFill,
  feeFact,
  fillAwaitsFigures,
  formatCollateral,
  formatLeverage,
  formatNotional,
  formatUsd,
  formatVenueSize,
  isClosing,
  leverageSteps,
  marketOf,
  openOrderLabel,
  openingIntent,
  orderFromRow,
  orderRowView,
  ordersFromRows,
  outcomeView,
  positionFacts,
  positionOf,
  positionRowView,
  sendingLine,
  sheetLine,
  sheetPrimary,
  sideButton,
  sideHold,
  sizeChipLabel,
  sizePresets,
  thrownMessage,
  ticketLine,
  ticketSecondLine,
  ticketView,
  venueTx,
} from './venue-trade';
import type {
  VenueAccountView,
  VenueLimits,
  VenueOrder,
  VenueOrderResult,
  VenueOrderRow,
  VenuePositionView,
} from './venue-types';

const LIMITS: VenueLimits = {
  minNotionalUsd: 10,
  maxNotionalUsd: 100,
  maxLeverage: 5,
  slippageBps: 100,
  maxPositionUsd: 300,
};

const POSITION: VenuePositionView = {
  asset: 'BTC/USD',
  side: 'long',
  size: { atoms: '41000', decimals: 8 },
  entryPrice: { atoms: '612345', decimals: 1 },
  leverage: 2,
  collateral: { atoms: '12500000', decimals: 6 },
  // 0.00041 BTC at 61,234.5 is $25.106145; the server keeps the cents, rounded down.
  notional: { atoms: '2510', decimals: 2 },
  openedAt: 1_760_000_000_000,
};

/** The same position at another size at entry, in cents. */
const sized = (cents: string, over: Partial<VenuePositionView> = {}): VenuePositionView => ({
  ...POSITION,
  notional: { atoms: cents, decimals: 2 },
  ...over,
});

type Ready = Extract<VenueAccountView, { status: 'ready' }>;
const ready = (over: Partial<Ready> = {}): Ready => ({
  status: 'ready',
  venue: 'perpl',
  network: 'testnet',
  wallet: '0x9fE2000000000000000000000000000000041Ab',
  accountId: 7,
  balance: { atoms: '1234560000', decimals: 6 },
  canTrade: true,
  limits: LIMITS,
  markets: [
    { asset: 'BTC/USD', maxLeverage: 5, open: true },
    { asset: 'ETH/USD', maxLeverage: 3, open: true },
    { asset: 'SOL/USD', maxLeverage: 5, open: false },
  ],
  positions: [],
  ...over,
});

const NOTHING_PICKED = { usd: null, leverage: null };
const HASH = `0x${'ab'.repeat(32)}`;

const FILLED: Extract<VenueOrderResult, { status: 'filled' }> = {
  status: 'filled',
  orderId: 'o1',
  asset: 'BTC/USD',
  action: 'open',
  side: 'long',
  size: { atoms: '41000', decimals: 8 },
  price: { atoms: '612345', decimals: 1 },
  fee: { atoms: '8750', decimals: 6 },
  block: 12_345_678,
  txHash: HASH,
};

/** A fill answered the moment the position moved: the venue's history has not listed it yet. */
const EARLY: Extract<VenueOrderResult, { status: 'filled' }> = {
  ...FILLED,
  price: null,
  fee: null,
  block: null,
  txHash: null,
};

/** The caller's order row for `FILLED`, with every figure the history gives. */
const ROW: VenueOrder = {
  id: 'o1',
  network: 'testnet',
  asset: 'BTC/USD',
  action: 'open',
  side: 'long',
  status: 'filled',
  createdAt: 1_000_000,
  settledAt: 1_004_000,
  notionalUsd: 25,
  leverage: 2,
  requestId: 9,
  size: { atoms: '41000', decimals: 8 },
  fillPrice: { atoms: '612345', decimals: 1 },
  fee: { atoms: '8750', decimals: 6 },
  block: 12_345_678,
  txHash: HASH,
  reason: null,
};

describe('thrownMessage', () => {
  it("uses the server's own line for a refusal of the caller, and the fallback for everything else", () => {
    expect(thrownMessage({ data: { code: 'unauthenticated', message: 'Sign in to continue.' } }, 'fallback')).toBe(
      'Sign in to continue.',
    );
    // A transport or server fault carries text written for a log, not for a person.
    expect(thrownMessage(new Error('[CONVEX A(venue:account)] [Request ID: 1] Server Error'), 'fallback')).toBe('fallback');
    expect(thrownMessage({ data: { message: '  ' } }, 'fallback')).toBe('fallback');
    expect(thrownMessage({ data: 'plain' }, 'fallback')).toBe('fallback');
    expect(thrownMessage(null, 'fallback')).toBe('fallback');
    expect(thrownMessage(undefined, 'fallback')).toBe('fallback');
  });
});

describe('asAccount', () => {
  it('passes a ready account and an unavailable one through', () => {
    const account = ready();
    expect(asAccount(account)).toBe(account);
    expect(asAccount({ status: 'unavailable', message: 'Trading is not connected on this deployment.' })).toEqual({
      status: 'unavailable',
      message: 'Trading is not connected on this deployment.',
    });
  });

  it('reads anything else as a failure to read, never as an account', () => {
    const unknown = { status: 'unavailable', message: ACCOUNT_UNKNOWN_SHAPE };
    expect(asAccount(undefined)).toEqual(unknown);
    expect(asAccount({ outcomes: {} })).toEqual(unknown);
    expect(asAccount({ status: 'unavailable' })).toEqual(unknown);
    expect(asAccount({ ...ready(), limits: undefined })).toEqual(unknown);
    expect(asAccount({ ...ready(), limits: { ...LIMITS, slippageBps: 'x' } })).toEqual(unknown);
    expect(asAccount({ ...ready(), markets: [{ asset: 'BTC/USD' }] })).toEqual(unknown);
    expect(asAccount({ ...ready(), positions: [{ ...POSITION, size: { atoms: '1.5', decimals: 8 } }] })).toEqual(unknown);
    expect(asAccount({ ...ready(), network: 'devnet' })).toEqual(unknown);
  });

  it('needs the position limit and what each position is measured against it by', () => {
    const unknown = { status: 'unavailable', message: ACCOUNT_UNKNOWN_SHAPE };
    const held = ready({ positions: [POSITION] });
    expect(asAccount(held)).toBe(held);

    // An account from before the position limit: its chips could offer what the server refuses.
    const { maxPositionUsd: _limit, ...oldLimits } = LIMITS;
    expect(asAccount({ ...ready(), limits: oldLimits })).toEqual(unknown);
    expect(asAccount({ ...ready(), limits: { ...LIMITS, maxPositionUsd: '300' } })).toEqual(unknown);
    expect(asAccount({ ...ready(), limits: { ...LIMITS, maxPositionUsd: Number.POSITIVE_INFINITY } })).toEqual(unknown);

    const { notional: _notional, ...oldPosition } = POSITION;
    expect(asAccount({ ...ready(), positions: [oldPosition] })).toEqual(unknown);
    expect(asAccount({ ...ready(), positions: [{ ...POSITION, notional: 25.1 }] })).toEqual(unknown);
    expect(asAccount({ ...ready(), positions: [{ ...POSITION, notional: { atoms: '25.10', decimals: 2 } }] })).toEqual(unknown);
  });
});

describe('asOrderResult', () => {
  it('passes each answer the server gives through', () => {
    expect(asOrderResult(FILLED)).toBe(FILLED);
    const bare = { ...FILLED, price: null, txHash: null };
    expect(asOrderResult(bare)).toBe(bare);
    // Answered before the venue's history listed the fill: every figure of its own is null.
    expect(asOrderResult(EARLY)).toBe(EARLY);
    expect(asOrderResult({ ...FILLED, fee: null })).toMatchObject({ status: 'filled', fee: null, block: 12_345_678 });
    expect(asOrderResult({ ...FILLED, block: null })).toMatchObject({ status: 'filled', block: null });
    expect(asOrderResult({ status: 'refused', reason: 'The BTC market is closed.' })).toEqual({
      status: 'refused',
      reason: 'The BTC market is closed.',
    });
    expect(asOrderResult({ status: 'unfilled', orderId: 'o2', message: 'Nothing filled.' })).toEqual({
      status: 'unfilled',
      orderId: 'o2',
      message: 'Nothing filled.',
    });
    expect(asOrderResult({ status: 'pending', orderId: 'o3', message: 'The order was sent. It may still fill.' })).toEqual({
      status: 'pending',
      orderId: 'o3',
      message: 'The order was sent. It may still fill.',
    });
    expect(asOrderResult({ status: 'busy', message: 'Another order is on its way.' })).toEqual({
      status: 'busy',
      message: 'Another order is on its way.',
    });
    expect(asOrderResult({ status: 'unavailable', message: 'Finish signing up to trade.' })).toEqual({
      status: 'unavailable',
      message: 'Finish signing up to trade.',
    });
    expect(asOrderResult({ status: 'rate_limited', retryAfterMs: 4000, message: 'Too many orders.' })).toEqual({
      status: 'rate_limited',
      retryAfterMs: 4000,
      message: 'Too many orders.',
    });
  });

  it('reads anything else as an answer it could not read, and says to check the position', () => {
    const unknown = { status: 'unavailable', message: ORDER_UNKNOWN_SHAPE };
    expect(asOrderResult(undefined)).toEqual(unknown);
    expect(asOrderResult({ outcomes: {} })).toEqual(unknown);
    expect(asOrderResult({ status: 'refused' })).toEqual(unknown);
    // A figure the answer does not carry at all is not the same as one it says is not known yet.
    expect(asOrderResult({ ...FILLED, fee: undefined })).toEqual(unknown);
    expect(asOrderResult({ ...FILLED, block: undefined })).toEqual(unknown);
    expect(asOrderResult({ ...FILLED, block: '12345678' })).toEqual(unknown);
    expect(asOrderResult({ ...FILLED, fee: 0.00875 })).toEqual(unknown);
    expect(asOrderResult({ ...FILLED, side: 'flat' })).toEqual(unknown);
    expect(asOrderResult({ status: 'pending', orderId: 'o3' })).toEqual(unknown);
    expect(asOrderResult({ status: 'settled', message: 'x' })).toEqual(unknown);
  });
});

describe('orders from rows', () => {
  const row: VenueOrderRow = {
    _id: 'o1',
    _creationTime: 1,
    venue: 'perpl',
    network: 'testnet',
    asset: 'BTC/USD',
    action: 'close',
    status: 'refused',
    createdAt: 1_000,
  };

  it('makes every absent field null', () => {
    expect(orderFromRow(row)).toEqual({
      id: 'o1',
      network: 'testnet',
      asset: 'BTC/USD',
      action: 'close',
      side: null,
      status: 'refused',
      createdAt: 1_000,
      settledAt: null,
      notionalUsd: null,
      leverage: null,
      requestId: null,
      size: null,
      fillPrice: null,
      fee: null,
      block: null,
      txHash: null,
      reason: null,
    });
  });

  it('keeps what a row carries', () => {
    const filled: VenueOrderRow = {
      ...row,
      action: 'open',
      side: 'short',
      status: 'filled',
      settledAt: 2_000,
      notionalUsd: 25,
      leverage: 2,
      requestId: 9,
      size: FILLED.size,
      fillPrice: { atoms: '612345', decimals: 1 },
      fee: { atoms: '8750', decimals: 6 },
      block: 5,
      txHash: HASH,
    };
    expect(orderFromRow(filled)).toMatchObject({
      side: 'short',
      settledAt: 2_000,
      notionalUsd: 25,
      leverage: 2,
      requestId: 9,
      size: FILLED.size,
      fillPrice: { atoms: '612345', decimals: 1 },
      block: 5,
      txHash: HASH,
    });
  });

  it('leaves out a row it cannot read, keeping the order of the rest', () => {
    const rows = [row, null, { ...row, _id: 'o2', status: 'paused' }, { ...row, _id: 'o3', asset: '' }, { ...row, _id: 'o4' }];
    expect(ordersFromRows(rows).map((o) => o.id)).toEqual(['o1', 'o4']);
  });
});

describe('sizePresets', () => {
  it("offers the server's ends and round figures between them, in whole dollars", () => {
    expect(sizePresets(LIMITS)).toEqual([10, 25, 50, 100]);
    expect(sizePresets({ minNotionalUsd: 20, maxNotionalUsd: 80 })).toEqual([20, 25, 50, 80]);
    expect(sizePresets({ minNotionalUsd: 10.5, maxNotionalUsd: 99.9 })).toEqual([11, 25, 50, 99]);
    expect(sizePresets({ minNotionalUsd: 5, maxNotionalUsd: 5_000 })).toEqual([5, 50, 500, 5_000]);
    expect(sizePresets({ minNotionalUsd: 0, maxNotionalUsd: 30 })).toEqual([1, 10, 25, 30]);
  });

  it('never offers a size outside the limits, and offers none when they admit none', () => {
    expect(sizePresets({ minNotionalUsd: 10, maxNotionalUsd: 10 })).toEqual([10]);
    expect(sizePresets({ minNotionalUsd: 10, maxNotionalUsd: 12 })).toEqual([10, 12]);
    expect(sizePresets({ minNotionalUsd: 10, maxNotionalUsd: 5 })).toEqual([]);
    expect(sizePresets({ minNotionalUsd: 10.2, maxNotionalUsd: 10.8 })).toEqual([]);
    expect(sizePresets({ minNotionalUsd: Number.NaN, maxNotionalUsd: 100 })).toEqual([]);
    for (const limits of [LIMITS, { minNotionalUsd: 37, maxNotionalUsd: 4_210 }]) {
      for (const usd of sizePresets(limits)) {
        expect(Number.isInteger(usd)).toBe(true);
        expect(usd).toBeGreaterThanOrEqual(limits.minNotionalUsd);
        expect(usd).toBeLessThanOrEqual(limits.maxNotionalUsd);
      }
    }
  });
});

describe('leverageSteps', () => {
  it("is every whole step from 1x to the market's ceiling", () => {
    expect(leverageSteps(5)).toEqual([1, 2, 3, 4, 5]);
    expect(leverageSteps(3)).toEqual([1, 2, 3]);
    expect(leverageSteps(2.9)).toEqual([1, 2]);
    expect(leverageSteps(1)).toEqual([1]);
  });

  it('is 1x when the ceiling is not a leverage, and is never an unbounded row', () => {
    expect(leverageSteps(0)).toEqual([1]);
    expect(leverageSteps(Number.NaN)).toEqual([1]);
    expect(leverageSteps(1e9)).toHaveLength(100);
  });
});

describe('chosenOption', () => {
  it('starts on the smallest, keeps a pick that is offered, and falls back under one that is not', () => {
    expect(chosenOption([10, 25, 50, 100], null)).toBe(10);
    expect(chosenOption([10, 25, 50, 100], 50)).toBe(50);
    expect(chosenOption([1, 2, 3], 5)).toBe(3);
    expect(chosenOption([20, 25, 50], 10)).toBe(20);
    expect(chosenOption([], 10)).toBeNull();
    expect(chosenOption([], null)).toBeNull();
  });
});

describe('marketOf and positionOf', () => {
  it('find the chart asset however it is spelled, and nothing on an account that is not ready', () => {
    const account = ready({ positions: [POSITION] });
    expect(marketOf(account, 'eth / usd')?.maxLeverage).toBe(3);
    expect(marketOf(account, 'AVAX/USD')).toBeNull();
    expect(positionOf(account, 'btc/usd')).toBe(POSITION);
    expect(positionOf(account, 'ETH/USD')).toBeNull();
    expect(marketOf({ status: 'loading' }, 'BTC/USD')).toBeNull();
    expect(positionOf({ status: 'unavailable', message: 'x' }, 'BTC/USD')).toBeNull();
  });
});

describe('figures', () => {
  it('prints notional in whole dollars and leverage as a multiple', () => {
    expect(formatUsd(25)).toBe('$25');
    expect(formatUsd(1_000)).toBe('$1,000');
    expect(formatLeverage(2)).toBe('2x');
    expect(formatLeverage(2.5)).toBe('2.5x');
    expect(formatLeverage(1.25)).toBe('1.25x');
    expect(formatLeverage(3.0000001)).toBe('3x');
    expect(formatLeverage(10)).toBe('10x');
  });

  it('prints a size, collateral and a fee from their atoms', () => {
    expect(formatVenueSize({ atoms: '41000', decimals: 8 }, 'BTC/USD')).toBe('0.00041 BTC');
    expect(formatVenueSize({ atoms: '1500', decimals: 3 }, 'eth/usd')).toBe('1.50 ETH');
    expect(formatCollateral({ atoms: '12500000', decimals: 6 })).toBe('12.50 AUSD');
    expect(formatCollateral({ atoms: '1234567890', decimals: 6 })).toBe('1,234.57 AUSD');
    expect(feeFact({ atoms: '8750', decimals: 6 })).toEqual(['Fee', '0.00875 AUSD']);
    expect(feeFact({ atoms: '0', decimals: 6 })).toEqual(['Fee', '0.00 AUSD']);
  });

  it("prints a position's size at entry in dollars and cents, from its atoms", () => {
    expect(formatNotional({ atoms: '2510', decimals: 2 })).toBe('$25.10');
    expect(formatNotional({ atoms: '29512', decimals: 2 })).toBe('$295.12');
    expect(formatNotional({ atoms: '123456789', decimals: 2 })).toBe('$1,234,567.89');
    expect(formatNotional({ atoms: '0', decimals: 2 })).toBe('$0.00');
  });

  it('calls negative fee atoms a rebate instead of a negative fee', () => {
    expect(feeFact({ atoms: '-1200', decimals: 6 })).toEqual(['Rebate', '0.0012 AUSD']);
  });

  it('keeps a figure wider than a float exact', () => {
    // 9,007,199,254,740,993 is past what a double holds; a float would print ...992.
    expect(formatVenueSize({ atoms: '9007199254740993', decimals: 0 }, 'MON/USD')).toBe('9,007,199,254,740,993 MON');
    expect(formatCollateral({ atoms: '9007199254740993000000', decimals: 6 })).toBe('9,007,199,254,740,993.00 AUSD');
  });
});

describe('venueTx', () => {
  it("links a fill to the explorer of the venue's own network", () => {
    expect(venueTx('testnet', HASH)).toEqual({
      hash: HASH,
      short: '0xababab…abab',
      url: `https://testnet.monadscan.com/tx/${HASH}`,
      explorer: 'Monadscan',
    });
    expect(venueTx('mainnet', HASH).url).toBe(`https://monadscan.com/tx/${HASH}`);
  });

  it('cannot be steered off the transaction page by what the hash contains', () => {
    expect(venueTx('testnet', '0xab/../../address?x=1').url).toBe(
      'https://testnet.monadscan.com/tx/0xab%2F..%2F..%2Faddress%3Fx%3D1',
    );
  });
});

describe('ticketView', () => {
  it('offers nothing until the account is read', () => {
    const view = ticketView({ status: 'loading' }, 'BTC/USD', NOTHING_PICKED);
    expect(view).toMatchObject({
      status: 'loading',
      limits: null,
      sizes: [],
      sizesOff: [],
      usd: null,
      leverages: [],
      leverage: null,
      leverageFixed: false,
      position: null,
      network: null,
      hold: 'Reading the trading account.',
      sideNote: null,
    });
    expect(view.venueLine).toBe('Perpl · shared demo account');
  });

  it("holds with the server's own message when the account is unavailable", () => {
    const view = ticketView({ status: 'unavailable', message: 'Sign in to trade.' }, 'BTC/USD', NOTHING_PICKED);
    expect(view).toMatchObject({ status: 'unavailable', message: 'Sign in to trade.', hold: 'Sign in to trade.', sizes: [] });
  });

  it('knows the line that asks for sign-in, on every surface that shows it, so each can draw it as a link', () => {
    const signedOut = ticketView({ status: 'unavailable', message: SIGN_IN_TO_TRADE }, 'BTC/USD', NOTHING_PICKED);
    expect(asksToSignIn(ticketLine(signedOut, null))).toBe(true);
    expect(asksToSignIn(sheetLine(signedOut, 'close', null))).toBe(true);
    expect(asksToSignIn(barLine(signedOut, null, null))).toBe(true);
    // The link's own label is the sentence without its full stop.
    expect(`${SIGN_IN_ACTION}.`).toBe(SIGN_IN_TO_TRADE);

    // Any other reason stays a sentence: there is nothing sign-in would fix.
    const down = ticketView({ status: 'unavailable', message: 'The trading account could not be read. Try again.' }, 'BTC/USD', NOTHING_PICKED);
    expect(asksToSignIn(ticketLine(down, null))).toBe(false);
    expect(asksToSignIn(null)).toBe(false);
    expect(asksToSignIn(undefined)).toBe(false);
  });

  it('opens on the smallest size and 1x, with every limit worded from what the server sent', () => {
    const view = ticketView(ready(), 'BTC/USD', NOTHING_PICKED);
    expect(view).toMatchObject({
      status: 'ready',
      venueLine: 'Perpl testnet · shared demo account',
      network: 'testnet',
      sizes: [10, 25, 50, 100],
      sizesOff: [],
      usd: 10,
      leverages: [1, 2, 3, 4, 5],
      leverage: 1,
      leverageFixed: false,
      position: null,
      hold: null,
      sideNote: null,
    });
    expect(view.limits).toEqual({
      orderType: 'Market, IOC',
      slippage: '1.00%',
      size: '$10 to $100',
      leverage: '1x to 5x',
      position: 'Up to $300',
    });
  });

  it('shows other limits when the server sends other limits: none of them is written into the ticket', () => {
    const account = ready({
      limits: { minNotionalUsd: 20, maxNotionalUsd: 2_000, maxLeverage: 10, slippageBps: 35, maxPositionUsd: 7_500 },
      markets: [{ asset: 'BTC/USD', maxLeverage: 8, open: true }],
    });
    const view = ticketView(account, 'BTC/USD', NOTHING_PICKED);
    expect(view.limits).toEqual({
      orderType: 'Market, IOC',
      slippage: '0.35%',
      size: '$20 to $2,000',
      leverage: '1x to 8x',
      position: 'Up to $7,500',
    });
    expect(view.sizes).toEqual([20, 50, 500, 2_000]);
    expect(view.leverages).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("keeps a pick, and falls back when the market on the chart does not offer it", () => {
    const picked = { usd: 50, leverage: 5 };
    expect(ticketView(ready(), 'BTC/USD', picked)).toMatchObject({ usd: 50, leverage: 5 });
    // ETH tops out at 3x here: the 5x picked on BTC cannot be sent on it.
    const eth = ticketView(ready(), 'ETH/USD', picked);
    expect(eth).toMatchObject({ usd: 50, leverage: 3, leverages: [1, 2, 3] });
    expect(eth.limits?.leverage).toBe('1x to 3x');
  });

  it('with a position open, offers an add on its side and keeps the other side off, on this asset only', () => {
    const account = ready({ positions: [POSITION] });
    const btc = ticketView(account, 'BTC/USD', NOTHING_PICKED);
    expect(btc.position).toBe(POSITION);
    // $25.10 at entry and $300 allowed: every size fits, so nothing holds an add back.
    expect(btc).toMatchObject({ sizes: [10, 25, 50, 100], sizesOff: [], usd: 10, hold: null });
    expect(btc.sideNote).toBe('The account holds a BTC long. Close it before opening a short.');
    expect(sideHold(btc, 'long')).toBeNull();
    expect(sideHold(btc, 'short')).toBe('The account holds a BTC long. Close it before opening a short.');

    const eth = ticketView(account, 'ETH/USD', NOTHING_PICKED);
    expect(eth).toMatchObject({ position: null, hold: null, sideNote: null, leverageFixed: false });
    expect(sideHold(eth, 'long')).toBeNull();
    expect(sideHold(eth, 'short')).toBeNull();

    // The same rule the other way round: a short is added to, a long waits.
    const short = ticketView(ready({ positions: [sized('2510', { side: 'short' })] }), 'BTC/USD', NOTHING_PICKED);
    expect(short.sideNote).toBe('The account holds a BTC short. Close it before opening a long.');
    expect(sideHold(short, 'short')).toBeNull();
    expect(sideHold(short, 'long')).toBe(short.sideNote);
  });

  it("fixes the leverage of an add to the position's own, whatever was picked", () => {
    const view = ticketView(ready({ positions: [POSITION] }), 'BTC/USD', { usd: 25, leverage: 5 });
    expect(view).toMatchObject({ leverage: 2, leverageFixed: true, usd: 25, hold: null });
    // The market's own range is still stated: it is a limit in force, not a choice on offer.
    expect(view.limits?.leverage).toBe('1x to 5x');
  });

  it("turns adding off, with the reason, when the position's leverage is not one the server takes", () => {
    const fractional = ticketView(ready({ positions: [sized('2510', { leverage: 2.5 })] }), 'BTC/USD', NOTHING_PICKED);
    expect(fractional).toMatchObject({ leverage: null, leverageFixed: true });
    expect(fractional.hold).toBe(
      'The BTC position is at 2.5x. An order that adds to it uses the same leverage, and leverage on BTC here is 1x to 5x, in whole steps.',
    );
    expect(sideHold(fractional, 'long')).toBe(fractional.hold);
    // The other side keeps its own reason.
    expect(sideHold(fractional, 'short')).toBe('The account holds a BTC long. Close it before opening a short.');

    // A whole multiple above what this market takes is refused just the same. ETH tops out at 3x here.
    const eth = sized('2510', { asset: 'ETH/USD', leverage: 4 });
    const above = ticketView(ready({ positions: [eth] }), 'ETH/USD', NOTHING_PICKED);
    expect(above.leverage).toBeNull();
    expect(above.hold).toBe(
      'The ETH position is at 4x. An order that adds to it uses the same leverage, and leverage on ETH here is 1x to 3x, in whole steps.',
    );
  });

  it('turns off each size that would take the position past the position limit', () => {
    const at = (cents: string, wanted = NOTHING_PICKED) =>
      ticketView(ready({ positions: [sized(cents)] }), 'BTC/USD', wanted);

    // $200.00 at entry, $300 allowed: $100 lands exactly on the limit, which is inside it.
    expect(at('20000')).toMatchObject({ sizesOff: [], hold: null });
    // One cent more and $100 is past it.
    expect(at('20001')).toMatchObject({ sizesOff: [100], usd: 10, hold: null });
    expect(at('25000')).toMatchObject({ sizesOff: [100], hold: null });
    expect(at('25001')).toMatchObject({ sizesOff: [50, 100], hold: null });
    expect(at('27501')).toMatchObject({ sizesOff: [25, 50, 100], usd: 10, hold: null });
    expect(at('29000')).toMatchObject({ sizesOff: [25, 50, 100], usd: 10, hold: null });
  });

  it('never leaves a size in force that cannot be sent: a pick that no longer fits falls back to one that does', () => {
    const view = ticketView(ready({ positions: [sized('26000')] }), 'BTC/USD', { usd: 100, leverage: null });
    expect(view.sizesOff).toEqual([50, 100]);
    expect(view.usd).toBe(25);
    // A pick that still fits is kept.
    expect(ticketView(ready({ positions: [sized('26000')] }), 'BTC/USD', { usd: 10, leverage: null }).usd).toBe(10);
  });

  it('says so in one line, with the limit and the size at entry, when no size fits', () => {
    const view = ticketView(ready({ positions: [sized('29512')] }), 'BTC/USD', { usd: 25, leverage: null });
    expect(view).toMatchObject({ sizes: [10, 25, 50, 100], sizesOff: [10, 25, 50, 100], usd: null, leverage: 2 });
    expect(view.hold).toBe('The BTC position is $295.12 at entry. A position here is at most $300.');
    expect(sideHold(view, 'long')).toBe(view.hold);
    // The limit is the server's: another limit, another line.
    const wider = ready({ limits: { ...LIMITS, maxPositionUsd: 1_000 }, positions: [sized('99500')] });
    expect(ticketView(wider, 'BTC/USD', NOTHING_PICKED).hold).toBe(
      'The BTC position is $995.00 at entry. A position here is at most $1,000.',
    );
    expect(ticketView(wider, 'BTC/USD', NOTHING_PICKED).limits?.position).toBe('Up to $1,000');
  });

  it('measures a position against the limit on its integer atoms, whatever their scale', () => {
    // Atoms wider than a double holds exactly: 90,071,992,547,409.93 dollars at entry, $90.07 under the limit.
    const huge = ready({
      limits: { ...LIMITS, maxPositionUsd: 90_071_992_547_500 },
      positions: [sized('9007199254740993')],
    });
    expect(ticketView(huge, 'BTC/USD', NOTHING_PICKED).sizesOff).toEqual([100]);
    // Six decimals instead of two: $250.000001 at entry leaves room for $25 and not for $50.
    const fine = ready({ positions: [{ ...POSITION, notional: { atoms: '250000001', decimals: 6 } }] });
    expect(ticketView(fine, 'BTC/USD', NOTHING_PICKED).sizesOff).toEqual([50, 100]);
  });

  it('holds when the account takes no orders, the venue lists no market, or the market is closed', () => {
    expect(ticketView(ready({ canTrade: false }), 'BTC/USD', NOTHING_PICKED).hold).toBe(
      'The shared account is not taking orders right now.',
    );
    const unlisted = ticketView(ready(), 'avax/usd', NOTHING_PICKED);
    expect(unlisted.hold).toBe('Perpl lists no market for AVAX/USD.');
    expect(unlisted.leverages).toEqual([]);
    expect(unlisted.leverage).toBeNull();
    expect(ticketView(ready(), 'SOL/USD', NOTHING_PICKED).hold).toBe('The SOL market is closed.');
    const noSize = ready({ limits: { ...LIMITS, minNotionalUsd: 50, maxNotionalUsd: 20 } });
    expect(ticketView(noSize, 'BTC/USD', NOTHING_PICKED).hold).toBe('No order size fits the limits in force.');
  });
});

describe('what a control says', () => {
  const open = ticketView(ready(), 'BTC/USD', { usd: 25, leverage: 2 });
  const held = ticketView(ready({ positions: [POSITION] }), 'BTC/USD', { usd: 25, leverage: 5 });
  const full = ticketView(ready({ positions: [sized('29512')] }), 'BTC/USD', NOTHING_PICKED);
  const NOTE = 'The account holds a BTC long. Close it before opening a short.';

  it('names the order in full', () => {
    expect(openOrderLabel('long', 25, 2)).toBe('Open long, 25 dollars, 2x');
    expect(openOrderLabel('short', 100, 5)).toBe('Open short, 100 dollars, 5x');
    expect(addOrderLabel('long', 25, 2)).toBe('Add to the long, 25 dollars, 2x');
    expect(closePositionLabel(POSITION)).toBe('Close the BTC long position, 0.00041 BTC');
  });

  it('says what is on its way, and for a close, on which market', () => {
    expect(sendingLine({ action: 'open', side: 'long' })).toBe('Sending the order…');
    expect(sendingLine({ action: 'close', asset: 'BTC/USD' })).toBe('Closing the BTC position…');
    // A close sent from the positions list is not always for the market on the chart.
    expect(sendingLine({ action: 'close', asset: 'ETH/USD' })).toBe('Closing the ETH position…');
    expect(isClosing({ action: 'close', asset: 'ETH/USD' }, 'eth / usd')).toBe(true);
    expect(isClosing({ action: 'close', asset: 'ETH/USD' }, 'BTC/USD')).toBe(false);
    expect(isClosing({ action: 'open', side: 'long' }, 'BTC/USD')).toBe(false);
    expect(isClosing(null, 'BTC/USD')).toBe(false);
  });

  it('says beside the buttons what is on its way, else why nothing can be sent, else why one side is off', () => {
    expect(ticketLine(held, { action: 'close', asset: 'BTC/USD' })).toBe('Closing the BTC position…');
    expect(ticketLine(held, null)).toBe(NOTE);
    expect(ticketLine(open, null)).toBeNull();
    expect(ticketLine(full, null)).toBe('The BTC position is $295.12 at entry. A position here is at most $300.');
    expect(ticketLine(ticketView(ready(), 'SOL/USD', NOTHING_PICKED), null)).toBe('The SOL market is closed.');
  });

  it("adds the other side's reason on a second line only when the first is taken by another", () => {
    expect(ticketSecondLine(full, null)).toBe(NOTE);
    // Already the first line, or nothing to say, or an order on its way: no second line.
    expect(ticketSecondLine(held, null)).toBeNull();
    expect(ticketSecondLine(open, null)).toBeNull();
    expect(ticketSecondLine(full, { action: 'close', asset: 'BTC/USD' })).toBeNull();
    expect(ticketSecondLine(ticketView({ status: 'loading' }, 'BTC/USD', NOTHING_PICKED), null)).toBeNull();
  });

  it('offers LONG and SHORT as opens while nothing is held', () => {
    expect(sideButton(open, 'long', false)).toEqual({
      word: 'LONG',
      accessibilityLabel: 'Open long, 25 dollars, 2x',
      sheetLabel: 'Long: open the order ticket',
      disabled: false,
    });
    expect(sideButton(open, 'short', false)).toEqual({
      word: 'SHORT',
      accessibilityLabel: 'Open short, 25 dollars, 2x',
      sheetLabel: 'Short: open the order ticket',
      disabled: false,
    });
    // An order out, or its account read not yet back: the words stay, the press is off.
    expect(sideButton(open, 'long', true)).toMatchObject({ word: 'LONG', disabled: true });
  });

  it("words the open position's side as an add, at the position's leverage, and keeps the other side off with the reason", () => {
    expect(sideButton(held, 'long', false)).toEqual({
      word: 'ADD LONG',
      accessibilityLabel: 'Add to the long, 25 dollars, 2x',
      sheetLabel: 'Add to the long: open the order ticket',
      disabled: false,
    });
    expect(sideButton(held, 'short', false)).toEqual({
      word: 'SHORT',
      accessibilityLabel: `Short. ${NOTE}`,
      sheetLabel: `Short. ${NOTE}`,
      disabled: true,
    });
    expect(sideButton(held, 'long', true)).toMatchObject({ word: 'ADD LONG', disabled: true });
  });

  it('turns the add off, saying why, when nothing more fits or the ticket holds', () => {
    expect(sideButton(full, 'long', false)).toEqual({
      word: 'ADD LONG',
      accessibilityLabel: 'Add to the long. The BTC position is $295.12 at entry. A position here is at most $300.',
      sheetLabel: 'Add to the long. The BTC position is $295.12 at entry. A position here is at most $300.',
      disabled: true,
    });
    expect(sideButton(full, 'short', false)).toMatchObject({ accessibilityLabel: `Short. ${NOTE}`, disabled: true });
    const closed = ticketView(ready(), 'SOL/USD', NOTHING_PICKED);
    expect(sideButton(closed, 'long', false)).toMatchObject({
      word: 'LONG',
      accessibilityLabel: 'Long. The SOL market is closed.',
      disabled: true,
    });
    const loading = ticketView({ status: 'loading' }, 'BTC/USD', NOTHING_PICKED);
    expect(sideButton(loading, 'short', false)).toMatchObject({
      accessibilityLabel: 'Short. Reading the trading account.',
      disabled: true,
    });
  });

  it('says why a size chip is off', () => {
    const tight = ticketView(ready({ positions: [sized('26000')] }), 'BTC/USD', NOTHING_PICKED);
    expect(sizeChipLabel(tight, 25)).toBe('Size 25 dollars');
    expect(sizeChipLabel(tight, 100)).toBe('Size 100 dollars. The position would pass its limit (up to $300).');
    expect(sizeChipLabel(open, 100)).toBe('Size 100 dollars');
  });
});

describe('positionFacts', () => {
  it("is the position's own figures: size, entry, leverage and collateral, and no result", () => {
    const facts = positionFacts(POSITION);
    expect(facts).toEqual([
      ['Size', '0.00041 BTC'],
      ['Entry', '61,234.5'],
      ['Leverage', '2x'],
      ['Collateral', '12.50 AUSD'],
    ]);
    // The hard rule: no profit or loss, under any name.
    expect(facts.map(([label]) => label).join(' ')).not.toMatch(/p&l|pnl|profit|loss|return|result|mark/i);
  });
});

describe('sheetPrimary', () => {
  const open = ticketView(ready(), 'BTC/USD', { usd: 25, leverage: 2 });
  const held = ticketView(ready({ positions: [POSITION] }), 'BTC/USD', { usd: 25, leverage: 5 });
  const full = ticketView(ready({ positions: [sized('29512')] }), 'BTC/USD', NOTHING_PICKED);
  const pick = (side: 'long' | 'short' | null, intent: 'add' | 'close' = 'close') => ({ side, intent });

  it('waits for a side: it never picks one', () => {
    expect(sheetPrimary(open, pick(null), null, false)).toEqual({
      action: null,
      side: null,
      label: 'CHOOSE LONG OR SHORT',
      accessibilityLabel: 'Choose long or short first',
      disabled: true,
    });
  });

  it('opens on the side picked, at the size and leverage in force', () => {
    expect(sheetPrimary(open, pick('long'), null, false)).toEqual({
      action: 'open',
      side: 'long',
      label: 'OPEN LONG · $25 · 2x',
      accessibilityLabel: 'Open long, 25 dollars, 2x',
      disabled: false,
    });
    expect(sheetPrimary(open, pick('short'), null, false)).toMatchObject({ action: 'open', side: 'short', label: 'OPEN SHORT · $25 · 2x' });
    // With nothing held there is nothing to add to or close: the intent changes nothing.
    expect(sheetPrimary(open, pick('long', 'add'), null, false)).toMatchObject({ action: 'open', label: 'OPEN LONG · $25 · 2x' });
  });

  it('closes the position when one is open and the sheet is set to close, whatever side was picked', () => {
    const close = {
      action: 'close',
      side: null,
      label: 'CLOSE LONG · 0.00041 BTC',
      accessibilityLabel: 'Close the BTC long position, 0.00041 BTC',
      disabled: false,
    };
    expect(sheetPrimary(held, pick('short'), null, false)).toEqual(close);
    expect(sheetPrimary(held, pick(null), null, false)).toEqual(close);
    expect(sheetPrimary(held, pick('long'), null, false)).toEqual(close);
    // A position that cannot be added to can still be closed.
    expect(sheetPrimary(full, pick(null), null, false)).toMatchObject({ action: 'close', disabled: false });
  });

  it("adds on the position's own side, at its leverage, when the sheet is set to add", () => {
    expect(sheetPrimary(held, pick(null, 'add'), null, false)).toEqual({
      action: 'open',
      side: 'long',
      label: 'ADD LONG · $25 · 2x',
      accessibilityLabel: 'Add to the long, 25 dollars, 2x',
      disabled: false,
    });
    // The side picked before the position opened cannot turn an add into an order the server refuses.
    expect(sheetPrimary(held, pick('short', 'add'), null, false)).toMatchObject({ action: 'open', side: 'long', label: 'ADD LONG · $25 · 2x' });
  });

  it('sends nothing when set to add and adding is off, and says why', () => {
    expect(sheetPrimary(full, pick(null, 'add'), null, false)).toEqual({
      action: null,
      side: null,
      label: 'ADDING IS OFF',
      accessibilityLabel: 'The BTC position is $295.12 at entry. A position here is at most $300.',
      disabled: true,
    });
  });

  it('starts on close, and on add only when opened from the button for the side already held', () => {
    expect(openingIntent(held, null)).toBe('close');
    expect(openingIntent(held, 'long')).toBe('add');
    expect(openingIntent(held, 'short')).toBe('close');
    expect(openingIntent(open, 'long')).toBe('close');
    expect(openingIntent(open, null)).toBe('close');
  });

  it('is off while an order is out, and until the account has been read after one', () => {
    expect(sheetPrimary(open, pick('long'), { action: 'open', side: 'long' }, true)).toMatchObject({
      action: null,
      side: 'long',
      label: 'SENDING…',
      accessibilityLabel: 'Sending the order…',
      disabled: true,
    });
    expect(sheetPrimary(held, pick(null), { action: 'close', asset: 'BTC/USD' }, true)).toMatchObject({
      action: null,
      label: 'CLOSING…',
      accessibilityLabel: 'Closing the BTC position…',
      disabled: true,
    });
    expect(sheetPrimary(open, pick('long'), null, true)).toMatchObject({ action: 'open', disabled: true });
    expect(sheetPrimary(held, pick(null), null, true)).toMatchObject({ action: 'close', disabled: true });
    expect(sheetPrimary(held, pick(null, 'add'), null, true)).toMatchObject({ action: 'open', side: 'long', disabled: true });
  });

  it('sends nothing while the ticket holds', () => {
    const closed = ticketView(ready(), 'SOL/USD', NOTHING_PICKED);
    expect(sheetPrimary(closed, pick('long'), null, false)).toEqual({
      action: null,
      side: null,
      label: 'NOT AVAILABLE RIGHT NOW',
      accessibilityLabel: 'The SOL market is closed.',
      disabled: true,
    });
    const signedOut = ticketView({ status: 'unavailable', message: 'Sign in to trade.' }, 'BTC/USD', NOTHING_PICKED);
    expect(sheetPrimary(signedOut, pick('long'), null, false)).toMatchObject({ action: null, disabled: true });
  });

  it('says over the action what it is waiting on, and nothing about adding while set to close', () => {
    expect(sheetLine(full, 'add', null)).toBe('The BTC position is $295.12 at entry. A position here is at most $300.');
    expect(sheetLine(full, 'close', null)).toBeNull();
    expect(sheetLine(held, 'add', null)).toBeNull();
    expect(sheetLine(held, 'close', { action: 'close', asset: 'BTC/USD' })).toBe('Closing the BTC position…');
    expect(sheetLine(open, 'close', null)).toBeNull();
    // With nothing held the intent is not in play: a hold is a hold.
    expect(sheetLine(ticketView(ready(), 'SOL/USD', NOTHING_PICKED), 'close', null)).toBe('The SOL market is closed.');
  });
});

describe('outcomeView', () => {
  const context = { asset: 'BTC/USD', network: 'testnet' } as const;

  it('shows a fill with its side, size, price, fee, block and transaction', () => {
    expect(outcomeView(FILLED, context)).toEqual({
      status: 'filled',
      label: 'FILLED',
      asset: 'BTC/USD',
      text: 'Opened long 0.00041 BTC at 61,234.5.',
      headline: 'Opened long',
      side: 'long',
      facts: [
        ['Size', '0.00041 BTC'],
        ['Price', '61,234.5'],
        ['Fee', '0.00875 AUSD'],
        ['Block', '12,345,678'],
      ],
      tx: venueTx('testnet', HASH),
      txMissing: null,
    });
  });

  it('says so when a fill came back with no price or no transaction hash', () => {
    const view = outcomeView({ ...FILLED, action: 'close', side: 'short', price: null, txHash: null }, context);
    expect(view.text).toBe('Closed short 0.00041 BTC.');
    expect(view.headline).toBe('Closed short');
    expect(view.facts[1]).toEqual(['Price', 'Not reported yet']);
    expect(view.tx).toBeNull();
    expect(view.txMissing).toBe(TX_NOT_REPORTED);
  });

  it('shows a fill answered before the venue listed it: every figure still missing reads "Not reported yet"', () => {
    expect(NOT_REPORTED_YET).toBe('Not reported yet');
    expect(outcomeView(EARLY, context)).toEqual({
      status: 'filled',
      label: 'FILLED',
      asset: 'BTC/USD',
      text: 'Opened long 0.00041 BTC.',
      headline: 'Opened long',
      side: 'long',
      facts: [
        ['Size', '0.00041 BTC'],
        ['Price', 'Not reported yet'],
        ['Fee', 'Not reported yet'],
        ['Block', 'Not reported yet'],
      ],
      tx: null,
      txMissing: TX_NOT_REPORTED,
    });
    // Each figure stands alone: one that is known is shown beside one that is not.
    const partial = outcomeView({ ...EARLY, price: FILLED.price, block: 12_345_678 }, context);
    expect(partial.facts).toEqual([
      ['Size', '0.00041 BTC'],
      ['Price', '61,234.5'],
      ['Fee', 'Not reported yet'],
      ['Block', '12,345,678'],
    ]);
    // It is a fill, said the same neutral way: nothing about it is worded as a fault.
    expect(`${partial.label} ${partial.text} ${partial.txMissing}`).not.toMatch(/sorry|error|failed|oops|unfortunately/i);
  });

  it('calls a negative fee a rebate', () => {
    expect(outcomeView({ ...FILLED, fee: { atoms: '-1200', decimals: 6 } }, context).facts[2]).toEqual(['Rebate', '0.0012 AUSD']);
  });

  it("gives a refusal the server's reason, word for word, as an answer like any other", () => {
    const reason = 'The account already holds a BTC position. Close it before opening another.';
    const view = outcomeView({ status: 'refused', reason }, context);
    expect(view).toEqual({
      status: 'refused',
      label: 'REFUSED',
      asset: 'BTC/USD',
      text: reason,
      headline: null,
      side: null,
      facts: [],
      tx: null,
      txMissing: null,
    });
    // Nothing is added to it: no apology and no word that makes it a fault.
    expect(`${view.label} ${view.text}`).not.toMatch(/sorry|error|failed|oops|unfortunately/i);
  });

  it("gives every other answer the server's message, word for word", () => {
    const cases: Array<[VenueOrderResult, string, string]> = [
      [{ status: 'unfilled', orderId: 'o', message: 'The venue took the order and nothing filled.' }, 'NOT FILLED', 'The venue took the order and nothing filled.'],
      [{ status: 'pending', orderId: 'o', message: 'The order was sent and the venue has not reported its result yet. It may still fill. Check the position before sending another.' }, 'SENT', 'The order was sent and the venue has not reported its result yet. It may still fill. Check the position before sending another.'],
      [{ status: 'busy', message: 'Another order is on its way to this account.' }, 'BUSY', 'Another order is on its way to this account.'],
      [{ status: 'unavailable', message: 'The venue could not be reached. Nothing was sent.' }, 'UNAVAILABLE', 'The venue could not be reached. Nothing was sent.'],
      [{ status: 'rate_limited', retryAfterMs: 1, message: 'Too many orders this hour.' }, 'RATE LIMITED', 'Too many orders this hour.'],
    ];
    for (const [result, label, text] of cases) {
      expect(outcomeView(result, { asset: 'eth/usd', network: 'testnet' })).toMatchObject({
        label,
        text,
        asset: 'ETH/USD',
        facts: [],
        tx: null,
        txMissing: null,
      });
    }
  });
});

describe('an order that was sent and has not reported back', () => {
  it('has its own label, neither a fill nor a fault, and no figures or transaction it does not have', () => {
    const message = 'The order was sent, but the venue could not be read afterwards. Check the position before sending another.';
    const view = outcomeView({ status: 'pending', orderId: 'o9', message }, { asset: 'BTC/USD', network: 'testnet' });
    expect(view).toEqual({
      status: 'pending',
      label: 'SENT',
      asset: 'BTC/USD',
      text: message,
      headline: null,
      side: null,
      facts: [],
      tx: null,
      txMissing: null,
    });
    expect(view.label).not.toMatch(/fail|error|filled/i);
    // Nothing follows it: its row is not completed later, so the ticket does not wait on one.
    expect(fillAwaitsFigures({ status: 'pending', orderId: 'o9', message })).toBe(false);
  });
});

describe('a fill that completes itself', () => {
  const context = { asset: 'BTC/USD', network: 'testnet' } as const;

  it('is followed only while a figure or the transaction is missing', () => {
    expect(fillAwaitsFigures(EARLY)).toBe(true);
    expect(fillAwaitsFigures({ ...FILLED, txHash: null })).toBe(true);
    expect(fillAwaitsFigures({ ...FILLED, txHash: '' })).toBe(true);
    expect(fillAwaitsFigures({ ...FILLED, price: null })).toBe(true);
    expect(fillAwaitsFigures({ ...FILLED, fee: null })).toBe(true);
    expect(fillAwaitsFigures({ ...FILLED, block: null })).toBe(true);
    expect(fillAwaitsFigures(FILLED)).toBe(false);
    expect(fillAwaitsFigures({ status: 'refused', reason: 'The BTC market is closed.' })).toBe(false);
    expect(fillAwaitsFigures({ status: 'unfilled', orderId: 'o1', message: 'Nothing filled.' })).toBe(false);
  });

  it("takes its price, fee, block and transaction from the row with its order's id", () => {
    const other: VenueOrder = { ...ROW, id: 'o0', txHash: `0x${'cd'.repeat(32)}`, block: 1 };
    const done = completeFill(EARLY, [other, ROW]);
    expect(done).toEqual(FILLED);
    expect(fillAwaitsFigures(done)).toBe(false);
    // What the ticket then shows is exactly what a fill answered whole shows, link included.
    expect(outcomeView(done, context)).toEqual(outcomeView(FILLED, context));
    expect(outcomeView(done, context).tx).toEqual(venueTx('testnet', HASH));
    expect(outcomeView(done, context).txMissing).toBeNull();
  });

  it('hands back the same answer while the row has gained nothing, so nothing re-renders', () => {
    const bare: VenueOrder = { ...ROW, fillPrice: null, fee: null, block: null, txHash: null };
    expect(completeFill(EARLY, [bare])).toBe(EARLY);
    expect(completeFill(EARLY, [])).toBe(EARLY);
    expect(completeFill(EARLY, [{ ...ROW, id: 'o2' }])).toBe(EARLY);
    // Already whole: no row is looked at.
    expect(completeFill(FILLED, [{ ...ROW, txHash: `0x${'cd'.repeat(32)}` }])).toBe(FILLED);
  });

  it('stays a fill while its row still says the order is on its way, then takes the figures as they land', () => {
    // The server answers before the row is fully written. The row is read three times here, as it changes.
    const bare = { fillPrice: null, fee: null, block: null, txHash: null } as const;
    const submitting: VenueOrder = { ...ROW, ...bare, status: 'submitting', settledAt: null, size: null };
    const first = completeFill(EARLY, [submitting]);
    expect(first).toBe(EARLY);
    expect(outcomeView(first, context)).toMatchObject({ status: 'filled', label: 'FILLED', headline: 'Opened long' });
    expect(fillAwaitsFigures(first)).toBe(true);

    // Recorded as filled, figures not in yet: still nothing to add, still listening.
    const second = completeFill(first, [{ ...ROW, ...bare }]);
    expect(second).toBe(EARLY);
    expect(fillAwaitsFigures(second)).toBe(true);

    const third = completeFill(second, [ROW]);
    expect(third).toEqual(FILLED);
    expect(fillAwaitsFigures(third)).toBe(false);
  });

  it('is never turned into another answer by what its row says', () => {
    // Whatever status a row carries, the answer on screen keeps the status the server answered with.
    for (const status of ['submitting', 'unfilled', 'refused', 'failed'] as const) {
      const row: VenueOrder = { ...ROW, status, reason: 'The venue could not be reached. Nothing was sent.' };
      expect(completeFill(EARLY, [row]).status).toBe('filled');
    }
  });

  it('fills in what has arrived and keeps waiting on the rest', () => {
    const some = completeFill(EARLY, [{ ...ROW, txHash: null }]);
    expect(some).toMatchObject({ price: FILLED.price, fee: FILLED.fee, block: 12_345_678, txHash: null });
    expect(fillAwaitsFigures(some)).toBe(true);
    expect(outcomeView(some, context).txMissing).toBe(TX_NOT_REPORTED);
    // The transaction lands on a later update of the same row.
    expect(completeFill(some, [ROW])).toEqual(FILLED);
  });

  it('never replaces a figure the server answered with', () => {
    // A new position is answered with its entry price and block; the row's later figures do not overwrite them.
    const answered = { ...EARLY, price: { atoms: '612300', decimals: 1 }, block: 12_345_600 };
    const done = completeFill(answered, [ROW]);
    expect(done).toMatchObject({
      price: { atoms: '612300', decimals: 1 },
      block: 12_345_600,
      fee: FILLED.fee,
      txHash: HASH,
    });
    // The size is the answer's too: a row is never where a size comes from.
    expect(completeFill(EARLY, [{ ...ROW, size: { atoms: '99', decimals: 8 } }])).toMatchObject({ size: EARLY.size });
  });

  it('leaves every other answer as it is', () => {
    const refused: VenueOrderResult = { status: 'refused', reason: 'The BTC market is closed.' };
    const unfilled: VenueOrderResult = { status: 'unfilled', orderId: 'o1', message: 'Nothing filled.' };
    const pending: VenueOrderResult = { status: 'pending', orderId: 'o1', message: 'It may still fill.' };
    expect(completeFill(refused, [ROW])).toBe(refused);
    expect(completeFill(unfilled, [ROW])).toBe(unfilled);
    expect(completeFill(pending, [ROW])).toBe(pending);
  });

  it('keeps a rebate a rebate when the fee arrives late', () => {
    const done = completeFill(EARLY, [{ ...ROW, fee: { atoms: '-1200', decimals: 6 } }]);
    expect(outcomeView(done, context).facts[2]).toEqual(['Rebate', '0.0012 AUSD']);
  });
});

describe("the phone's bar", () => {
  const open = ticketView(ready(), 'BTC/USD', { usd: 25, leverage: 2 });
  const held = ticketView(ready({ positions: [POSITION] }), 'BTC/USD', NOTHING_PICKED);
  const full = ticketView(ready({ positions: [sized('29512')] }), 'BTC/USD', NOTHING_PICKED);
  const refused = outcomeView({ status: 'refused', reason: 'The BTC market is closed.' }, { asset: 'BTC/USD', network: 'testnet' });

  it('says, in order: what is on its way, why nothing can be sent, the last answer, why a side is off, whose account it is', () => {
    expect(barLine(full, { action: 'close', asset: 'BTC/USD' }, refused)).toBe('Closing the BTC position…');
    expect(barLine(full, null, refused)).toBe('The BTC position is $295.12 at entry. A position here is at most $300.');
    expect(barLine(held, null, refused)).toBe('REFUSED · The BTC market is closed.');
    expect(barLine(held, null, null)).toBe('The account holds a BTC long. Close it before opening a short.');
    expect(barLine(open, null, refused)).toBe('REFUSED · The BTC market is closed.');
    expect(barLine(open, null, null)).toBe('Perpl testnet · shared demo account');
  });

  it('gains the price in its one line once a fill has it', () => {
    const context = { asset: 'BTC/USD', network: 'testnet' } as const;
    expect(barLine(held, null, outcomeView(EARLY, context))).toBe('FILLED · Opened long 0.00041 BTC.');
    expect(barLine(held, null, outcomeView(completeFill(EARLY, [ROW]), context))).toBe(
      'FILLED · Opened long 0.00041 BTC at 61,234.5.',
    );
  });

  it('shows the size and leverage a new order starts from, so neither is hidden', () => {
    expect(barSummary(open)).toBe('$25 · 2x');
    expect(barSummary(held)).toBe('POSITION');
    expect(barSummary(ticketView({ status: 'loading' }, 'BTC/USD', NOTHING_PICKED))).toBe('TICKET');
  });
});

describe('positionRowView', () => {
  it("is a position's own figures: market, side, size, entry and leverage", () => {
    expect(positionRowView(POSITION)).toEqual({
      asset: 'BTC/USD',
      chartAsset: 'BTC/USD',
      side: 'long',
      sideWord: 'LONG',
      size: '0.00041 BTC',
      entry: '61,234.5',
      leverage: '2x',
      accessibilityLabel: 'Show BTC/USD on the chart. Long, 0.00041 BTC, entry 61,234.5, 2x',
      closeLabel: 'Close the BTC long position, 0.00041 BTC',
    });
    const short = positionRowView({ ...POSITION, asset: 'eth/usd', side: 'short', leverage: 2.5 });
    expect(short).toMatchObject({
      asset: 'ETH/USD',
      chartAsset: 'ETH/USD',
      sideWord: 'SHORT',
      leverage: '2.5x',
      accessibilityLabel: 'Show ETH/USD on the chart. Short, 0.00041 ETH, entry 61,234.5, 2.5x',
      closeLabel: 'Close the ETH short position, 0.00041 ETH',
    });
  });

  it('shows no result of the position, under any name', () => {
    // The hard rule. Its size at entry is not a result, but it is not a row's to show either.
    const row = positionRowView(POSITION);
    expect(Object.keys(row).join(' ')).not.toMatch(/p&l|pnl|profit|loss|return|result|mark|value|notional|balance/i);
    expect(Object.values(row).join(' ')).not.toMatch(/25\.10/);
  });

  it('is not a way to the chart for a market the chart does not draw, and can still be closed', () => {
    const row = positionRowView({ ...POSITION, asset: 'DOGE/USD' });
    expect(row.chartAsset).toBeNull();
    expect(row.accessibilityLabel).toBe('DOGE/USD. Long, 0.00041 DOGE, entry 61,234.5, 2x');
    expect(row.closeLabel).toBe('Close the DOGE long position, 0.00041 DOGE');
  });
});

describe('orderRowView', () => {
  const base: VenueOrder = {
    id: 'o1',
    network: 'testnet',
    asset: 'BTC/USD',
    action: 'open',
    side: 'long',
    status: 'filled',
    createdAt: 1_000_000,
    settledAt: 1_004_000,
    notionalUsd: 25,
    leverage: 2,
    requestId: 9,
    size: { atoms: '41000', decimals: 8 },
    fillPrice: { atoms: '612345', decimals: 1 },
    fee: { atoms: '8750', decimals: 6 },
    block: 5,
    txHash: HASH,
    reason: null,
  };
  const NOW = 1_010_000;

  it('shows a fill with its size, price and transaction', () => {
    expect(orderRowView(base, NOW)).toEqual({
      id: 'o1',
      title: 'BTC/USD · Open long',
      side: 'long',
      label: 'FILLED',
      detail: '0.00041 BTC at 61,234.5',
      at: 1_000_000,
      tx: venueTx('testnet', HASH),
      txMissing: false,
    });
  });

  it('says a fill has no transaction hash instead of leaving the evidence blank', () => {
    expect(orderRowView({ ...base, txHash: null }, NOW)).toMatchObject({ tx: null, txMissing: true });
    expect(orderRowView({ ...base, fillPrice: null }, NOW).detail).toBe('0.00041 BTC');
  });

  it("gives a refusal its reason, word for word, and no transaction", () => {
    const row = orderRowView(
      { ...base, status: 'refused', size: null, fillPrice: null, txHash: null, reason: 'The BTC market is closed.' },
      NOW,
    );
    expect(row).toMatchObject({ label: 'REFUSED', detail: 'The BTC market is closed.', tx: null, txMissing: false });
  });

  it('titles a close that was refused before the position was read without a side', () => {
    const row = orderRowView({ ...base, action: 'close', side: null, status: 'refused', reason: 'The account holds no BTC position.' }, NOW);
    expect(row.title).toBe('BTC/USD · Close');
    expect(row.side).toBeNull();
  });

  it('words the orders that did not fill or did not report', () => {
    expect(orderRowView({ ...base, status: 'unfilled', txHash: null }, NOW)).toMatchObject({
      label: 'NOT FILLED',
      detail: 'Nothing filled. Nothing is left on the book.',
    });
    expect(orderRowView({ ...base, status: 'failed', txHash: null, reason: 'The venue could not be reached. Nothing was sent.' }, NOW)).toMatchObject({
      label: 'NO RESULT',
      detail: 'The venue could not be reached. Nothing was sent.',
    });
    expect(orderRowView({ ...base, status: 'failed', txHash: null }, NOW).detail).toBe('The result could not be read.');
  });

  it('shows an order on its way with what was asked, and stops saying so once it is plainly not', () => {
    const sending: VenueOrder = { ...base, status: 'submitting', size: null, fillPrice: null, txHash: null };
    expect(orderRowView(sending, NOW)).toMatchObject({ label: 'SENDING', detail: '$25 · 2x', tx: null });
    expect(orderRowView({ ...sending, action: 'close', notionalUsd: null, leverage: null }, NOW).detail).toBe('On its way to the venue.');
    expect(orderRowView(sending, sending.createdAt + STALE_SENDING_MS + 1)).toMatchObject({
      label: 'NO RESULT',
      detail: 'This order never reported back.',
    });
    // No clock yet (the server render): nothing is called stale.
    expect(orderRowView(sending, 0).label).toBe('SENDING');
  });
});
