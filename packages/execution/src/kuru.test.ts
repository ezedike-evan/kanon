import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { dec, formatDecimal } from '@kanon/spec';
import {
  KURU_FLOW_API_BASE_URL,
  KURU_MARKETS,
  KuruClient,
  KuruFlowClient,
  createKuruSdkAdapter,
  decodeKuruReceipt,
  loadKuruSdk,
  mulToScale,
  vwap,
  type KuruAdapter,
  type KuruMarketInfo,
  type KuruSdkModule,
  type KuruTxOutcome,
} from './kuru';
import { fakeFetch } from './test-helpers';

const NOW = 1_760_000_000_000;
const MARKET = KURU_MARKETS.mainnet['MON/AUSD'];
const SIGNER = '0x18B908f74d83257407487463dbc11d4223017187';
const OTHER = '0x00000000000000000000000000000000000000aa';

/** Illustrative scaling: 6 price decimals, 8 size decimals, MON base (18), AUSD quote (6). */
const INFO: KuruMarketInfo = {
  priceDecimals: 6,
  sizeDecimals: 8,
  baseDecimals: 18,
  quoteDecimals: 6,
  baseToken: ethers.constants.AddressZero,
  quoteToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
  minSize: dec(1000n, 8),
  maxSize: dec(10n ** 12n, 8),
};

function mockAdapter(overrides: Partial<KuruAdapter> = {}) {
  const outcome: KuruTxOutcome = {
    transactionHash: '0xabc',
    orderIds: [],
    fills: [{ price: dec(30_100_000_000_000_000n, 18), size: dec(200_000_000n, 8) }],
  };
  const base = {
    getMarketInfo: vi.fn<KuruAdapter['getMarketInfo']>(async () => INFO),
    getBestBidAsk: vi.fn<KuruAdapter['getBestBidAsk']>(async () => ({ bid: dec(29_900n, 6), ask: dec(30_000n, 6) })),
    placeLimit: vi.fn<KuruAdapter['placeLimit']>(async () => ({ ...outcome, orderIds: ['77'], fills: [] })),
    placeMarket: vi.fn<KuruAdapter['placeMarket']>(async () => outcome),
    cancelOrders: vi.fn<KuruAdapter['cancelOrders']>(async () => ({ transactionHash: '0xcancel' })),
    getBaseBalance: vi.fn<KuruAdapter['getBaseBalance']>(async () => dec(5n * 10n ** 18n, 18)),
  };
  return { ...base, ...overrides } as typeof base;
}

function client(adapter: KuruAdapter, extra: Partial<ConstructorParameters<typeof KuruClient>[0]> = {}) {
  return new KuruClient({ network: 'mainnet', adapter, now: () => NOW, ...extra });
}

describe('Kuru market table', () => {
  it('lists only the documented MON markets and never a BTC market', () => {
    expect(Object.keys(KURU_MARKETS.mainnet)).toEqual(['MON/AUSD', 'MON/USDC']);
    expect(Object.keys(KURU_MARKETS.testnet)).toEqual(['MON/USDC']);
  });
});

describe('KuruClient', () => {
  it('refuses an unknown market with a reason and never calls the adapter', async () => {
    const adapter = mockAdapter();
    const result = await client(adapter).placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: dec(100_000_000n, 8) });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('no known Kuru market for asset "BTC/USD"');
    expect(result.reason).toContain('never guesses');
    expect(adapter.getMarketInfo).not.toHaveBeenCalled();
    expect(adapter.placeMarket).not.toHaveBeenCalled();
  });

  it('sizes a market buy in QUOTE (base x best ask) with a base floor at the slippage bound', async () => {
    const adapter = mockAdapter();
    const result = await client(adapter).placeOrder({
      clientOrderId: 'buy1',
      asset: 'MON/AUSD',
      side: 'buy',
      kind: 'market',
      size: dec(200_000_000n, 8), // 2 MON
    });
    expect(adapter.placeMarket).toHaveBeenCalledOnce();
    const args = adapter.placeMarket.mock.calls[0]![0];
    expect(args.marketAddress).toBe(MARKET);
    expect(args.isBuy).toBe(true);
    expect(args.fillOrKill).toBe(true);
    // 2 MON x 0.030000 ask = 0.060000 quote; floor of 2 x (1 - 50 bps) = 1.99 base.
    expect(args.size).toEqual({ atoms: '60000', decimals: 6 });
    expect(args.minAmountOut).toEqual({ atoms: '199000000', decimals: 8 });

    expect(result.status).toBe('filled');
    expect(formatDecimal(result.filledSize!)).toBe('2.00000000');
    expect(result.avgFillPrice).toEqual(dec(30_100_000_000_000_000n, 18));
  });

  it('sizes a market sell in BASE with a quote floor at the slippage bound', async () => {
    const adapter = mockAdapter();
    await client(adapter).placeOrder({
      clientOrderId: 'sell1',
      asset: 'MON/AUSD',
      side: 'sell',
      kind: 'market',
      size: dec(200_000_000n, 8),
      reduceOnly: true,
      maxSlippageBps: 100,
    });
    const args = adapter.placeMarket.mock.calls[0]![0];
    expect(args.isBuy).toBe(false);
    expect(args.size).toEqual({ atoms: '200000000', decimals: 8 });
    // 2 MON x 0.029900 bid = 0.059800; less 100 bps = 0.059202.
    expect(args.minAmountOut).toEqual({ atoms: '59202', decimals: 6 });
  });

  it('refuses a reduce-only buy: spot has no short to close', async () => {
    const adapter = mockAdapter();
    const result = await client(adapter).placeOrder({ clientOrderId: 'o', asset: 'MON/AUSD', side: 'buy', kind: 'market', size: dec(200_000_000n, 8), reduceOnly: true });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('cannot hold a short');
  });

  it('refuses sizes outside the market min and max', async () => {
    const adapter = mockAdapter();
    const c = client(adapter);
    const small = await c.placeOrder({ clientOrderId: 'a', asset: 'MON/AUSD', side: 'buy', kind: 'market', size: dec(10n, 8) });
    expect(small.reason).toContain('below the market minimum');
    const huge = await c.placeOrder({ clientOrderId: 'b', asset: 'MON/AUSD', side: 'buy', kind: 'market', size: dec(10n ** 13n, 8) });
    expect(huge.reason).toContain('above the market maximum');
  });

  it('places a resting limit, remembers its order id, and cancels it on the right market', async () => {
    const adapter = mockAdapter();
    const c = client(adapter);
    const placed = await c.placeOrder({
      clientOrderId: 'lim1',
      asset: 'MON/AUSD',
      side: 'buy',
      kind: 'limit',
      price: dec(29_999_999n, 9), // 0.029999999 -> floors to 0.029999 for a buy
      size: dec(200_000_000n, 8),
    });
    const args = adapter.placeLimit.mock.calls[0]![0];
    expect(args.price).toEqual({ atoms: '29999', decimals: 6 });
    expect(args.postOnly).toBe(false);
    expect(placed).toMatchObject({ status: 'pending', venueOrderId: '77' });

    const cancelled = await c.cancelOrder('lim1');
    expect(adapter.cancelOrders).toHaveBeenCalledWith({ marketAddress: MARKET, orderIds: ['77'] });
    expect(cancelled.cancelled).toBe(true);
    expect((await c.cancelOrder('lim1')).cancelled).toBe(false);
  });

  it('reports an adapter failure as a rejection carrying the reason', async () => {
    const adapter = mockAdapter({ placeMarket: vi.fn(async () => { throw new Error('execution reverted: InsufficientBalance'); }) });
    const result = await client(adapter).placeOrder({ clientOrderId: 'o', asset: 'MON/AUSD', side: 'buy', kind: 'market', size: dec(200_000_000n, 8) });
    expect(result).toMatchObject({ status: 'rejected' });
    expect(result.reason).toContain('InsufficientBalance');
  });

  it('does not claim a fill it cannot decode', async () => {
    const adapter = mockAdapter({ placeMarket: vi.fn(async () => ({ transactionHash: '0xdead', orderIds: [], fills: [] })) });
    const result = await client(adapter).placeOrder({ clientOrderId: 'o', asset: 'MON/AUSD', side: 'buy', kind: 'market', size: dec(200_000_000n, 8) });
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('0xdead');
  });

  it('refuses a market buy when there is no ask to price against', async () => {
    const adapter = mockAdapter({ getBestBidAsk: vi.fn(async () => ({})) });
    const result = await client(adapter).placeOrder({ clientOrderId: 'o', asset: 'MON/AUSD', side: 'buy', kind: 'market', size: dec(200_000_000n, 8) });
    expect(result.reason).toContain('no ask liquidity');
    expect(adapter.placeMarket).not.toHaveBeenCalled();
  });

  it('reports a margin balance as the position, with a cost basis only from its own fills', async () => {
    const adapter = mockAdapter();
    const c = client(adapter);
    expect((await c.getPosition('MON/AUSD'))?.entryPrice).toBeUndefined(); // never fabricated as zero
    await c.placeOrder({ clientOrderId: 'b', asset: 'MON/AUSD', side: 'buy', kind: 'market', size: dec(200_000_000n, 8) });
    const position = await c.getPosition('MON/AUSD');
    expect(position?.entryPrice).toEqual(dec(30_100_000_000_000_000n, 18));
    expect(await c.getPosition('BTC/USD')).toBeNull();
  });

  it('polls best bid/ask for ticks at the mid price', async () => {
    vi.useFakeTimers();
    try {
      const adapter = mockAdapter();
      const ticks: string[] = [];
      const stop = client(adapter, { pollIntervalMs: 1000 }).subscribeMarketData('MON/AUSD', (t) => ticks.push(formatDecimal(t.price)));
      await vi.advanceTimersByTimeAsync(1100);
      expect(ticks).toEqual(['0.029950']);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('math helpers', () => {
  it('multiplies across scales with an explicit rounding side', () => {
    const size = dec(150_000_000n, 8); // 1.5
    const price = dec(333_333n, 6); // 0.333333
    expect(mulToScale(size, price, 6, 'floor').atoms).toBe('499999');
    expect(mulToScale(size, price, 6, 'ceil').atoms).toBe('500000');
  });

  it('computes a volume-weighted average price', () => {
    const out = vwap([
      { price: dec(10n, 0), size: dec(1n, 0) },
      { price: dec(20n, 0), size: dec(3n, 0) },
    ]);
    expect(out?.avgPrice.atoms).toBe('17'); // (10 + 60) / 4 = 17.5, truncated
    expect(out?.size.atoms).toBe('4');
    expect(vwap([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Receipt decoding and the real-SDK adapter, with a fake SDK module.
// ---------------------------------------------------------------------------

const EVENTS = new ethers.utils.Interface([
  'event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)',
  'event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)',
]);

function log(name: string, values: unknown[], address: string = MARKET) {
  const { topics, data } = EVENTS.encodeEventLog(EVENTS.getEvent(name), values);
  return { address, topics, data };
}

const RECEIPT = {
  transactionHash: '0xreceipt',
  logs: [
    log('OrderCreated', [9, SIGNER, 5_000_000, 30_000, true]),
    log('OrderCreated', [10, OTHER, 5_000_000, 30_000, true]), // someone else's order
    log('Trade', [3, OTHER, false, ethers.utils.parseUnits('0.030100', 18), 0, SIGNER, SIGNER, 150_000_000]),
    log('Trade', [4, OTHER, false, ethers.utils.parseUnits('0.030200', 18), 0, SIGNER, SIGNER, 50_000_000]),
    log('Trade', [5, SIGNER, true, ethers.utils.parseUnits('0.030100', 18), 0, OTHER, OTHER, 99_000_000]), // signer as MAKER, not taker
    log('Trade', [6, OTHER, false, ethers.utils.parseUnits('0.031', 18), 0, SIGNER, SIGNER, 1], '0x00000000000000000000000000000000000000bb'), // other contract
  ],
};

describe('decodeKuruReceipt', () => {
  it('extracts the signer\'s order ids and taker fills, and ignores everything else', () => {
    const out = decodeKuruReceipt(RECEIPT, MARKET, SIGNER, INFO);
    expect(out.orderIds).toEqual(['9']);
    expect(out.fills).toEqual([
      { price: { atoms: '30100000000000000', decimals: 18 }, size: { atoms: '150000000', decimals: 8 } },
      { price: { atoms: '30200000000000000', decimals: 18 }, size: { atoms: '50000000', decimals: 8 } },
    ]);
    expect(vwap(out.fills)?.size.atoms).toBe('200000000');
  });

  it('matches the market address case-insensitively', () => {
    expect(decodeKuruReceipt(RECEIPT, MARKET.toUpperCase().replace('0X', '0x'), SIGNER.toLowerCase(), INFO).orderIds).toEqual(['9']);
  });
});

function fakeSdk() {
  const params = {
    pricePrecision: ethers.BigNumber.from(10).pow(6),
    sizePrecision: ethers.BigNumber.from(10).pow(8),
    baseAssetAddress: ethers.constants.AddressZero,
    baseAssetDecimals: ethers.BigNumber.from(18),
    quoteAssetAddress: INFO.quoteToken,
    quoteAssetDecimals: ethers.BigNumber.from(6),
    tickSize: ethers.BigNumber.from(1),
    minSize: ethers.BigNumber.from(1000),
    maxSize: ethers.BigNumber.from(10).pow(12),
    takerFeeBps: ethers.BigNumber.from(30),
    makerFeeBps: ethers.BigNumber.from(10),
  };
  const sdk = {
    ParamFetcher: { getMarketParams: vi.fn(async () => params) },
    OrderBook: {
      getL2OrderBook: vi.fn(async () => ({ bids: [[0.0299, 5], [0.0298, 9]], asks: [[0.031, 4], [0.03, 2]], blockNumber: 1 })),
    },
    GTC: { placeLimit: vi.fn(async (..._args: unknown[]) => RECEIPT) },
    IOC: { placeMarket: vi.fn(async (..._args: unknown[]) => RECEIPT) },
    OrderCanceler: { cancelOrders: vi.fn(async (..._args: unknown[]) => ({ transactionHash: '0xcancel' })) },
    MarginBalance: { getBalance: vi.fn(async (..._args: unknown[]) => ethers.utils.parseUnits('5', 18)) },
  };
  return { sdk, module: sdk as unknown as KuruSdkModule };
}

const fakeSigner = { getAddress: async () => SIGNER } as unknown as ethers.Signer;
const fakeProvider = {} as ethers.providers.JsonRpcProvider;

describe('createKuruSdkAdapter (real conversions over a fake SDK module)', () => {
  it('derives decimals from the on-chain precisions and reads best bid/ask from the L2 book', async () => {
    const { sdk, module } = fakeSdk();
    const adapter = createKuruSdkAdapter({ sdk: module, provider: fakeProvider, signer: fakeSigner, marginAccountAddress: '0xmargin' });
    const info = await adapter.getMarketInfo(MARKET);
    expect(info).toMatchObject({ priceDecimals: 6, sizeDecimals: 8, baseDecimals: 18, quoteDecimals: 6 });
    expect(info.minSize).toEqual({ atoms: '1000', decimals: 8 });
    expect(await adapter.getBestBidAsk(MARKET, info)).toEqual({
      bid: { atoms: '29900', decimals: 6 },
      ask: { atoms: '30000', decimals: 6 },
    });
    await adapter.getMarketInfo(MARKET);
    expect(sdk.ParamFetcher.getMarketParams).toHaveBeenCalledTimes(1); // cached
  });

  it('passes human-readable strings to the SDK and decodes the receipt', async () => {
    const { sdk, module } = fakeSdk();
    const adapter = createKuruSdkAdapter({ sdk: module, provider: fakeProvider, signer: fakeSigner, marginAccountAddress: '0xmargin' });
    const info = await adapter.getMarketInfo(MARKET);

    const limit = await adapter.placeLimit({ marketAddress: MARKET, info, price: dec(29_999n, 6), size: dec(200_000_000n, 8), isBuy: true, postOnly: false });
    expect(sdk.GTC.placeLimit).toHaveBeenCalledWith(fakeSigner, MARKET, expect.anything(), {
      price: '0.029999',
      size: '2.00000000',
      isBuy: true,
      postOnly: false,
    });
    expect(limit.orderIds).toEqual(['9']);

    const market = await adapter.placeMarket({ marketAddress: MARKET, info, isBuy: true, size: dec(60_000n, 6), minAmountOut: dec(199_000_000n, 8), fillOrKill: true });
    expect(sdk.IOC.placeMarket).toHaveBeenCalledWith(fakeSigner, MARKET, expect.anything(), {
      approveTokens: false, // margin flow by default
      isBuy: true,
      size: '0.060000',
      minAmountOut: '1.99000000',
      isMargin: true,
      fillOrKill: true,
    });
    expect(market.fills).toHaveLength(2);
  });

  it('approves wallet tokens instead when margin is turned off', async () => {
    const { sdk, module } = fakeSdk();
    const adapter = createKuruSdkAdapter({ sdk: module, provider: fakeProvider, signer: fakeSigner, marginAccountAddress: '0xmargin', useMargin: false });
    const info = await adapter.getMarketInfo(MARKET);
    await adapter.placeMarket({ marketAddress: MARKET, info, isBuy: false, size: dec(1n, 8), minAmountOut: dec(1n, 6), fillOrKill: true });
    expect(sdk.IOC.placeMarket.mock.calls[0]![3]).toMatchObject({ approveTokens: true, isMargin: false });
  });

  it('cancels with BigNumber ids and reads the margin balance at token decimals', async () => {
    const { sdk, module } = fakeSdk();
    const adapter = createKuruSdkAdapter({ sdk: module, provider: fakeProvider, signer: fakeSigner, marginAccountAddress: '0xmargin' });
    const info = await adapter.getMarketInfo(MARKET);
    await adapter.cancelOrders({ marketAddress: MARKET, orderIds: ['9', '12'] });
    const ids = sdk.OrderCanceler.cancelOrders.mock.calls[0]![2] as ethers.BigNumber[];
    expect(ids.map((i) => i.toString())).toEqual(['9', '12']);
    expect(await adapter.getBaseBalance(MARKET, info)).toEqual({ atoms: '5000000000000000000', decimals: 18 });
    expect(sdk.MarginBalance.getBalance).toHaveBeenCalledWith(fakeProvider, '0xmargin', SIGNER, ethers.constants.AddressZero);
  });

  it('runs a full KuruClient market buy end to end over the fake SDK', async () => {
    const { module } = fakeSdk();
    const adapter = createKuruSdkAdapter({ sdk: module, provider: fakeProvider, signer: fakeSigner, marginAccountAddress: '0xmargin' });
    const result = await new KuruClient({ network: 'mainnet', adapter, now: () => NOW }).placeOrder({
      clientOrderId: 'e2e',
      asset: 'MON/AUSD',
      side: 'buy',
      kind: 'market',
      size: dec(200_000_000n, 8),
    });
    expect(result.status).toBe('filled');
    expect(formatDecimal(result.filledSize!)).toBe('2.00000000');
  });
});

describe('the real @kuru-labs/kuru-sdk', () => {
  it('loads and exposes every entry point the adapter calls', async () => {
    const sdk = await loadKuruSdk();
    expect(typeof sdk.GTC.placeLimit).toBe('function');
    expect(typeof sdk.IOC.placeMarket).toBe('function');
    expect(typeof sdk.OrderCanceler.cancelOrders).toBe('function');
    expect(typeof sdk.ParamFetcher.getMarketParams).toBe('function');
    expect(typeof sdk.OrderBook.getL2OrderBook).toBe('function');
    expect(typeof sdk.MarginBalance.getBalance).toBe('function');
  });
});

describe('KuruFlowClient', () => {
  it('generates a JWT then quotes with it, and caches the token', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.endsWith('/generate-token')) return { body: { token: 'jwt-1', expires_at: NOW / 1000 + 3600, rate_limit: { rps: 1, burst: 1 } } };
      if (url.endsWith('/quote')) return { body: { type: 'swap_calculation', status: 'success', output: '950000000000000000', path: {} } };
      return undefined;
    });
    const flow = new KuruFlowClient({ fetchImpl, now: () => NOW });
    const q = await flow.quote({ userAddress: SIGNER, tokenIn: ethers.constants.AddressZero, tokenOut: '0x754704bc059f8c67012fed69bc8a327a5aafb603', amount: '1000000000000000000', slippageBps: 50 });
    await flow.quote({ userAddress: SIGNER, tokenIn: ethers.constants.AddressZero, tokenOut: '0x754704bc059f8c67012fed69bc8a327a5aafb603', amount: '1' });

    expect(q.output).toBe('950000000000000000');
    expect(calls[0]?.url).toBe(`${KURU_FLOW_API_BASE_URL}/generate-token`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ user_address: SIGNER });
    expect(calls[1]?.url).toBe('https://ws.kuru.io/api/quote');
    expect((calls[1]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ slippageTolerance: 50, autoSlippage: false, amount: '1000000000000000000' });
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({ autoSlippage: true });
    expect(calls.filter((c) => c.url.endsWith('/generate-token'))).toHaveLength(1);
  });

  it('throws on a rate-limited quote instead of returning a made-up price', async () => {
    const { fetchImpl } = fakeFetch((url) => (url.endsWith('/generate-token') ? { body: { token: 't' } } : { status: 429, body: 'slow down' }));
    await expect(new KuruFlowClient({ fetchImpl }).quote({ userAddress: SIGNER, tokenIn: '0x0', tokenOut: '0x1', amount: '1' })).rejects.toThrow(/429/);
  });
});
