import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_UNKNOWN_SHAPE,
  ORDER_UNKNOWN_SHAPE,
  STALE_SENDING_MS,
  TX_NOT_REPORTED,
  asAccount,
  asOrderResult,
  barLine,
  barSummary,
  chosenOption,
  closePositionLabel,
  feeFact,
  formatCollateral,
  formatLeverage,
  formatUsd,
  formatVenueSize,
  leverageSteps,
  marketOf,
  openOrderLabel,
  orderFromRow,
  orderRowView,
  ordersFromRows,
  outcomeView,
  positionFacts,
  positionOf,
  sendingLine,
  sheetPrimary,
  sizePresets,
  thrownMessage,
  ticketLine,
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

const LIMITS: VenueLimits = { minNotionalUsd: 10, maxNotionalUsd: 100, maxLeverage: 5, slippageBps: 100 };

const POSITION: VenuePositionView = {
  asset: 'BTC/USD',
  side: 'long',
  size: { atoms: '41000', decimals: 8 },
  entryPrice: { atoms: '612345', decimals: 1 },
  leverage: 2,
  collateral: { atoms: '12500000', decimals: 6 },
  openedAt: 1_760_000_000_000,
};

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
});

describe('asOrderResult', () => {
  it('passes each answer the server gives through', () => {
    expect(asOrderResult(FILLED)).toBe(FILLED);
    const bare = { ...FILLED, price: null, txHash: null };
    expect(asOrderResult(bare)).toBe(bare);
    expect(asOrderResult({ status: 'refused', reason: 'The BTC market is closed.' })).toEqual({
      status: 'refused',
      reason: 'The BTC market is closed.',
    });
    expect(asOrderResult({ status: 'unfilled', orderId: 'o2', message: 'Nothing filled.' })).toEqual({
      status: 'unfilled',
      orderId: 'o2',
      message: 'Nothing filled.',
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
    expect(asOrderResult({ ...FILLED, fee: undefined })).toEqual(unknown);
    expect(asOrderResult({ ...FILLED, side: 'flat' })).toEqual(unknown);
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
      fee: FILLED.fee,
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
      usd: null,
      leverages: [],
      leverage: null,
      position: null,
      network: null,
      hold: 'Reading the trading account.',
    });
    expect(view.venueLine).toBe('Perpl · shared demo account');
  });

  it("holds with the server's own message when the account is unavailable", () => {
    const view = ticketView({ status: 'unavailable', message: 'Sign in to trade.' }, 'BTC/USD', NOTHING_PICKED);
    expect(view).toMatchObject({ status: 'unavailable', message: 'Sign in to trade.', hold: 'Sign in to trade.', sizes: [] });
  });

  it('opens on the smallest size and 1x, with every limit worded from what the server sent', () => {
    const view = ticketView(ready(), 'BTC/USD', NOTHING_PICKED);
    expect(view).toMatchObject({
      status: 'ready',
      venueLine: 'Perpl testnet · shared demo account',
      network: 'testnet',
      sizes: [10, 25, 50, 100],
      usd: 10,
      leverages: [1, 2, 3, 4, 5],
      leverage: 1,
      position: null,
      hold: null,
    });
    expect(view.limits).toEqual({ orderType: 'Market, IOC', slippage: '1.00%', size: '$10 to $100', leverage: '1x to 5x' });
  });

  it('shows other limits when the server sends other limits: none of them is written into the ticket', () => {
    const account = ready({
      limits: { minNotionalUsd: 20, maxNotionalUsd: 2_000, maxLeverage: 10, slippageBps: 35 },
      markets: [{ asset: 'BTC/USD', maxLeverage: 8, open: true }],
    });
    const view = ticketView(account, 'BTC/USD', NOTHING_PICKED);
    expect(view.limits).toEqual({ orderType: 'Market, IOC', slippage: '0.35%', size: '$20 to $2,000', leverage: '1x to 8x' });
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

  it('holds while a position is open on this asset, and only on this asset', () => {
    const account = ready({ positions: [POSITION] });
    const btc = ticketView(account, 'BTC/USD', NOTHING_PICKED);
    expect(btc.position).toBe(POSITION);
    expect(btc.hold).toBe('Close the BTC position before opening another.');
    const eth = ticketView(account, 'ETH/USD', NOTHING_PICKED);
    expect(eth.position).toBeNull();
    expect(eth.hold).toBeNull();
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
  it('names the order in full', () => {
    expect(openOrderLabel('long', 25, 2)).toBe('Open long, 25 dollars, 2x');
    expect(openOrderLabel('short', 100, 5)).toBe('Open short, 100 dollars, 5x');
    expect(closePositionLabel(POSITION)).toBe('Close the BTC long position, 0.00041 BTC');
  });

  it('says what is on its way, else why nothing can be sent, else nothing', () => {
    const open = ticketView(ready(), 'BTC/USD', NOTHING_PICKED);
    const held = ticketView(ready({ positions: [POSITION] }), 'BTC/USD', NOTHING_PICKED);
    expect(sendingLine({ action: 'open', side: 'long' })).toBe('Sending the order…');
    expect(sendingLine({ action: 'close' })).toBe('Closing the position…');
    expect(ticketLine(held, { action: 'close' })).toBe('Closing the position…');
    expect(ticketLine(held, null)).toBe('Close the BTC position before opening another.');
    expect(ticketLine(open, null)).toBeNull();
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
  const held = ticketView(ready({ positions: [POSITION] }), 'BTC/USD', NOTHING_PICKED);

  it('waits for a side: it never picks one', () => {
    expect(sheetPrimary(open, null, null, false)).toEqual({
      action: null,
      side: null,
      label: 'CHOOSE LONG OR SHORT',
      accessibilityLabel: 'Choose long or short first',
      disabled: true,
    });
  });

  it('opens on the side picked, at the size and leverage in force', () => {
    expect(sheetPrimary(open, 'long', null, false)).toEqual({
      action: 'open',
      side: 'long',
      label: 'OPEN LONG · $25 · 2x',
      accessibilityLabel: 'Open long, 25 dollars, 2x',
      disabled: false,
    });
    expect(sheetPrimary(open, 'short', null, false)).toMatchObject({ action: 'open', side: 'short', label: 'OPEN SHORT · $25 · 2x' });
  });

  it('closes the position when one is open, whatever side was picked', () => {
    expect(sheetPrimary(held, 'short', null, false)).toEqual({
      action: 'close',
      side: null,
      label: 'CLOSE LONG · 0.00041 BTC',
      accessibilityLabel: 'Close the BTC long position, 0.00041 BTC',
      disabled: false,
    });
  });

  it('is off while an order is out, and until the account has been read after one', () => {
    expect(sheetPrimary(open, 'long', { action: 'open', side: 'long' }, true)).toMatchObject({
      action: null,
      side: 'long',
      label: 'SENDING…',
      accessibilityLabel: 'Sending the order…',
      disabled: true,
    });
    expect(sheetPrimary(held, null, { action: 'close' }, true)).toMatchObject({ action: null, label: 'CLOSING…', disabled: true });
    expect(sheetPrimary(open, 'long', null, true)).toMatchObject({ action: 'open', disabled: true });
    expect(sheetPrimary(held, null, null, true)).toMatchObject({ action: 'close', disabled: true });
  });

  it('sends nothing while the ticket holds', () => {
    const closed = ticketView(ready(), 'SOL/USD', NOTHING_PICKED);
    expect(sheetPrimary(closed, 'long', null, false)).toEqual({
      action: null,
      side: null,
      label: 'NOT AVAILABLE RIGHT NOW',
      accessibilityLabel: 'The SOL market is closed.',
      disabled: true,
    });
    const signedOut = ticketView({ status: 'unavailable', message: 'Sign in to trade.' }, 'BTC/USD', NOTHING_PICKED);
    expect(sheetPrimary(signedOut, 'long', null, false)).toMatchObject({ action: null, disabled: true });
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
    expect(view.facts[1]).toEqual(['Price', 'Not reported']);
    expect(view.tx).toBeNull();
    expect(view.txMissing).toBe(TX_NOT_REPORTED);
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

describe("the phone's bar", () => {
  const open = ticketView(ready(), 'BTC/USD', { usd: 25, leverage: 2 });
  const held = ticketView(ready({ positions: [POSITION] }), 'BTC/USD', NOTHING_PICKED);
  const refused = outcomeView({ status: 'refused', reason: 'The BTC market is closed.' }, { asset: 'BTC/USD', network: 'testnet' });

  it('says, in order: what is on its way, why its buttons are off, the last answer, whose account it is', () => {
    expect(barLine(held, { action: 'close' }, refused)).toBe('Closing the position…');
    expect(barLine(held, null, refused)).toBe('Close the BTC position before opening another.');
    expect(barLine(open, null, refused)).toBe('REFUSED · The BTC market is closed.');
    expect(barLine(open, null, null)).toBe('Perpl testnet · shared demo account');
  });

  it('shows the size and leverage a new order starts from, so neither is hidden', () => {
    expect(barSummary(open)).toBe('$25 · 2x');
    expect(barSummary(held)).toBe('POSITION');
    expect(barSummary(ticketView({ status: 'loading' }, 'BTC/USD', NOTHING_PICKED))).toBe('TICKET');
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
