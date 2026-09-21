import { describe, expect, it } from 'vitest';
import { parseDecimal } from '@kanon/spec';
import {
  demoMarkets,
  durationLabel,
  formatAmount,
  formatCountdown,
  formatUtc,
  ladderPermille,
  marketClaims,
  marketFromRow,
  marketsFromRows,
  outcomeHeadline,
  parseClock,
  phaseLabel,
  questionOf,
  sideLabel,
  sideMeaning,
  type DemoCard,
  type MarketRow,
} from './predict-map';

const NOW = 1_800_000_000;
const d = (v: string, decimals = 2) => parseDecimal(v, decimals);
const FEED = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const HASH = `0x${'7f'.repeat(32)}`;

const row = (over: Partial<MarketRow> = {}): MarketRow => ({
  _id: 'm1',
  asset: 'BTC/USD',
  assetClass: 'crypto',
  direction: 'above',
  thresholdPrice: { atoms: '68755', decimals: 0 },
  windowStart: NOW + 600,
  windowEnd: NOW + 600 + 14_400,
  bucketSeconds: 900,
  template: '4H',
  params: {
    offsetBps: 50,
    significantDigits: 5,
    windowSeconds: 14_400,
    bucketSeconds: 900,
    referencePrice: parseDecimal('68412.34', 8),
    referenceAt: NOW - 60,
    feedId: FEED,
  },
  termsHash: HASH,
  status: 'open',
  latest: { price: parseDecimal('68412.34', 8), publishTime: NOW - 60 },
  ...over,
});

describe('marketFromRow', () => {
  it('carries the terms, and the distance the threshold sits from the reference', () => {
    const m = marketFromRow(row(), []);
    expect(m.demo).toBe(false);
    expect(m.timeframe).toBe('4H');
    expect(m.terms?.offsetBps).toBe(50);
    expect(m.terms?.distanceBps).toBeGreaterThanOrEqual(50);
    expect(m.termsHash).toBe(HASH);
    expect(m.settlement).toBeNull();
  });

  it('shows the newest recorded price, or none when nothing has printed', () => {
    expect(marketFromRow(row(), []).price).toEqual(parseDecimal('68412.34', 8));
    const none = marketFromRow(row({ latest: null }), []);
    expect(none.price).toBeNull();
    expect(none.priceAt).toBeNull();
  });

  it('carries a hit with its deciding price and evidence hash', () => {
    const m = marketFromRow(
      row({
        status: 'settled',
        outcome: 'hit',
        decidingPrice: d('68801.00'),
        decidingAt: NOW + 900,
        windowExtreme: { price: d('68801.00'), at: NOW + 900 },
        recordedCandles: 12,
        evidenceHash: HASH,
        settledAt: (NOW + 20_000) * 1000,
      }),
      [],
    );
    expect(m.settlement).toMatchObject({
      outcome: 'hit',
      decidingPrice: d('68801.00'),
      decidingAt: NOW + 900,
      evidenceHash: HASH,
      recordedCandles: 12,
      settledAt: NOW + 20_000,
    });
  });

  it('carries a miss with no deciding price and the closest approach', () => {
    const m = marketFromRow(
      row({
        status: 'settled',
        outcome: 'miss',
        windowExtreme: { price: d('68700.00'), at: NOW + 1800 },
        recordedCandles: 9,
        evidenceHash: HASH,
      }),
      [],
    );
    expect(m.settlement?.outcome).toBe('miss');
    expect(m.settlement?.decidingPrice).toBeNull();
    expect(m.settlement?.windowExtreme?.price).toEqual(d('68700.00'));
  });

  it('carries an unresolvable market as such', () => {
    const m = marketFromRow(row({ status: 'unresolvable', evidenceHash: HASH }), []);
    expect(m.settlement?.outcome).toBe('unresolvable');
  });

  it('does not present a settled row with no evidence hash as a result', () => {
    const m = marketFromRow(row({ status: 'settled', outcome: 'hit' }), []);
    expect(m.status).toBe('settled');
    expect(m.settlement).toBeNull();
  });

  it('attaches only this market\'s stakes', () => {
    const m = marketFromRow(row(), [
      { marketId: 'm1', side: 'above', stake: d('0.01', 18), txHash: '0xab', result: undefined },
      { marketId: 'other', side: 'below' },
    ]);
    expect(m.positions).toEqual([{ side: 'above', stake: d('0.01', 18), result: null, txHash: '0xab' }]);
  });
});

describe('marketsFromRows', () => {
  it('never shows an asset without a Pyth feed, whatever the backend sent', () => {
    const rows = [row({ _id: 'a', asset: 'AVAX/USD' }), row({ _id: 'b', asset: 'ETH/USD' })];
    expect(marketsFromRows(rows, [], NOW).map((m) => m.id)).toEqual(['b']);
  });

  it('puts live markets first by soonest expiry, then those awaiting a result, then resolved ones', () => {
    const rows = [
      row({ _id: 'settled', status: 'settled', outcome: 'miss', evidenceHash: HASH, windowStart: NOW - 9000, windowEnd: NOW - 5000 }),
      row({ _id: 'late', windowEnd: NOW + 5000 }),
      row({ _id: 'expired', windowStart: NOW - 5000, windowEnd: NOW - 10 }),
      row({ _id: 'soon', windowEnd: NOW + 100 }),
      row({ _id: 'settled-newer', status: 'settled', outcome: 'hit', evidenceHash: HASH, windowStart: NOW - 4000, windowEnd: NOW - 100 }),
    ];
    expect(marketsFromRows(rows, [], NOW).map((m) => m.id)).toEqual([
      'soon',
      'late',
      'expired',
      'settled-newer',
      'settled',
    ]);
  });

  it('is empty for no rows', () => {
    expect(marketsFromRows([], [], NOW)).toEqual([]);
  });
});

describe('demoMarkets', () => {
  const cards: DemoCard[] = [
    { id: '1', asset: 'BTC/USD', timeframe: '1H', expires: '59:00', price: d('64200.00'), target: d('65000.00'), direction: 'above', evidenceHash: '0x7f…c31a' },
    { id: '4', asset: 'AVAX/USD', timeframe: '1D', expires: '23:59:00', price: d('45.00'), target: d('50.00'), direction: 'above', evidenceHash: '0x91b4…7e08' },
    { id: '2', asset: 'ETH/USD', timeframe: '4H', expires: '03:59:00', price: d('3400.00'), target: d('3600.00'), direction: 'above', evidenceHash: '0x4c2a…91df' },
  ];

  it('drops AVAX, which is not a market even as a fixture', () => {
    expect(demoMarkets(cards, NOW).map((m) => m.asset)).toEqual(['BTC/USD', 'ETH/USD']);
  });

  it('flags every one as demo, with no terms and no result', () => {
    for (const m of demoMarkets(cards, NOW)) {
      expect(m.demo).toBe(true);
      expect(m.terms).toBeNull();
      expect(m.settlement).toBeNull();
      expect(m.chain).toBeNull();
    }
  });

  it('counts down from the card\'s own expiry', () => {
    const [btc, eth] = demoMarkets(cards, NOW);
    expect(btc!.windowEnd - NOW).toBe(3540);
    expect(eth!.windowEnd - NOW).toBe(14_340);
  });
});

describe('parseClock', () => {
  it('reads mm:ss and hh:mm:ss', () => {
    expect(parseClock('59:00')).toBe(3540);
    expect(parseClock('03:59:00')).toBe(14_340);
    expect(parseClock('14:32')).toBe(872);
  });
  it('refuses anything else', () => {
    expect(parseClock('soon')).toBeNull();
    expect(parseClock('1:2:3:4')).toBeNull();
    expect(parseClock('12')).toBeNull();
    expect(parseClock('aa:bb')).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('is hh:mm:ss, zero-padded so the digits never change width', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(59)).toBe('00:00:59');
    expect(formatCountdown(3599)).toBe('00:59:59');
    expect(formatCountdown(3600)).toBe('01:00:00');
    expect(formatCountdown(86_399)).toBe('23:59:59');
  });
  it('carries days from a day up', () => {
    expect(formatCountdown(86_400)).toBe('1D 00:00:00');
    expect(formatCountdown(90_061)).toBe('1D 01:01:01');
  });
  it('rounds a partial second up and never goes below zero', () => {
    expect(formatCountdown(0.2)).toBe('00:00:01');
    expect(formatCountdown(-5)).toBe('00:00:00');
  });
});

describe('formatting', () => {
  it('writes a moment in UTC', () => {
    expect(formatUtc(0)).toBe('1970-01-01 00:00:00Z');
    expect(formatUtc(1_800_000_000)).toBe('2027-01-15 08:00:00Z');
  });
  it('labels a duration', () => {
    expect(durationLabel(900)).toBe('15M');
    expect(durationLabel(3600)).toBe('1H');
    expect(durationLabel(14_400)).toBe('4H');
    expect(durationLabel(86_400)).toBe('1D');
    expect(durationLabel(45)).toBe('45S');
  });
  it('trims an 18-decimal stake without losing a digit', () => {
    expect(formatAmount({ atoms: '10000000000000000', decimals: 18 })).toBe('0.01');
    expect(formatAmount({ atoms: '100000000000000000', decimals: 18 })).toBe('0.10');
    expect(formatAmount({ atoms: '123456789000000000', decimals: 18 })).toBe('0.123456789');
    expect(formatAmount({ atoms: '1000000000000000000', decimals: 18 })).toBe('1.00');
  });
});

describe('sides', () => {
  const above = { direction: 'above' as const, target: { atoms: '68755', decimals: 0 } };
  const below = { direction: 'below' as const, target: { atoms: '68070', decimals: 0 } };

  it('names UP and DOWN, never buy and sell', () => {
    expect(sideLabel('above')).toBe('UP');
    expect(sideLabel('below')).toBe('DOWN');
  });

  it('says what each side claims on an `above` market', () => {
    expect(sideMeaning(above, 'above')).toBe('REACHES 68,755');
    expect(sideMeaning(above, 'below')).toBe('STAYS BELOW 68,755');
  });

  it('says what each side claims on a `below` market', () => {
    expect(sideMeaning(below, 'below')).toBe('REACHES 68,070');
    expect(sideMeaning(below, 'above')).toBe('STAYS ABOVE 68,070');
  });

  it('states the question as a touch', () => {
    expect(questionOf(above)).toBe('▲ AT OR ABOVE 68,755');
    expect(questionOf(below)).toBe('▼ AT OR BELOW 68,070');
  });
});

describe('labels', () => {
  it('words an outcome without apologising for a miss', () => {
    expect(outcomeHeadline({ outcome: 'hit' } as never)).toBe('THRESHOLD TOUCHED');
    expect(outcomeHeadline({ outcome: 'miss' } as never)).toBe('THRESHOLD NOT REACHED');
    expect(outcomeHeadline({ outcome: 'unresolvable' } as never)).toBe('NO SAMPLES IN WINDOW');
  });
  it('labels every phase', () => {
    for (const p of ['upcoming', 'open', 'crossed', 'expired', 'settled', 'unresolvable'] as const) {
      expect(phaseLabel(p)).not.toBe('');
    }
  });
});

describe('marketClaims', () => {
  it('lists the terms every parameter that shaped the market', () => {
    const [terms] = marketClaims(marketFromRow(row(), []));
    expect(terms!.symbol).toBe('MARKET TERMS');
    const names = terms!.fields.map(([k]) => k);
    for (const k of ['REFERENCE PRICE', 'REFERENCE PRINT', 'OFFSET', 'ROUNDING', 'CANDLE', 'FEED', 'WINDOW OPENS', 'WINDOW ENDS', 'TERMS HASH']) {
      expect(names).toContain(k);
    }
  });

  it('adds the settlement with its deciding price and hash', () => {
    const claims = marketClaims(
      marketFromRow(
        row({
          status: 'settled',
          outcome: 'hit',
          decidingPrice: d('68801.00'),
          decidingAt: NOW + 900,
          windowExtreme: { price: d('68801.00'), at: NOW + 900 },
          recordedCandles: 12,
          evidenceHash: HASH,
        }),
        [],
      ),
    );
    const s = claims.find((c) => c.symbol === 'SETTLEMENT')!;
    expect(Object.fromEntries(s.fields)).toMatchObject({
      OUTCOME: 'THRESHOLD TOUCHED',
      'DECIDING PRICE': '68,801.00',
      'WINDOW HIGH': '68,801.00',
      'RECORDED CANDLES': '12',
    });
    expect(s.fields.find(([k]) => k === 'EVIDENCE HASH')?.[1]).toMatch(/^0x7f7f…7f7f$/);
  });

  it('shows the closest approach of a miss, labelled as a low on a `below` market', () => {
    const claims = marketClaims(
      marketFromRow(
        row({
          direction: 'below',
          status: 'settled',
          outcome: 'miss',
          windowExtreme: { price: d('68100.00'), at: NOW + 1800 },
          recordedCandles: 8,
          evidenceHash: HASH,
        }),
        [],
      ),
    );
    const s = claims.find((c) => c.symbol === 'SETTLEMENT')!;
    expect(s.fields.map(([k]) => k)).toContain('WINDOW LOW');
    expect(s.fields.map(([k]) => k)).not.toContain('DECIDING PRICE');
  });

  it('includes the person\'s own stake and how it came out', () => {
    const claims = marketClaims(
      marketFromRow(row({ status: 'unresolvable', evidenceHash: HASH }), [
        { marketId: 'm1', side: 'above', stake: d('0.01', 18), txHash: `0x${'ab'.repeat(32)}`, result: 'refunded' },
      ]),
    );
    const mine = claims.find((c) => c.symbol === 'YOUR SIDE · UP')!;
    expect(Object.fromEntries(mine.fields)).toMatchObject({ STAKE: '0.01', RESULT: 'REFUNDED' });
  });

  it('marks a demo card\'s terms as demo and invents no reference', () => {
    const [m] = demoMarkets(
      [{ id: '1', asset: 'BTC/USD', timeframe: '1H', expires: '59:00', price: d('64200.00'), target: d('65000.00'), direction: 'above', evidenceHash: '0x7f…c31a' }],
      NOW,
    );
    const [terms] = marketClaims(m!);
    expect(terms!.symbol).toBe('MARKET TERMS · DEMO');
    expect(terms!.fields.map(([k]) => k)).not.toContain('REFERENCE PRICE');
  });

  it('notes a threshold already touched while the window runs', () => {
    const claims = marketClaims(
      marketFromRow(row({ crossed: { price: d('68801.00'), at: NOW + 900 } }), []),
    );
    expect(claims.map((c) => c.symbol)).toContain('THRESHOLD TOUCHED');
  });
});

describe('ladderPermille', () => {
  it('puts the highest price at the top with a quarter-span of padding', () => {
    // span 100, pad 25: track is 75..225 wide 150 => 200 is 25/150 from the top
    const [hi, lo] = ladderPermille([d('200.00'), d('100.00')]);
    expect(hi).toBe(166);
    expect(lo).toBe(833);
  });

  it('keeps every mark inside the track and in order', () => {
    const marks = ladderPermille([d('68412.34'), d('68755.00'), null, d('68801.00')]);
    expect(marks[2]).toBeNull();
    for (const m of [marks[0], marks[1], marks[3]]) {
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThan(1000);
    }
    expect(marks[3]!).toBeLessThan(marks[1]!);
    expect(marks[1]!).toBeLessThan(marks[0]!);
  });

  it('centres equal prices and mixed scales', () => {
    expect(ladderPermille([d('5.00'), d('5.00')])).toEqual([500, 500]);
    expect(ladderPermille([d('1.5', 1), d('1.50', 2)])).toEqual([500, 500]);
  });

  it('is all null when there is nothing to place', () => {
    expect(ladderPermille([null, null])).toEqual([null, null]);
    expect(ladderPermille([])).toEqual([]);
  });
});
