import { beforeEach, describe, expect, it } from 'vitest';
import { dec, formatDecimal } from '@kanon/spec';
import {
  PERPL_FLAG,
  PERPL_ORDER_STATUS,
  PERPL_ORDER_TYPE,
  PERPL_TRIGGER,
  PerplClient,
  PerplMarketRegistry,
  buildRestCanonical,
  buildWsSignInCanonical,
  createEd25519Signer,
  generateEd25519KeyPair,
  perplTriggerCondition,
  perplTriggerRounding,
  sha256Hex,
  verifyEd25519Base64Url,
  type Ed25519KeyPair,
} from './perpl';
import { FakeWS, FakeWebSocket, fakeFetch } from './test-helpers';

const NOW = 1_760_000_000_000;
const ACCOUNT_ID = 4242;

/** Decimals here mirror the docs' worked example (BTC: 1 price decimal, 5 size
 * decimals). In production they come from GET /v1/pub/context, never from here. */
const CONTEXT = {
  markets: [
    { id: 1, symbol: 'BTC', name: 'BTC', config: { price_decimals: 1, size_decimals: 5, is_open: true } },
    { id: 20, symbol: 'ETH', name: 'ETH', config: { price_decimals: 2, size_decimals: 4, is_open: true } },
    { id: 31, symbol: 'SOL', name: 'SOL', config: { price_decimals: 3, size_decimals: 2, is_open: false } },
  ],
};

let keyPair: Ed25519KeyPair;

beforeEach(async () => {
  keyPair = await generateEd25519KeyPair();
  FakeWebSocket.reset();
});

interface ServerBehaviour {
  /** Extra frames sent right after the sign-in frame, e.g. a wallet snapshot. */
  afterSignIn?: (ws: FakeWebSocket) => void;
  /** How to answer an mt:22. Return false to stay silent. */
  onCommand?: (ws: FakeWebSocket, frame: Record<string, unknown>) => void | false;
}

function serve(b: ServerBehaviour = {}) {
  FakeWebSocket.reset({
    onFrame: (ws, frame) => {
      if (frame.mt === 29) return b.afterSignIn?.(ws);
      if (frame.mt === 22) b.onCommand?.(ws, frame);
    },
  });
}

function ack(ws: FakeWebSocket, frame: Record<string, unknown>, code = 0, error = '') {
  ws.serverSend({ mt: 3, sid: 100, sn: 1, cid: frame.sn, status: { code, error } });
}

function orderUpdate(ws: FakeWebSocket, frame: Record<string, unknown>, patch: Record<string, unknown>) {
  ws.serverSend({
    mt: 24,
    at: { b: 1, t: NOW },
    d: [{ rq: frame.rq, mkt: frame.mkt, oid: 900, st: PERPL_ORDER_STATUS.open, t: frame.t, os: frame.s, fs: 0, fp: 0, ...patch }],
  });
}

function makeClient(overrides: Partial<ConstructorParameters<typeof PerplClient>[0]> = {}) {
  return new PerplClient({
    network: 'mainnet',
    apiKey: 'api-key-token',
    signer: createEd25519Signer(keyPair.secretKeyHex),
    accountId: ACCOUNT_ID,
    WebSocketImpl: FakeWS,
    now: () => NOW,
    nonce: () => 'fixed-nonce',
    markets: new PerplMarketRegistry({ network: 'mainnet', context: CONTEXT }),
    ackTimeoutMs: 60,
    settleTimeoutMs: 60,
    ...overrides,
  });
}

const size = (v: string) => ({ atoms: v, decimals: 8 }); // Kanon-side scale: 8 decimals

describe('PerplClient: sign-in', () => {
  it('sends a signed ApiKeySignIn (mt 29) as the first frame, on the trading socket', async () => {
    serve({ onCommand: (ws, f) => (ack(ws, f), orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.filled, fs: 10000, fp: 950000 })) });
    const client = makeClient();
    await client.placeOrder({ clientOrderId: 'o1', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });

    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('wss://app.perpl.xyz/ws/v1/trading');
    const signIn = ws.frames[0]!;
    expect(signIn).toMatchObject({ mt: 29, chain_id: 143, api_key: 'api-key-token', timestamp: String(NOW), nonce: 'fixed-nonce' });
    const canonical = buildWsSignInCanonical({ chainId: 143, timestamp: String(NOW), nonce: 'fixed-nonce' });
    expect(await verifyEd25519Base64Url(keyPair.publicKeyHex, signIn.signature as string, canonical)).toBe(true);
  });

  it('signs REST requests with the six-field canonical string and no /api prefix', async () => {
    const client = makeClient();
    const headers = await client.authHeaders('GET', '/v1/trading/fills?count=2');
    expect(headers['X-API-Key']).toBe('api-key-token');
    expect(headers['X-API-Timestamp']).toBe(String(NOW));
    expect(headers['X-API-Nonce']).toBe('fixed-nonce');
    const canonical = buildRestCanonical({
      chainId: 143,
      method: 'GET',
      target: '/v1/trading/fills?count=2',
      timestamp: String(NOW),
      nonce: 'fixed-nonce',
      bodyHashHex: await sha256Hex(''),
    });
    expect(await verifyEd25519Base64Url(keyPair.publicKeyHex, headers['X-API-Signature']!, canonical)).toBe(true);
  });

  it('uses the testnet chain id and URLs on testnet', async () => {
    serve({ onCommand: (ws, f) => ack(ws, f, 0) });
    const client = makeClient({
      network: 'testnet',
      markets: new PerplMarketRegistry({
        network: 'testnet',
        context: { markets: [{ id: 16, symbol: 'BTC', config: { price_decimals: 1, size_decimals: 5 } }] },
      }),
    });
    await client.placeOrder({ clientOrderId: 't1', asset: 'BTC/USD', side: 'buy', kind: 'limit', price: dec(950000n, 1), size: size('10000000') });
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('wss://testnet.perpl.xyz/ws/v1/trading');
    expect(ws.frames[0]).toMatchObject({ chain_id: 10143 });
    expect(ws.frames[1]).toMatchObject({ mkt: 16 }); // testnet BTC market id
  });
});

describe('PerplClient: order frames', () => {
  it('sends a market buy as OpenLong with scaled size, price 0, IOC, 1x, max window', async () => {
    serve({ onCommand: (ws, f) => (ack(ws, f), orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.filled, fs: 10000, fp: 950000 })) });
    const client = makeClient();
    const result = await client.placeOrder({
      clientOrderId: 'o1',
      asset: 'BTC/USD',
      side: 'buy',
      kind: 'market',
      size: size('10000000'), // 0.1 BTC at 8 decimals
    });

    const frame = FakeWebSocket.instances[0]!.frames.find((f) => f.mt === 22)!;
    expect(frame).toMatchObject({
      mt: 22,
      mkt: 1,
      acc: ACCOUNT_ID,
      t: PERPL_ORDER_TYPE.openLong,
      p: 0,
      s: 10000, // 0.1 BTC at 5 size decimals
      fl: PERPL_FLAG.ioc,
      lv: 100, // 1x in hundredths
      lb: 0,
    });
    expect(frame.sn).toBeTypeOf('number');
    expect(frame.sn).not.toBe(0);
    expect(frame.rq).toBeGreaterThanOrEqual(NOW);
    expect(frame).not.toHaveProperty('ms'); // no hidden slippage: the market default applies

    expect(result.status).toBe('filled');
    expect(result.venueOrderId).toBe('900');
    expect(formatDecimal(result.filledSize!)).toBe('0.10000');
    expect(formatDecimal(result.avgFillPrice!)).toBe('95,000.0');
  });

  it('carries leverage and an explicit slippage bound when the order has them', async () => {
    serve({ onCommand: (ws, f) => ack(ws, f) });
    const client = makeClient();
    await client.placeOrder({
      clientOrderId: 'o2',
      asset: 'ETH/USD',
      side: 'sell',
      kind: 'market',
      size: size('250000'),
      leverageX: 5,
      maxSlippageBps: 30,
    });
    const frame = FakeWebSocket.instances[0]!.frames.find((f) => f.mt === 22)!;
    expect(frame).toMatchObject({ mkt: 20, t: PERPL_ORDER_TYPE.openShort, lv: 500, ms: 30, s: 25 });
  });

  it('rounds a limit price toward the safe side and never sizes past the approved amount', async () => {
    serve({ onCommand: (ws, f) => ack(ws, f) });
    const client = makeClient();
    // 68,412.57 at 1 price decimal: buy floors to 684125, sell would ceil to 684126.
    await client.placeOrder({ clientOrderId: 'b', asset: 'BTC/USD', side: 'buy', kind: 'limit', price: dec(6841257n, 2), size: size('12345678') });
    await client.placeOrder({ clientOrderId: 's', asset: 'BTC/USD', side: 'sell', kind: 'limit', price: dec(6841257n, 2), size: size('12345678') });
    const [buy, sell] = FakeWebSocket.instances[0]!.frames.filter((f) => f.mt === 22);
    expect(buy).toMatchObject({ t: PERPL_ORDER_TYPE.openLong, p: 684125, s: 12345, fl: PERPL_FLAG.gtc });
    expect(sell).toMatchObject({ t: PERPL_ORDER_TYPE.openShort, p: 684126, s: 12345 });
  });

  it('maps a reduce-only sell to CloseLong and a reduce-only buy to CloseShort', async () => {
    serve({ onCommand: (ws, f) => ack(ws, f) });
    const client = makeClient();
    await client.placeOrder({ clientOrderId: 'c1', asset: 'BTC/USD', side: 'sell', kind: 'market', size: size('10000000'), reduceOnly: true });
    await client.placeOrder({ clientOrderId: 'c2', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000'), reduceOnly: true });
    const [a, b] = FakeWebSocket.instances[0]!.frames.filter((f) => f.mt === 22);
    expect(a!.t).toBe(PERPL_ORDER_TYPE.closeLong);
    expect(b!.t).toBe(PERPL_ORDER_TYPE.closeShort);
  });

  it('strictly increases rq and reuses it for a retry of the same clientOrderId', async () => {
    serve({ onCommand: (ws, f) => ack(ws, f) });
    const client = makeClient();
    await client.placeOrder({ clientOrderId: 'a', asset: 'BTC/USD', side: 'buy', kind: 'limit', price: dec(950000n, 1), size: size('10000000') });
    await client.placeOrder({ clientOrderId: 'b', asset: 'BTC/USD', side: 'buy', kind: 'limit', price: dec(950000n, 1), size: size('10000000') });
    await client.placeOrder({ clientOrderId: 'a', asset: 'BTC/USD', side: 'buy', kind: 'limit', price: dec(950000n, 1), size: size('10000000') });
    const [a1, b1, a2] = FakeWebSocket.instances[0]!.frames.filter((f) => f.mt === 22);
    expect(b1!.rq as number).toBeGreaterThan(a1!.rq as number);
    expect(a2!.rq).toBe(a1!.rq);
    expect(new Set([a1!.sn, b1!.sn, a2!.sn]).size).toBe(3); // sn is unique per command
  });
});

describe('PerplClient: ack and order-update parsing', () => {
  it('treats an mt:3 code 0 as accepted-for-forwarding, not a fill', async () => {
    serve({ onCommand: (ws, f) => ack(ws, f, 0) }); // ack, then silence
    const client = makeClient();
    const result = await client.placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'limit', price: dec(950000n, 1), size: size('10000000') });
    expect(result.status).toBe('pending');
    expect(result.filledSize).toBeUndefined();
  });

  it('reports a resting limit order as pending with the venue order id once mt:24 shows it open', async () => {
    serve({ onCommand: (ws, f) => (ack(ws, f), orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.open })) });
    const client = makeClient();
    const result = await client.placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'limit', price: dec(950000n, 1), size: size('10000000') });
    expect(result).toMatchObject({ status: 'pending', venueOrderId: '900' });
  });

  it('rejects on a non-zero ack code and returns the venue error', async () => {
    serve({ onCommand: (ws, f) => ack(ws, f, 400, 'last exec block too high') });
    const client = makeClient();
    const result = await client.placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('last exec block too high');
    expect(result.reason).toContain('400');
  });

  it('reports a 403 (read-scoped key) as a rejection', async () => {
    serve({ onCommand: (ws, f) => ack(ws, f, 403, 'api key lacks trade scope') });
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    expect(result).toMatchObject({ status: 'rejected' });
    expect(result.reason).toContain('trade scope');
  });

  it('explains sr 34 as the missing allowOrderForwarding(true) safeguard', async () => {
    serve({
      onCommand: (ws, f) => (ack(ws, f, 0), orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.failed, sr: 34 })),
    });
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('allowOrderForwarding(true)');
    expect(result.reason).toContain('sr 34');
  });

  it('reports a partially filled IOC that the venue then cancels as filled with the real size', async () => {
    serve({
      onCommand: (ws, f) => (ack(ws, f), orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.canceled, fs: 4000, fp: 951000 })),
    });
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    expect(result.status).toBe('filled');
    expect(formatDecimal(result.filledSize!)).toBe('0.04000');
  });

  it('reports an IOC that ends with zero fills as rejected, not filled', async () => {
    serve({ onCommand: (ws, f) => (ack(ws, f), orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.canceled, fs: 0 })) });
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    expect(result.status).toBe('rejected');
  });

  it('waits past a non-terminal update for a market order, then takes the fill', async () => {
    serve({
      onCommand: (ws, f) => {
        ack(ws, f);
        orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.pending });
        setTimeout(() => orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.filled, fs: 10000, fp: 950000 }), 10);
      },
    });
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    expect(result.status).toBe('filled');
  });

  it('never fakes success when no acknowledgement arrives', async () => {
    serve({ onCommand: () => false });
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('outcome unknown');
  });

  it('reports a fill only when the first mt:24 arrives before the ack is processed', async () => {
    // mt:24 delivered in the same tick as the ack, ahead of the waiter's timer.
    serve({
      onCommand: (ws, f) => {
        orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.filled, fs: 10000, fp: 950000 });
        ack(ws, f);
      },
    });
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    expect(result.status).toBe('filled');
  });
});

describe('PerplClient: refusals without touching the venue', () => {
  it('refuses an asset with no Perpl market id', async () => {
    serve();
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'AVAX/USD', side: 'buy', kind: 'market', size: size('100') });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('not a Perpl mainnet market');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('refuses a market the context marks closed', async () => {
    serve();
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'SOL/USD', side: 'buy', kind: 'market', size: size('100000000') });
    expect(result.reason).toContain('not open');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('refuses rather than guess decimals when the market context cannot be loaded', async () => {
    serve();
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 503, body: 'down' }));
    const client = makeClient({ markets: new PerplMarketRegistry({ network: 'mainnet', fetchImpl }) });
    const result = await client.placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('100000') });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('refusing rather than guess decimals');
    expect(calls[0]?.url).toBe('https://app.perpl.xyz/api/v1/pub/context');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('loads scaling from GET /v1/pub/context and uses it', async () => {
    serve({ onCommand: (ws, f) => ack(ws, f) });
    const { fetchImpl, calls } = fakeFetch(() => ({ body: CONTEXT }));
    const client = makeClient({ markets: new PerplMarketRegistry({ network: 'mainnet', fetchImpl }) });
    await client.placeOrder({ clientOrderId: 'o', asset: 'ETH/USD', side: 'buy', kind: 'limit', price: dec(300012n, 2), size: size('150000') });
    expect(calls).toHaveLength(1);
    const frame = FakeWebSocket.instances[0]!.frames.find((f) => f.mt === 22)!;
    expect(frame).toMatchObject({ mkt: 20, p: 300012, s: 15 }); // 3000.12 at 2 dp, 0.0015 at 4 dp
  });

  it('refuses a size that scales to zero at the market step', async () => {
    serve();
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('100') });
    expect(result.reason).toContain('below the BTC minimum step');
  });

  it('refuses when the wallet snapshot reports order forwarding disabled (fw: false)', async () => {
    serve({
      afterSignIn: (ws) => ws.serverSend({ mt: 19, as: [{ id: ACCOUNT_ID, fw: false, fr: false, ft: 0, b: '0', lb: '0' }] }),
      onCommand: () => {
        throw new Error('the order must not be sent');
      },
    });
    const client = makeClient();
    await client.getPosition('BTC/USD'); // connects and receives the snapshot
    const result = await client.placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('allowOrderForwarding(true)');
    expect(FakeWebSocket.instances[0]!.frames.filter((f) => f.mt === 22)).toHaveLength(0);
  });

  it('ignores an account snapshot for a different account id', async () => {
    serve({
      afterSignIn: (ws) => ws.serverSend({ mt: 19, as: [{ id: 1, fw: false }] }),
      onCommand: (ws, f) => ack(ws, f),
    });
    const client = makeClient();
    await client.getPosition('BTC/USD');
    const result = await client.placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'limit', price: dec(950000n, 1), size: size('10000000') });
    expect(result.status).toBe('pending');
  });

  it('rejects a non-integer leverage', async () => {
    serve();
    const result = await makeClient().placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000'), leverageX: 2.5 });
    expect(result.reason).toContain('whole number');
  });

  it('surfaces a 3401 close as an authentication failure', async () => {
    FakeWebSocket.reset({ autoOpen: false });
    const client = makeClient();
    const pending = client.placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    await new Promise((r) => setTimeout(r, 5));
    FakeWebSocket.instances[0]!.close(3401, 'unauthorized');
    const result = await pending;
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('3401');
  });
});

describe('PerplClient: native stop-loss and take-profit', () => {
  it('maps kind and direction to the trigger condition and a protective rounding', () => {
    expect(perplTriggerCondition('stop_loss', 'long')).toBe(PERPL_TRIGGER.lteMark);
    expect(perplTriggerCondition('take_profit', 'long')).toBe(PERPL_TRIGGER.gteMark);
    expect(perplTriggerCondition('stop_loss', 'short')).toBe(PERPL_TRIGGER.gteMark);
    expect(perplTriggerCondition('take_profit', 'short')).toBe(PERPL_TRIGGER.lteMark);
    expect(perplTriggerRounding('stop_loss', 'long')).toBe('ceil');
    expect(perplTriggerRounding('take_profit', 'long')).toBe('floor');
    expect(perplTriggerRounding('stop_loss', 'short')).toBe('floor');
    expect(perplTriggerRounding('take_profit', 'short')).toBe('ceil');
  });

  it('places a long stop as a CloseLong trigger on mark price, linked to the entry request', async () => {
    serve({
      onCommand: (ws, f) => {
        ack(ws, f);
        if (f.tp === undefined) orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.filled, fs: 10000, fp: 950000 });
        else orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.untriggered, oid: 901 });
      },
    });
    const client = makeClient();
    await client.placeOrder({ clientOrderId: 'e', asset: 'BTC/USD', side: 'buy', kind: 'market', size: size('10000000') });
    const result = await client.placeTriggerOrder({
      clientOrderId: 'sl',
      asset: 'BTC/USD',
      kind: 'stop_loss',
      direction: 'long',
      size: size('10000000'),
      triggerPrice: dec(9412557n, 2), // 94,125.57 -> ceil to 941256 at 1 dp (toward price)
      linkedToClientOrderId: 'e',
    });

    const [entry, stop] = FakeWebSocket.instances[0]!.frames.filter((f) => f.mt === 22);
    expect(stop).toMatchObject({
      t: PERPL_ORDER_TYPE.closeLong,
      p: 0,
      s: 10000,
      tp: 941256,
      tpc: PERPL_TRIGGER.lteMark,
      tr: entry!.rq, // activates only if the entry trades
      lb: 0,
    });
    expect(result.status).toBe('pending');
    expect(result.venueOrderId).toBe('901');
  });

  it('places a short take-profit as CloseShort triggering when mark falls to the target', async () => {
    serve({ onCommand: (ws, f) => (ack(ws, f), orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.untriggered })) });
    const client = makeClient();
    await client.placeTriggerOrder({
      clientOrderId: 'tp',
      asset: 'BTC/USD',
      kind: 'take_profit',
      direction: 'short',
      size: size('10000000'),
      triggerPrice: dec(9000000n, 2),
    });
    const frame = FakeWebSocket.instances[0]!.frames.find((f) => f.mt === 22)!;
    expect(frame).toMatchObject({ t: PERPL_ORDER_TYPE.closeShort, tp: 900000, tpc: PERPL_TRIGGER.lteMark });
    expect(frame).not.toHaveProperty('tr');
  });

  it('refuses to link protection to an entry this client never placed', async () => {
    serve();
    const result = await makeClient().placeTriggerOrder({
      clientOrderId: 'sl',
      asset: 'BTC/USD',
      kind: 'stop_loss',
      direction: 'long',
      size: size('10000000'),
      triggerPrice: dec(9000000n, 2),
      linkedToClientOrderId: 'ghost',
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('unknown entry');
  });
});

describe('PerplClient: cancel, positions, history, market data', () => {
  it('cancels by venue order id with a Cancel (t: 5) frame', async () => {
    serve({
      onCommand: (ws, f) => {
        ack(ws, f);
        if (f.t !== PERPL_ORDER_TYPE.cancel) orderUpdate(ws, f, { st: PERPL_ORDER_STATUS.open, oid: 555 });
      },
    });
    const client = makeClient();
    await client.placeOrder({ clientOrderId: 'o', asset: 'BTC/USD', side: 'buy', kind: 'limit', price: dec(900000n, 1), size: size('10000000') });
    const cancel = await client.cancelOrder('o');
    const frame = FakeWebSocket.instances[0]!.frames.filter((f) => f.mt === 22).at(-1)!;
    expect(frame).toMatchObject({ t: PERPL_ORDER_TYPE.cancel, oid: 555, s: 0, mkt: 1 });
    expect(cancel).toMatchObject({ cancelled: true, venueOrderId: '555' });
  });

  it('will not cancel an order it has no venue id for', async () => {
    serve();
    const cancel = await makeClient().cancelOrder('nope');
    expect(cancel.cancelled).toBe(false);
  });

  it('reads the open position from mt:27 and signs shorts negative', async () => {
    serve({
      afterSignIn: (ws) =>
        ws.serverSend({ mt: 27, d: [{ mkt: 1, pid: 1, sd: 2, s: 20000, ep: 950000, lv: 100, c: '0' }] }),
    });
    const position = await makeClient().getPosition('BTC/USD');
    expect(position?.venue).toBe('perpl');
    expect(formatDecimal(position!.size)).toBe('−0.20000');
    expect(formatDecimal(position!.entryPrice!)).toBe('95,000.0');
  });

  it('fetches signed fills over REST and converts scaled integers to Decimals', async () => {
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.includes('/v1/trading/fills') ? { body: { d: [{ mkt: 1, oid: 7, t: 1, l: 2, p: 950000, s: 10000, f: '0.95' }], np: '' } } : undefined,
    );
    const client = makeClient({ fetchImpl });
    const fills = await client.getFills(2);
    expect(calls[0]?.url).toBe('https://app.perpl.xyz/api/v1/trading/fills?count=2');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    const canonical = buildRestCanonical({
      chainId: 143,
      method: 'GET',
      target: '/v1/trading/fills?count=2',
      timestamp: String(NOW),
      nonce: 'fixed-nonce',
      bodyHashHex: await sha256Hex(''),
    });
    expect(await verifyEd25519Base64Url(keyPair.publicKeyHex, headers['X-API-Signature']!, canonical)).toBe(true);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ orderId: 7, liquidity: 'taker', fee: '0.95' });
    expect(formatDecimal(fills[0]!.price!)).toBe('95,000.0');
    expect(formatDecimal(fills[0]!.size)).toBe('0.10000');
  });

  it('streams trade ticks from the market-data server as Decimals', async () => {
    serve();
    const client = makeClient();
    const ticks: Array<{ timestamp: number; price: string }> = [];
    const stop = client.subscribeMarketData('BTC/USD', (t) => ticks.push({ timestamp: t.timestamp, price: formatDecimal(t.price) }));
    await new Promise((r) => setTimeout(r, 10));
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('wss://app.perpl.xyz/ws/v1/market-data');
    expect(ws.frames[0]).toEqual({ mt: 5, subs: [{ stream: 'trades@1', subscribe: true }] });
    ws.serverSend({ mt: 18, sid: 1, d: [{ at: { b: 1, t: 1_760_000_123_000 }, p: 951234, s: 100, sd: 1 }] });
    expect(ticks).toEqual([{ timestamp: 1_760_000_123, price: '95,123.4' }]);
    stop();
  });
});
