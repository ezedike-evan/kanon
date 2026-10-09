import { MAX_CANDLES, MAX_TRADES, MT, createStreamState, kindOfFrame, parseStream, tagFrame, tagSnapshot } from './streams';

const CHAIN = 10143;

describe('parseStream', () => {
  it('accepts each supported form and returns its canonical name', () => {
    expect(parseStream('heartbeat@10143', CHAIN)).toEqual({ kind: 'heartbeat', name: 'heartbeat@10143' });
    expect(parseStream('market-state@10143', CHAIN)).toEqual({ kind: 'market-state', name: 'market-state@10143' });
    expect(parseStream('funding@10143', CHAIN)).toEqual({ kind: 'funding', name: 'funding@10143' });
    expect(parseStream('candles@16*900', CHAIN)).toEqual({ kind: 'candles', name: 'candles@16*900', marketId: 16 });
    expect(parseStream('order-book@16', CHAIN)).toEqual({ kind: 'order-book', name: 'order-book@16', marketId: 16 });
    expect(parseStream('trades@016', CHAIN)).toEqual({ kind: 'trades', name: 'trades@16', marketId: 16 });
  });

  it.each([
    ['a chain stream on another chain', 'market-state@143'],
    ['a resolution the venue does not serve', 'candles@16*61'],
    ['candles with no resolution', 'candles@16'],
    ['a resolution on a non-candle stream', 'trades@16*60'],
    ['a kind the gateway has not observed', 'gas-stats@10143'],
    ['market id zero', 'trades@0'],
    ['characters that would need escaping', 'trades@16","x":"'],
    ['a non-string', 16],
    ['an over-long name', `trades@${'1'.repeat(60)}`],
  ])('refuses %s', (_label, raw) => {
    expect(parseStream(raw, CHAIN)).toBeNull();
  });
});

describe('kindOfFrame', () => {
  it('names the stream kind for every relayed frame type and nothing else', () => {
    expect(kindOfFrame(MT.marketState)).toBe('market-state');
    expect(kindOfFrame(MT.funding)).toBe('funding');
    expect(kindOfFrame(MT.candlesUpdate)).toBe('candles');
    expect(kindOfFrame(MT.bookUpdate)).toBe('order-book');
    expect(kindOfFrame(MT.tradesSnapshot)).toBe('trades');
    expect(kindOfFrame(MT.heartbeat)).toBe('heartbeat');
    expect(kindOfFrame(MT.subscribeAck)).toBeUndefined();
    expect(kindOfFrame('9')).toBeUndefined();
  });
});

describe('candle state', () => {
  const candle = (t: number, c: number) => ({ t, o: 100, c, h: 110, l: 90, v: '1', n: 1 });

  it('has no snapshot until the venue sends one, and ignores an update before it', () => {
    const state = createStreamState('candles');
    state.apply({ mt: MT.candlesUpdate, d: [candle(60_000, 101)] });
    expect(state.snapshot()).toBeNull();
  });

  it('replaces the forming candle and appends the next one', () => {
    const state = createStreamState('candles');
    state.apply({ mt: MT.candlesSnapshot, sid: 7, at: { b: 1, t: 1 }, r: 60, d: [candle(0, 100), candle(60_000, 101)] });
    // The venue sends the candle that just closed and the one now forming.
    state.apply({ mt: MT.candlesUpdate, sid: 7, sn: 9, at: { b: 2, t: 2 }, r: 60, d: [candle(60_000, 105), candle(120_000, 106)] });
    state.apply({ mt: MT.candlesUpdate, sid: 7, sn: 10, at: { b: 3, t: 3 }, r: 60, d: [candle(120_000, 107)] });

    expect(state.snapshot()).toEqual({
      mt: MT.candlesSnapshot,
      sid: 7,
      sn: 10,
      at: { b: 3, t: 3 },
      r: 60,
      d: [candle(0, 100), candle(60_000, 105), candle(120_000, 107)],
    });
  });

  it('keeps a bounded number of candles, dropping the oldest', () => {
    const state = createStreamState('candles');
    state.apply({ mt: MT.candlesSnapshot, at: {}, r: 60, d: [candle(0, 1)] });
    for (let i = 1; i <= MAX_CANDLES + 5; i++) state.apply({ mt: MT.candlesUpdate, at: {}, d: [candle(i * 60_000, i)] });
    const d = state.snapshot()!.d as Array<{ t: number }>;
    expect(d).toHaveLength(MAX_CANDLES);
    expect(d[d.length - 1]!.t).toBe((MAX_CANDLES + 5) * 60_000);
  });
});

describe('order book state', () => {
  it('applies level changes and removals, and lists each side best first', () => {
    const state = createStreamState('order-book');
    state.apply({
      mt: MT.bookSnapshot,
      at: { b: 1 },
      bid: [{ p: 100, s: 5, o: 1 }, { p: 99, s: 2, o: 1 }],
      ask: [{ p: 101, s: 4, o: 2 }, { p: 102, s: 1, o: 1 }],
    });
    state.apply({
      mt: MT.bookUpdate,
      at: { b: 2 },
      sn: 2,
      bid: [{ p: 100, s: 0, o: 0 }, { p: 98, s: 7, o: 3 }],
      ask: [{ p: 101, s: 9, o: 3 }, { p: 100.5, s: 1, o: 1 }],
    });
    expect(state.snapshot()).toEqual({
      mt: MT.bookSnapshot,
      at: { b: 2 },
      sn: 2,
      bid: [{ p: 99, s: 2, o: 1 }, { p: 98, s: 7, o: 3 }],
      ask: [{ p: 100.5, s: 1, o: 1 }, { p: 101, s: 9, o: 3 }, { p: 102, s: 1, o: 1 }],
    });
  });

  it('starts over on a fresh snapshot', () => {
    const state = createStreamState('order-book');
    state.apply({ mt: MT.bookSnapshot, at: {}, bid: [{ p: 100, s: 5, o: 1 }], ask: [] });
    state.apply({ mt: MT.bookSnapshot, at: {}, bid: [{ p: 90, s: 1, o: 1 }], ask: [] });
    expect(state.snapshot()!.bid).toEqual([{ p: 90, s: 1, o: 1 }]);
  });
});

describe('keyed state (market-state, funding)', () => {
  it('merges later frames, which carry only the markets that changed', () => {
    const state = createStreamState('market-state');
    state.apply({ mt: MT.marketState, sn: 1, d: { '16': { mrk: 1 }, '32': { mrk: 2 } } });
    state.apply({ mt: MT.marketState, sn: 2, d: { '32': { mrk: 3 } } });
    expect(state.snapshot()).toEqual({ mt: MT.marketState, sn: 2, d: { '16': { mrk: 1 }, '32': { mrk: 3 } } });
  });
});

describe('trade state', () => {
  it('appends new trades and keeps a bounded tail', () => {
    const state = createStreamState('trades');
    state.apply({ mt: MT.tradesSnapshot, d: [{ p: 1 }] });
    for (let i = 2; i <= MAX_TRADES + 3; i++) state.apply({ mt: MT.tradesUpdate, sn: i, d: [{ p: i }] });
    const snap = state.snapshot()!;
    expect(snap.mt).toBe(MT.tradesSnapshot);
    const d = snap.d as Array<{ p: number }>;
    expect(d).toHaveLength(MAX_TRADES);
    expect(d[d.length - 1]).toEqual({ p: MAX_TRADES + 3 });
  });
});

describe('heartbeat state', () => {
  it('is the latest frame', () => {
    const state = createStreamState('heartbeat');
    expect(state.snapshot()).toBeNull();
    state.apply({ mt: MT.heartbeat, h: 1 });
    state.apply({ mt: MT.heartbeat, h: 2 });
    expect(state.snapshot()).toEqual({ mt: MT.heartbeat, h: 2 });
  });
});

describe('tagging', () => {
  it('adds the stream name to a venue frame without changing the rest', () => {
    const raw = '{"mt":9,"sid":3000,"d":{"16":{"mrk":1}}}';
    expect(JSON.parse(tagFrame('market-state@10143', raw))).toEqual({
      stream: 'market-state@10143',
      mt: 9,
      sid: 3000,
      d: { '16': { mrk: 1 } },
    });
  });

  it('serialises a synthesised snapshot in the same shape', () => {
    expect(JSON.parse(tagSnapshot('heartbeat@10143', { mt: 100, h: 5 }))).toEqual({
      stream: 'heartbeat@10143',
      mt: 100,
      h: 5,
    });
  });
});
