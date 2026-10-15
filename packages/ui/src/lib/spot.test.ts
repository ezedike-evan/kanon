import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLIPPAGE_BPS,
  FILL_UNREAD_LINE,
  REVERTED_LINE,
  SPOT_CHECKING_SESSION,
  SPOT_NO_WALLET,
  SPOT_READING_WALLET,
  approvalLine,
  approvalNeeded,
  bookSpread,
  depthLine,
  failedOutcome,
  filledOutcome,
  floorToDecimals,
  marketEvidence,
  mintFailedNote,
  mintLabel,
  mintedNote,
  networkLabel,
  orderFacts,
  orderLine,
  parseSpotAmount,
  readSpotMarketAnswer,
  sizeLimits,
  sizeSpotOrder,
  spotGate,
  MONAD_TESTNET_FAUCET_URL,
  spotTx,
  summariseFill,
  testMintAmount,
  tokenLine,
  type SpotMarket,
  type SpotOrder,
  type SpotWallet,
} from './spot';

const MARKET_ADDRESS = '0x4aC0501686D10048d083Ae8d1e13b9817FF1FF41';
const BASE = '0x85495222Fd7069B987Ca38C2142732EbBFb7175D';
const QUOTE = '0x89b928df3A0F929578a3c93E1d6E3Be3433e539C';
const ME = '0x00000000000000000000000000000000000000aa';
const TX = `0x${'cd'.repeat(32)}`;

const level = (price: string, size: string) => ({
  price: { atoms: price, decimals: 4 },
  size: { atoms: size, decimals: 9 },
});

/** The gateway's answer for the listed market, as its own test writes it. */
const answer = (over: Record<string, unknown> = {}) => ({
  ok: true,
  asset: 'tkBTC/USDC',
  network: 'testnet',
  chainId: 10143,
  market: MARKET_ADDRESS,
  base: { address: BASE, name: 'Kanon Test BTC', symbol: 'tkBTC', decimals: 8, kind: 'test token, open mint' },
  quote: { address: QUOTE, name: 'Mock USDC', symbol: 'USDC', decimals: 6, kind: "Kanon's mock collateral token, open mint" },
  note: 'tkBTC is a test token. It is not bitcoin.',
  priceDecimals: 4,
  sizeDecimals: 9,
  minSize: { atoms: '100000', decimals: 9 },
  maxSize: { atoms: '1000000000', decimals: 9 },
  takerFeeBps: 30,
  bids: [level('824475248', '250000000'), level('820000000', '500000000')],
  asks: [level('832720000', '248756210'), level('840000000', '400000000')],
  blockNumber: 1234,
  readAt: 1_760_000_000_000,
  listing: { marketTx: `0x${'b2'.repeat(32)}`, tokenTx: `0x${'a1'.repeat(32)}` },
  ...over,
});

function market(over: Record<string, unknown> = {}): SpotMarket {
  const read = readSpotMarketAnswer(answer(over));
  if (!read || !read.ok) throw new Error('the fixture is not a market');
  return read.market;
}

function order(input: { side: 'buy' | 'sell'; amount: string; slippageBps?: number; market?: SpotMarket }): SpotOrder {
  const sized = sizeSpotOrder({
    market: input.market ?? market(),
    side: input.side,
    amount: input.amount,
    slippageBps: input.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
  });
  if (!sized.ok) throw new Error(`not sized: ${sized.message}`);
  return sized.order;
}

describe('readSpotMarketAnswer', () => {
  it('reads the listed market, with amounts as integers and explicit decimals', () => {
    const m = market();
    expect(m.asset).toBe('tkBTC/USDC');
    expect(m.market).toBe(MARKET_ADDRESS);
    expect(m.base).toMatchObject({ symbol: 'tkBTC', name: 'Kanon Test BTC', decimals: 8, kind: 'test token, open mint' });
    expect(m.quote).toMatchObject({ symbol: 'USDC', name: 'Mock USDC', decimals: 6 });
    expect(m.minSize).toEqual({ atoms: '100000', decimals: 9 });
    expect(m.asks[0]).toEqual(level('832720000', '248756210'));
    expect(m.listing).toEqual({ marketTx: `0x${'b2'.repeat(32)}`, tokenTx: `0x${'a1'.repeat(32)}` });
  });

  it('puts the best price first on each side, whatever order the rows arrived in', () => {
    const m = market({
      bids: [level('820000000', '1'), level('824475248', '1')],
      asks: [level('840000000', '1'), level('832720000', '1')],
    });
    expect(m.bids.map((l) => l.price.atoms)).toEqual(['824475248', '820000000']);
    expect(m.asks.map((l) => l.price.atoms)).toEqual(['832720000', '840000000']);
  });

  it("passes on the gateway's own sentence when there is no book to show", () => {
    expect(readSpotMarketAnswer({ ok: false, code: 'not_listed', message: 'No market is listed yet.' })).toEqual({
      ok: false,
      code: 'not_listed',
      message: 'No market is listed yet.',
    });
    expect(readSpotMarketAnswer({ ok: false, code: 'unreachable', message: 'Could not be read.' })).toMatchObject({
      ok: false,
      code: 'unreachable',
    });
  });

  it('knows nothing it was not sent: a malformed answer is no market, never a patched-up one', () => {
    expect(readSpotMarketAnswer(null)).toBeNull();
    expect(readSpotMarketAnswer('ok')).toBeNull();
    expect(readSpotMarketAnswer({ ok: false })).toBeNull();
    expect(readSpotMarketAnswer(answer({ market: '0x1234' }))).toBeNull();
    expect(readSpotMarketAnswer(answer({ priceDecimals: 4.5 }))).toBeNull();
    expect(readSpotMarketAnswer(answer({ takerFeeBps: 10_000 }))).toBeNull();
    expect(readSpotMarketAnswer(answer({ minSize: { atoms: '0.0001', decimals: 9 } }))).toBeNull();
    // A float where atoms belong is refused, not rounded.
    expect(readSpotMarketAnswer(answer({ asks: [{ price: 83272, size: 0.25 }] }))).toBeNull();
    // One bad row refuses the book: dropping it could promote a worse price to best.
    expect(readSpotMarketAnswer(answer({ asks: [level('0', '1'), level('832720000', '1')] }))).toBeNull();
    expect(readSpotMarketAnswer(answer({ base: { address: BASE, symbol: 'tkBTC', decimals: 8 } }))).toBeNull();
  });

  it('keeps only listing transactions that are transaction hashes', () => {
    const m = market({ listing: { marketTx: `0x${'b2'.repeat(32)}`, tokenTx: '0xnope', firstOrderTx: `0x${'c3'.repeat(32)}` } });
    expect(m.listing).toEqual({ marketTx: `0x${'b2'.repeat(32)}`, firstOrderTx: `0x${'c3'.repeat(32)}` });
  });
});

describe('what the market says about itself', () => {
  it('states the gap between the best ask and the best bid as a price and in basis points of the ask', () => {
    // 83,272.0000 less 82,447.5248.
    expect(bookSpread(market())).toEqual({ price: { atoms: '8244752', decimals: 4 }, bps: 99 });
  });

  it('states no gap with a side empty, or once the two sides have met', () => {
    expect(bookSpread(market({ bids: [] }))).toBeNull();
    expect(bookSpread(market({ asks: [] }))).toBeNull();
    expect(bookSpread(market({ bids: [level('832720000', '1')] }))).toBeNull();
  });

  it('states the sizes it takes, and mints a thousand whole test tokens in the quote token atoms', () => {
    expect(sizeLimits(market())).toBe('0.0001 to 1 tkBTC');
    expect(testMintAmount(market())).toEqual({ atoms: '1000000000', decimals: 6 });
  });
});

describe('parseSpotAmount', () => {
  it('reads a typed figure as atoms, with a point or a comma as the one separator', () => {
    expect(parseSpotAmount('83.272', 4)).toEqual({ ok: true, atoms: 832720n });
    expect(parseSpotAmount('83,272', 4)).toEqual({ ok: true, atoms: 832720n });
    expect(parseSpotAmount(' 25 ', 4)).toEqual({ ok: true, atoms: 250000n });
    expect(parseSpotAmount('.5', 4)).toEqual({ ok: true, atoms: 5000n });
    expect(parseSpotAmount('0.0010', 8)).toEqual({ ok: true, atoms: 100000n });
  });

  it('says empty for nothing and for zero, and invalid for anything that is not a figure', () => {
    expect(parseSpotAmount('', 4)).toEqual({ ok: false, reason: 'empty' });
    expect(parseSpotAmount('0.00', 4)).toEqual({ ok: false, reason: 'empty' });
    expect(parseSpotAmount('.', 4)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseSpotAmount('1,000.50', 4)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseSpotAmount('-5', 4)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseSpotAmount('1e3', 4)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses more places than the market takes instead of rounding them away', () => {
    expect(parseSpotAmount('83.27215', 4)).toEqual({ ok: false, reason: 'too_precise' });
    // Trailing zeros past the last place carry nothing, so they are not precision.
    expect(parseSpotAmount('83.27200', 4)).toEqual({ ok: true, atoms: 832720n });
  });
});

describe('sizeSpotOrder: a buy', () => {
  // The rehearsal on a fork: 83.272 USDC bought 0.001 tkBTC at 83272 and the wallet received 0.000997.
  it('sizes the rehearsed order in the contract units: price decimals in, base decimals out', () => {
    const o = order({ side: 'buy', amount: '83.272' });
    // approve: what is spent, at the quote token's 6 decimals.
    expect(o.spend).toEqual({ atoms: '83272000', decimals: 6 });
    expect(o.spendToken.symbol).toBe('USDC');
    // _quoteSize: the same figure at the market's 4 price decimals.
    expect(o.sizeArg).toEqual({ atoms: '832720', decimals: 4 });
    // 83.272 / 83272 = 0.001 tkBTC, at the 9 size decimals the limits are stated in.
    expect(o.baseSize).toEqual({ atoms: '1000000', decimals: 9 });
    // After the 0.30% fee: 0.000997, what the rehearsal's wallet received.
    expect(o.expectedOut).toEqual({ atoms: '99700', decimals: 8 });
    // _minAmountOut: that, less the 1.00% bound, floored at the base token's 8 decimals.
    expect(o.minOut).toEqual({ atoms: '98703', decimals: 8 });
    expect(o.bestPrice).toEqual({ atoms: '832720000', decimals: 4 });
    expect(o.exceedsBest).toBe(false);
  });

  it('floors the least accepted, and moves it with the bound', () => {
    expect(order({ side: 'buy', amount: '100', slippageBps: 50 })).toMatchObject({
      sizeArg: { atoms: '1000000', decimals: 4 },
      baseSize: { atoms: '1200883', decimals: 9 },
      expectedOut: { atoms: '119728', decimals: 8 },
      minOut: { atoms: '119129', decimals: 8 },
    });
    const tight = BigInt(order({ side: 'buy', amount: '100', slippageBps: 10 }).minOut.atoms);
    const loose = BigInt(order({ side: 'buy', amount: '100', slippageBps: 200 }).minOut.atoms);
    expect(tight).toBeGreaterThan(loose);
  });

  it('refuses a size outside the market limits in a plain sentence, before any transaction', () => {
    const m = market();
    // 5 USDC at 83272 is 0.00006 tkBTC, under the 0.0001 minimum.
    const small = sizeSpotOrder({ market: m, side: 'buy', amount: '5', slippageBps: 100 });
    expect(small).toMatchObject({ ok: false, reason: 'too_small' });
    expect(!small.ok && small.message).toBe(
      'That buys about 0.000060044 tkBTC at the best ask. The market takes no order under 0.0001 tkBTC.',
    );
    // 90,000 USDC at 83272 is over 1 tkBTC.
    const large = sizeSpotOrder({ market: m, side: 'buy', amount: '90000', slippageBps: 100 });
    expect(large).toMatchObject({ ok: false, reason: 'too_large' });
    expect(!large.ok && large.message).toContain('The market takes no order over 1 tkBTC.');
  });

  it('takes an order at exactly the smallest and the largest size', () => {
    // 8.3272 USDC is exactly 0.0001 tkBTC; 83,272 USDC is exactly 1.
    expect(order({ side: 'buy', amount: '8.3272' }).baseSize.atoms).toBe('100000');
    expect(order({ side: 'buy', amount: '83272' }).baseSize.atoms).toBe('1000000000');
  });

  it('says what the wallet holds when the order spends more', () => {
    const sized = sizeSpotOrder({
      market: market(),
      side: 'buy',
      amount: '100',
      slippageBps: 100,
      balance: { atoms: '25500000', decimals: 6 },
    });
    expect(sized).toEqual({ ok: false, reason: 'balance', message: 'This wallet holds 25.5 USDC. Get test USDC or enter less.' });
  });

  it('has nothing to size against when there are no asks, and says so', () => {
    const sized = sizeSpotOrder({ market: market({ asks: [] }), side: 'buy', amount: '100', slippageBps: 100 });
    expect(sized).toMatchObject({ ok: false, reason: 'no_book' });
    expect(!sized.ok && sized.message).toMatch(/no asks/);
  });

  it('asks for an amount, in words, when there is none or it is not a figure', () => {
    const m = market();
    expect(sizeSpotOrder({ market: m, side: 'buy', amount: '', slippageBps: 100 })).toEqual({
      ok: false,
      reason: 'empty',
      message: 'Enter how much USDC to spend.',
    });
    expect(sizeSpotOrder({ market: m, side: 'buy', amount: 'ten', slippageBps: 100 })).toMatchObject({ reason: 'invalid' });
    expect(sizeSpotOrder({ market: m, side: 'buy', amount: '10.00001', slippageBps: 100 })).toEqual({
      ok: false,
      reason: 'too_precise',
      message: 'USDC amounts on this market go to 4 decimal places.',
    });
  });

  it('notes an order larger than the best level, which would walk the book or revert', () => {
    // The best ask holds 0.24875621 tkBTC, about 20,714 USDC at 83272.
    const o = order({ side: 'buy', amount: '25000' });
    expect(o.exceedsBest).toBe(true);
    expect(depthLine(o)).toMatch(/more than the best ask holds/);
    expect(depthLine(order({ side: 'buy', amount: '100' }))).toBeNull();
  });
});

describe('sizeSpotOrder: a sell', () => {
  it('sizes in the contract units: size decimals in, quote decimals out', () => {
    const o = order({ side: 'sell', amount: '0.001' });
    // approve: what is sold, at the base token's 8 decimals.
    expect(o.spend).toEqual({ atoms: '100000', decimals: 8 });
    expect(o.spendToken.symbol).toBe('tkBTC');
    // _size: the same figure at the market's 9 size decimals.
    expect(o.sizeArg).toEqual({ atoms: '1000000', decimals: 9 });
    expect(o.baseSize).toEqual(o.sizeArg);
    // 0.001 * 82447.5248 = 82.4475248 USDC; less 0.30% is 82.200182; less 1.00% is 81.378180, floored at 6 decimals.
    expect(o.expectedOut).toEqual({ atoms: '82200182', decimals: 6 });
    expect(o.minOut).toEqual({ atoms: '81378180', decimals: 6 });
    expect(o.bestPrice).toEqual({ atoms: '824475248', decimals: 4 });
  });

  it('reads a sell at the base token precision, the finer of the two it has to fit', () => {
    // tkBTC has 8 decimals and the market 9: a ninth place could not be approved, so it is refused.
    expect(sizeSpotOrder({ market: market(), side: 'sell', amount: '0.001000001', slippageBps: 100 })).toEqual({
      ok: false,
      reason: 'too_precise',
      message: 'tkBTC amounts on this market go to 8 decimal places.',
    });
  });

  it('holds a sell to the same size limits and to the wallet balance', () => {
    const m = market();
    expect(sizeSpotOrder({ market: m, side: 'sell', amount: '0.00009', slippageBps: 100 })).toEqual({
      ok: false,
      reason: 'too_small',
      message: 'The market takes no order under 0.0001 tkBTC.',
    });
    expect(sizeSpotOrder({ market: m, side: 'sell', amount: '1.5', slippageBps: 100 })).toMatchObject({ reason: 'too_large' });
    expect(
      sizeSpotOrder({ market: m, side: 'sell', amount: '0.5', slippageBps: 100, balance: { atoms: '99700', decimals: 8 } }),
    ).toEqual({ ok: false, reason: 'balance', message: 'This wallet holds 0.000997 tkBTC. Buy some first or enter less.' });
    expect(sizeSpotOrder({ market: market({ bids: [] }), side: 'sell', amount: '0.5', slippageBps: 100 })).toMatchObject({
      reason: 'no_book',
    });
  });
});

describe('what the confirmation states', () => {
  const m = market();
  const wallet = (over: Partial<SpotWallet> = {}): SpotWallet => ({
    address: ME,
    native: { atoms: '1000000000000000000', decimals: 18 },
    nativeSymbol: 'MON',
    base: { atoms: '0', decimals: 8 },
    quote: { atoms: '1000000000', decimals: 6 },
    baseAllowance: { atoms: '0', decimals: 8 },
    quoteAllowance: { atoms: '0', decimals: 6 },
    ...over,
  });

  it('states the side, the amount, the price, the fee, the bound, the least received and the transactions', () => {
    const o = order({ side: 'buy', amount: '83.272' });
    expect(orderFacts(o, m, true)).toEqual([
      ['Side', 'Buy tkBTC with USDC'],
      ['You spend', '83.272 USDC'],
      ['Best ask', '83,272.0000 USDC'],
      ['Taker fee', '0.30%, out of what you receive'],
      ['At that price, after the fee', '0.000997 tkBTC'],
      ['Slippage bound', '1.00%'],
      ['Least received', '0.00098703 tkBTC'],
      ['Wallet transactions', '2: approval, then order'],
    ]);
    // The approval is for the order's spend and nothing more, and the confirmation says so.
    expect(approvalLine(o)).toBe('The approval lets the market move exactly 83.272 USDC from this wallet, and no more.');
    expect(orderLine(o)).toBe('Spend 83.272 USDC for at least 0.00098703 tkBTC.');
  });

  it('says one transaction when the market may already move what the order spends', () => {
    const o = order({ side: 'sell', amount: '0.001' });
    const facts = orderFacts(o, m, false);
    expect(facts[0]).toEqual(['Side', 'Sell tkBTC for USDC']);
    expect(facts[1]).toEqual(['You sell', '0.001 tkBTC']);
    expect(facts[2]).toEqual(['Best bid', '82,447.5248 USDC']);
    expect(facts[6]).toEqual(['Least received', '81.37818 USDC']);
    expect(facts[7]).toEqual(['Wallet transactions', '1: the order']);
    expect(orderFacts(o, m, null)[7]?.[1]).toBe('1 or 2: approval if needed');
    expect(orderLine(o)).toBe('Sell 0.001 tkBTC for at least 81.37818 USDC.');
  });

  it('needs an approval only while the allowance is short of what the order spends', () => {
    const buy = order({ side: 'buy', amount: '83.272' });
    expect(approvalNeeded(buy, wallet())).toBe(true);
    expect(approvalNeeded(buy, wallet({ quoteAllowance: { atoms: '83271999', decimals: 6 } }))).toBe(true);
    expect(approvalNeeded(buy, wallet({ quoteAllowance: { atoms: '83272000', decimals: 6 } }))).toBe(false);
    // A sell spends the base token, so the quote allowance says nothing about it.
    const sell = order({ side: 'sell', amount: '0.001' });
    expect(approvalNeeded(sell, wallet({ quoteAllowance: { atoms: '999999999999', decimals: 6 } }))).toBe(true);
    expect(approvalNeeded(sell, wallet({ baseAllowance: { atoms: '100000', decimals: 8 } }))).toBe(false);
  });
});

describe('spotGate', () => {
  const ready = {
    session: { pending: false, signedIn: true },
    availability: { state: 'ready' } as const,
    clientChainId: 10143,
    market: { chainId: 10143 },
  };
  const held = (native: string): SpotWallet => ({
    address: ME,
    native: { atoms: native, decimals: 18 },
    nativeSymbol: 'MON',
    base: { atoms: '0', decimals: 8 },
    quote: { atoms: '0', decimals: 6 },
    baseAllowance: { atoms: '0', decimals: 8 },
    quoteAllowance: { atoms: '0', decimals: 6 },
  });

  it('asks a visitor to sign in, and waits while the session is not known', () => {
    const wallet = { status: 'idle' } as const;
    expect(spotGate({ ...ready, session: { pending: false, signedIn: false }, wallet })).toEqual({ kind: 'sign_in' });
    expect(spotGate({ ...ready, session: { pending: true, signedIn: false }, wallet })).toEqual({
      kind: 'hold',
      message: SPOT_CHECKING_SESSION,
    });
  });

  it('says there is no wallet before anything else about one', () => {
    expect(
      spotGate({ ...ready, availability: { state: 'no_wallet', message: SPOT_NO_WALLET }, wallet: { status: 'idle' } }),
    ).toEqual({ kind: 'hold', message: SPOT_NO_WALLET });
  });

  it('names both chains when the app is set to another than the market', () => {
    const gate = spotGate({ ...ready, clientChainId: 143, wallet: { status: 'idle' } });
    expect(gate).toEqual({
      kind: 'hold',
      message:
        'This market is on Monad Testnet (chain 10143). This build of the app is set to Monad mainnet (chain 143), so orders are off here.',
    });
  });

  it('holds while the wallet is read, and says so when it could not be', () => {
    expect(spotGate({ ...ready, wallet: { status: 'loading' } })).toEqual({ kind: 'hold', message: SPOT_READING_WALLET });
    expect(spotGate({ ...ready, wallet: { status: 'unread', message: 'The wallet could not be read. Trying again.' } })).toEqual({
      kind: 'hold',
      message: 'The wallet could not be read. Trying again.',
    });
  });

  it('holds a wallet with no gas, in a calm sentence, and opens one that has some', () => {
    const none = spotGate({ ...ready, wallet: { status: 'ready', wallet: held('0') } });
    expect(none.kind).toBe('hold');
    expect(none.kind === 'hold' && none.message).toBe(
      'This wallet holds no testnet MON. Every transaction needs a little for gas, so nothing can be sent until it has some.',
    );
    expect(spotGate({ ...ready, wallet: { status: 'ready', wallet: held('1') } })).toMatchObject({ kind: 'open' });
  });

  it('points a testnet wallet with no gas at the faucet, and only for a no-gas hold', () => {
    const none = spotGate({ ...ready, wallet: { status: 'ready', wallet: held('0') } });
    expect(none).toMatchObject({ kind: 'hold', faucet: MONAD_TESTNET_FAUCET_URL });
    expect(spotGate({ ...ready, wallet: { status: 'loading' } })).not.toHaveProperty('faucet');
    // A mainnet market has no faucet to offer: the hold stands on its own.
    const mainnet = spotGate({ ...ready, clientChainId: 143, market: { chainId: 143 }, wallet: { status: 'ready', wallet: held('0') } });
    expect(mainnet).toMatchObject({ kind: 'hold' });
    expect(mainnet).not.toHaveProperty('faucet');
  });
});

describe('summariseFill', () => {
  const price = (whole: number) => BigInt(whole) * 10n ** 18n;

  it('adds up the trades that name the wallet as taker, and weights the price by size', () => {
    const fill = summariseFill(
      [
        { takerAddress: ME, price: price(83272), filledSize: 600_000n },
        { takerAddress: ME.toUpperCase().replace('0X', '0x'), price: price(83300), filledSize: 400_000n },
      ],
      ME,
      9,
    );
    expect(fill).toEqual({
      size: { atoms: '1000000', decimals: 9 },
      averagePrice: { atoms: '83283200000000000000000', decimals: 18 },
      trades: 2,
    });
    expect(fill && floorToDecimals(fill.averagePrice, 4)).toEqual({ atoms: '832832000', decimals: 4 });
  });

  it("leaves out another taker's trades", () => {
    const other = '0x00000000000000000000000000000000000000bb';
    expect(
      summariseFill(
        [
          { takerAddress: other, price: price(90000), filledSize: 5_000_000n },
          { takerAddress: ME, price: price(83272), filledSize: 1_000_000n },
        ],
        ME,
        9,
      ),
    ).toEqual({ size: { atoms: '1000000', decimals: 9 }, averagePrice: { atoms: price(83272).toString(), decimals: 18 }, trades: 1 });
  });

  it('reports no fill when no log names the wallet: nothing is made up', () => {
    expect(summariseFill([], ME, 9)).toBeNull();
    expect(summariseFill([{ takerAddress: '0x00000000000000000000000000000000000000bb', price: price(1), filledSize: 1n }], ME, 9)).toBeNull();
    expect(summariseFill([{ takerAddress: ME, price: price(1), filledSize: 0n }], ME, 9)).toBeNull();
  });
});

describe('the answer to an order', () => {
  const m = market();
  const o = order({ side: 'buy', amount: '83.272' });

  it('shows what filled, the average price and the transaction on the market explorer', () => {
    const view = filledOutcome(
      {
        txHash: TX,
        fill: { size: { atoms: '1000000', decimals: 9 }, averagePrice: { atoms: `83272${'0'.repeat(18)}`, decimals: 18 }, trades: 1 },
      },
      o,
      m,
    );
    expect(view.mark).toBe('done');
    expect(view.title).toBe('BUY FILLED');
    // The filled size is what traded, 0.001. What the wallet received is less by the fee, and the line says so.
    expect(view.facts).toEqual([
      ['Filled size', '0.001 tkBTC'],
      ['Average price', '83,272.0000 USDC'],
    ]);
    expect(view.line).toBe('The 0.30% taker fee comes out of the tkBTC the wallet receives.');
    expect(view.links).toEqual([
      { name: 'Order', tx: { hash: TX, short: '0xcdcdcd…cdcd', url: `https://testnet.monadscan.com/tx/${TX}`, explorer: 'Monadscan' } },
    ]);
  });

  it('never reports a fill it did not decode: it says the fill could not be read and links the transaction', () => {
    const view = filledOutcome({ txHash: TX, fill: null }, o, m);
    expect(view.mark).toBe('note');
    expect(view.facts).toEqual([]);
    expect(view.line).toBe(FILL_UNREAD_LINE);
    expect(view.links.map((l) => [l.name, l.tx.hash])).toEqual([['Order', TX]]);
  });

  it('says a revert calmly, as the bound working, with the transaction when one was mined', () => {
    const view = failedOutcome({ code: 'reverted', message: REVERTED_LINE, txHash: TX }, m);
    expect(view.title).toBe('NOT FILLED');
    expect(view.line).toMatch(/That is the bound working\.$/);
    expect(view.links.map((l) => [l.name, l.tx.hash])).toEqual([['Order', TX]]);
    expect(failedOutcome({ code: 'rejected', message: 'Declined.' }, m)).toMatchObject({ title: 'NOT SENT', links: [] });
  });

  it('names each transaction for what it was: the approval before the order, and a failed approval as one', () => {
    const approval = `0x${'ee'.repeat(32)}`;
    const filled = filledOutcome(
      {
        txHash: TX,
        approveTxHash: approval,
        fill: { size: { atoms: '1000000', decimals: 9 }, averagePrice: { atoms: `83272${'0'.repeat(18)}`, decimals: 18 }, trades: 3 },
      },
      o,
      m,
    );
    expect(filled.links.map((l) => [l.name, l.tx.hash])).toEqual([
      ['Approval', approval],
      ['Order', TX],
    ]);
    expect(filled.facts[2]).toEqual(['Trades', '3']);
    // A sell is named as one, and its filled size is still stated in the base token.
    const sold = filledOutcome({ txHash: TX, fill: { size: { atoms: '1000000', decimals: 9 }, averagePrice: { atoms: `82447${'0'.repeat(18)}`, decimals: 18 }, trades: 1 } }, order({ side: 'sell', amount: '0.001' }), m);
    expect(sold.title).toBe('SELL FILLED');
    expect(sold.facts).toEqual([
      ['Filled size', '0.001 tkBTC'],
      ['Average price', '82,447.0000 USDC'],
    ]);
    expect(sold.line).toBe('The 0.30% taker fee comes out of the USDC the wallet receives.');
    const stopped = failedOutcome({ code: 'failed', message: 'The approval reverted. Nothing was traded.', txHash: approval, txKind: 'approve' }, m);
    expect(stopped.title).toBe('NOT COMPLETED');
    expect(stopped.links.map((l) => l.name)).toEqual(['Approval']);
    // An order that went out and could not be confirmed is never called unsent.
    expect(failedOutcome({ code: 'unconfirmed', message: 'Sent.', txHash: TX, txKind: 'order' }, m).title).toBe('SENT, NOT CONFIRMED');
  });
});

describe('the open mint, and the labels', () => {
  it('says what a token is in the words it was sent, wherever its symbol alone would not', () => {
    const m = market();
    expect(tokenLine(m.base)).toBe('tkBTC is Kanon Test BTC: test token, open mint.');
    expect(tokenLine({ ...m.quote, kind: '' })).toBe('USDC is Mock USDC.');
  });

  it('names the mint for what it gives, and says what was minted with its transaction', () => {
    const m = market();
    expect(mintLabel(m)).toBe('Get 1,000 test USDC');
    const note = mintedNote(m, TX);
    expect(note.line).toBe('1,000 Mock USDC minted to this wallet.');
    expect(note.links.map((l) => [l.name, l.tx.hash])).toEqual([['Mint', TX]]);
    expect(mintFailedNote({ code: 'rejected', message: 'The request was declined in the wallet. Nothing was minted.' }, m)).toEqual({
      line: 'The request was declined in the wallet. Nothing was minted.',
      links: [],
    });
  });

  it('labels the network the market is on', () => {
    expect(networkLabel(market())).toBe('Monad testnet');
    expect(networkLabel({ chainId: 31337, network: 'local' })).toBe('local chain 31337');
  });

  it('cuts an amount down to fewer places without rounding up', () => {
    expect(floorToDecimals({ atoms: '498399999999999999', decimals: 18 }, 4)).toEqual({ atoms: '4983', decimals: 4 });
    expect(floorToDecimals({ atoms: '15', decimals: 1 }, 4)).toEqual({ atoms: '15000', decimals: 4 });
  });
});

describe('evidence', () => {
  it('links every contract and every listing transaction on the testnet explorer', () => {
    const m = market({
      listing: {
        marketTx: `0x${'b2'.repeat(32)}`,
        tokenTx: `0x${'a1'.repeat(32)}`,
        liquidityTx: `0x${'c3'.repeat(32)}`,
        firstOrderTx: `0x${'d4'.repeat(32)}`,
      },
    });
    const evidence = marketEvidence(m);
    expect(evidence.addresses.map((a) => [a.label, a.ref?.url])).toEqual([
      ['Order book', `https://testnet.monadscan.com/address/${MARKET_ADDRESS}`],
      ['Kanon Test BTC', `https://testnet.monadscan.com/address/${BASE}`],
      ['Mock USDC', `https://testnet.monadscan.com/address/${QUOTE}`],
    ]);
    expect(evidence.transactions.map((t) => t.name)).toEqual(['Token deploy', 'Market listing', 'First liquidity', 'First order']);
    expect(evidence.transactions[1]?.tx.url).toBe(`https://testnet.monadscan.com/tx/0x${'b2'.repeat(32)}`);
  });

  it('lists only the listing transactions it was sent, and links nothing on a chain it has no explorer for', () => {
    expect(marketEvidence(market()).transactions.map((t) => t.name)).toEqual(['Token deploy', 'Market listing']);
    expect(spotTx(1, TX)).toBeNull();
  });
});
