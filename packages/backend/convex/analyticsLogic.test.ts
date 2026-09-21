import { describe, expect, it } from 'vitest';
import { dec, type Candle, type Decimal } from '@kanon/spec';
import {
  assessRisk,
  buildReport,
  coolingOffTime,
  equityCurve,
  maxDrawdown,
  modelTrade,
  positionPnl,
  ratioBps,
  refusalsByPredicate,
  summariseAdherence,
  summariseAvoided,
  type AnalyticsTrade,
  type AssetCandles,
} from './analyticsLogic';

const usd = (atoms: number | bigint, decimals = 2): Decimal => dec(BigInt(atoms), decimals);
const T0 = Date.parse('2026-09-01T00:00:00Z');

function candle(i: number, low: number, high: number, close: number): Candle {
  const at = T0 / 1000 + i * 900;
  return {
    bucketIndex: at / 900,
    timestamp: at,
    open: usd(close),
    high: usd(high),
    low: usd(low),
    close: usd(close),
    synthetic: false,
  };
}

function trade(over: Partial<AnalyticsTrade> & { id: string }): AnalyticsTrade {
  return {
    direction: 'long',
    asset: 'BTC/USD',
    entry: usd(6_800_000),
    size: dec(1_000n, 3), // 1.000 BTC
    stop: usd(6_780_000),
    status: 'refused',
    createdAt: T0,
    ...over,
  };
}

const refusedOn = (id: string, predicateId: string, symbol: string, createdAt = T0) =>
  trade({
    id,
    status: 'refused',
    failedPredicateId: predicateId,
    failedSymbol: symbol,
    createdAt,
    results: [
      { predicateId, kind: 'break_of_structure', symbol, satisfied: false },
      { predicateId: 'other', kind: 'fair_value_gap', symbol: 'fvg_present', satisfied: true },
    ],
  });

describe('ratioBps', () => {
  it('rounds half up and is zero over nothing', () => {
    expect(ratioBps(1n, 3n)).toBe(3333);
    expect(ratioBps(2n, 3n)).toBe(6667);
    expect(ratioBps(1n, 8n)).toBe(1250);
    expect(ratioBps(5n, 0n)).toBe(0);
    expect(ratioBps(-1n, 3n)).toBe(-3333);
  });
});

describe('summariseAdherence', () => {
  it('counts executed satisfied trades against every attempt', () => {
    const trades = [
      trade({ id: 'a', status: 'executed', results: [{ predicateId: 'p', kind: 'k', symbol: 's', satisfied: true }] }),
      trade({ id: 'b', status: 'executed' }),
      trade({ id: 'c', status: 'executed' }),
      refusedOn('d', 'p', 'bos_bullish'),
    ];
    const a = summariseAdherence(trades);
    expect(a).toMatchObject({ executed: 3, refused: 1, attempts: 4, satisfied: 3, breaches: 0 });
    expect(a.adherenceBps).toBe(7500);
    expect(a.refusalBps).toBe(2500);
  });

  it('leaves cancelled and pending proposals out of the denominator', () => {
    const a = summariseAdherence([
      trade({ id: 'a', status: 'executed' }),
      trade({ id: 'b', status: 'undone' }),
      trade({ id: 'c', status: 'proposed' }),
    ]);
    expect(a).toMatchObject({ attempts: 1, undone: 1, proposed: 1, adherenceBps: 10_000 });
  });

  it('does not assume the rule held: an executed trade with a failed predicate is a breach', () => {
    const a = summariseAdherence([
      trade({ id: 'a', status: 'executed' }),
      trade({ id: 'b', status: 'executed', failedPredicateId: 'p' }),
    ]);
    expect(a.breaches).toBe(1);
    expect(a.adherenceBps).toBe(5000);
  });

  it('is null before any attempt', () => {
    const a = summariseAdherence([]);
    expect(a.adherenceBps).toBeNull();
    expect(a.refusalBps).toBeNull();
  });
});

describe('loss avoided', () => {
  const series = (candles: Candle[]): Record<string, AssetCandles> => ({
    'BTC/USD': { bucketSeconds: 900, candles },
  });

  it('plays a refused long to its own stop', () => {
    const t = refusedOn('r1', 'p', 'bos_bullish');
    // Candle 0 holds the refusal and is ignored; candle 1 trades through the stop.
    const o = modelTrade(t, series([candle(0, 6_799_000, 6_801_000, 6_800_000), candle(1, 6_770_000, 6_800_000, 6_775_000)]));
    expect(o.status).toBe('stopped');
    if (o.status === 'stopped') expect(o.pnl).toEqual(usd(-20_000)); // 1 BTC * -200.00
  });

  it('marks a setup that never touched its stop at the latest close', () => {
    const t = refusedOn('r2', 'p', 'bos_bullish');
    const o = modelTrade(t, series([candle(0, 0, 0, 6_800_000), candle(1, 6_795_000, 6_830_000, 6_820_000)]));
    expect(o.status).toBe('open');
    if (o.status === 'open') {
      expect(o.lost).toBe(false);
      expect(o.pnl).toEqual(usd(20_000));
    }
  });

  it('gives no verdict where the data starts after the setup', () => {
    const t = refusedOn('r3', 'p', 'bos_bullish', T0 - 5 * 900 * 1000);
    const o = modelTrade(t, series([candle(0, 6_700_000, 6_900_000, 6_800_000)]));
    expect(o.status).toBe('pending');
  });

  it('gives no verdict for an asset with no candles', () => {
    expect(modelTrade(refusedOn('r4', 'p', 's'), {}).status).toBe('pending');
  });

  it('sums losses as a positive figure and reports what a refusal would have won', () => {
    const s = summariseAvoided([
      { status: 'stopped', exit: usd(1), pnl: usd(-20_000), lost: true, at: 1 },
      { status: 'open', exit: usd(1), pnl: usd(-5_050), lost: true, at: 1 },
      { status: 'open', exit: usd(1), pnl: usd(8_000), lost: false, at: 1 },
      { status: 'pending' },
    ]);
    expect(s).toMatchObject({ refused: 4, judged: 3, pending: 1, wouldHaveLostCount: 2, wouldHaveWonCount: 1 });
    expect(s.lossAvoided).toEqual(usd(25_050));
    expect(s.gainForegone).toEqual(usd(8_000));
  });

  it('adds prices of different scales exactly', () => {
    const s = summariseAvoided([
      { status: 'open', exit: usd(1), pnl: dec(-150n, 2), lost: true, at: 1 },
      { status: 'open', exit: usd(1), pnl: dec(-1n, 8), lost: true, at: 1 },
    ]);
    expect(s.lossAvoided).toEqual(dec(150_000_001n, 8));
  });

  it('has no loss to report when nothing is judged', () => {
    const s = summariseAvoided([]);
    expect(s.lossAvoided).toEqual(usd(0));
    expect(s.judged).toBe(0);
  });
});

describe('refusalsByPredicate', () => {
  it('groups by the failed predicate, names it in SMC language and links the latest trade', () => {
    const refused = [
      refusedOn('r1', 'p_bos', 'bos_bullish', T0),
      refusedOn('r2', 'p_bos', 'bos_bullish', T0 + 5000),
      refusedOn('r3', 'p_fvg', 'fvg_present', T0 + 9000),
    ];
    const rows = refusalsByPredicate(refused, {
      r1: { status: 'stopped', exit: usd(1), pnl: usd(-10_000), lost: true, at: 1 },
      r2: { status: 'open', exit: usd(1), pnl: usd(3_000), lost: false, at: 1 },
      r3: { status: 'pending' },
    });
    expect(rows.map((r) => r.predicateId)).toEqual(['p_bos', 'p_fvg']);
    expect(rows[0]).toMatchObject({
      label: 'bos_bullish',
      count: 2,
      shareBps: 6667,
      lostCount: 1,
      latestTradeId: 'r2',
    });
    expect(rows[0]!.lossAvoided).toEqual(usd(10_000));
    expect(rows[1]).toMatchObject({ label: 'fvg_present', count: 1, shareBps: 3333, lostCount: 0 });
  });
});

/**
 * Vectors taken from packages/contracts/test/RiskEngine.t.sol and
 * MarginAccount.t.sol, so an edit to either side that breaks the mirror shows up here.
 * Ten percent maintenance, entry 100_000, size 10_000: a 1_000 move is 100 of P&L.
 */
describe('assessRisk mirrors MarginAccount.healthFactor', () => {
  const params = { maintenanceMarginBps: 1000 };
  const long = (size: number) => ({
    asset: 'BTC/USD',
    side: 'long' as const,
    size: dec(BigInt(size), 0),
    entryPrice: dec(100_000n, 0),
  });
  const mark = (price: number) => ({ 'BTC/USD': dec(BigInt(price), 0) });

  it('collateral 1_500, 10_000 long marked at 96_000 -> health 1.1e18, inside the ADL band', () => {
    const r = assessRisk({ collateral: dec(1500n, 0), positions: [long(10_000)], marks: mark(96_000), params });
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.unrealizedPnl).toEqual(dec(-400n, 0));
    expect(r.equity).toEqual(dec(1100n, 0));
    expect(r.maintenance).toEqual(dec(1000n, 0));
    expect(r.healthFactor).toEqual(dec(1_100_000_000_000_000_000n, 18));
    expect(r.band).toBe('deleveraging');
  });

  it('after ADL: 7_500 left, collateral 1_400 -> 1_100e18 / 750, truncated like Solidity', () => {
    const r = assessRisk({ collateral: dec(1400n, 0), positions: [long(7_500)], marks: mark(96_000), params });
    if (r.status !== 'ok') throw new Error(r.status);
    expect(BigInt(r.healthFactor!.atoms)).toBe((1_100n * 10n ** 18n) / 750n);
    expect(r.band).toBe('healthy');
  });

  it('is exactly the ADL threshold at 1.2e18, which is healthy (strict upper bound)', () => {
    const r = assessRisk({ collateral: dec(1600n, 0), positions: [long(10_000)], marks: mark(96_000), params });
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.healthFactor).toEqual(dec(1_200_000_000_000_000_000n, 18));
    expect(r.band).toBe('healthy');
  });

  it('is exactly 1e18 at the liquidation line, which is not yet liquidatable', () => {
    const r = assessRisk({ collateral: dec(1400n, 0), positions: [long(10_000)], marks: mark(96_000), params });
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.healthFactor).toEqual(dec(10n ** 18n, 18));
    expect(r.band).toBe('deleveraging');
  });

  it('goes liquidatable below 1e18 and is zero once equity is gone', () => {
    const under = assessRisk({ collateral: dec(1300n, 0), positions: [long(10_000)], marks: mark(96_000), params });
    if (under.status !== 'ok') throw new Error(under.status);
    expect(BigInt(under.healthFactor!.atoms)).toBeLessThan(10n ** 18n);
    expect(under.band).toBe('liquidatable');

    const gone = assessRisk({ collateral: dec(1000n, 0), positions: [long(10_000)], marks: mark(90_000), params });
    if (gone.status !== 'ok') throw new Error(gone.status);
    expect(gone.healthFactor).toEqual(dec(0n, 18));
    expect(gone.band).toBe('liquidatable');
  });

  it('subtracts debt from equity: 1_900e18 / 1_000', () => {
    const r = assessRisk({
      collateral: dec(2000n, 0),
      debt: dec(100n, 0),
      positions: [long(10_000)],
      marks: mark(100_000),
      params,
    });
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.healthFactor).toEqual(dec(1_900_000_000_000_000_000n, 18));
  });

  it('negates the truncated P&L for a short, as the contract does', () => {
    // 7 * (99 - 100) / 100 = truncate(-0.07) = 0 -> short 0, not +1.
    expect(positionPnl(7n, dec(100n, 0), dec(99n, 0), 'long')).toBe(0n);
    expect(positionPnl(7n, dec(100n, 0), dec(99n, 0), 'short')).toBe(0n);
    // 150 * (99 - 100) / 100 = truncate(-1.5) = -1 (toward zero, not -2).
    expect(positionPnl(150n, dec(100n, 0), dec(99n, 0), 'long')).toBe(-1n);
    expect(positionPnl(150n, dec(100n, 0), dec(99n, 0), 'short')).toBe(1n);
  });

  it('has no health factor with nothing to maintain, as type(uint256).max has no figure', () => {
    const flat = assessRisk({ collateral: dec(1500n, 0), positions: [], marks: {}, params });
    expect(flat.status).toBe('flat');
    const dust = assessRisk({ collateral: dec(1500n, 0), positions: [long(1)], marks: mark(100_000), params });
    if (dust.status !== 'ok') throw new Error(dust.status);
    expect(dust.healthFactor).toBeNull(); // 1 * 1000 / 1e4 truncates to zero maintenance
    expect(dust.band).toBe('healthy');
  });

  it('claims no health factor without a price, but still reports exposure', () => {
    const r = assessRisk({ collateral: dec(1500n, 0), positions: [long(10_000)], marks: {}, params });
    expect(r.status).toBe('unpriced');
    if (r.status === 'unpriced') {
      expect(r.missing).toEqual(['BTC/USD']);
      expect(r.lines[0]!.notional).toEqual(dec(10_000n, 0));
      expect(r.lines[0]!.markPrice).toBeNull();
    }
  });

  it('reads exposure across assets, net of shorts, with leverage in bps', () => {
    const r = assessRisk({
      collateral: dec(1000_00n, 2),
      positions: [
        { asset: 'BTC/USD', side: 'long', size: dec(600_00n, 2), entryPrice: dec(100_000_00n, 2) },
        { asset: 'ETH/USD', side: 'short', size: dec(200_00n, 2), entryPrice: dec(4_000_00n, 2) },
      ],
      marks: { 'BTC/USD': dec(100_000_00n, 2), 'ETH/USD': dec(4_000_00n, 2) },
      params,
    });
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.gross).toEqual(dec(800_00n, 2));
    expect(r.net).toEqual(dec(400_00n, 2));
    expect(r.leverageBps).toBe(8000);
    expect(r.lines.map((l) => [l.asset, l.shareBps])).toEqual([
      ['BTC/USD', 7500],
      ['ETH/USD', 2500],
    ]);
    expect(r.maintenance).toEqual(dec(80_00n, 2));
    expect(r.healthFactor).toEqual(dec(12_500_000_000_000_000_000n, 18));
  });

  it('normalises asset names when matching a mark', () => {
    const r = assessRisk({
      collateral: dec(1500n, 0),
      positions: [{ ...long(10_000), asset: 'btc / usd' }],
      marks: { 'BTC/USD': dec(100_000n, 0) },
      params,
    });
    expect(r.status).toBe('ok');
  });

  it('defaults to the deployment maintenance of 5% and states it', () => {
    const r = assessRisk({ collateral: dec(1500n, 0), positions: [long(10_000)], marks: mark(100_000) });
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.maintenanceBps).toBe(500);
    expect(r.maintenance).toEqual(dec(500n, 0));
    expect(r.adlHealthThreshold).toEqual(dec(1_200_000_000_000_000_000n, 18));
  });
});

describe('drawdown', () => {
  const eq = (at: number, n: number): { at: number; equity: Decimal } => ({ at, equity: usd(n) });

  it('finds the deepest peak-to-trough fall, not the last one', () => {
    const d = maxDrawdown([eq(1, 100_00), eq(2, 120_00), eq(3, 90_00), eq(4, 130_00), eq(5, 117_00)]);
    if (d.status !== 'ok') throw new Error('empty');
    // 120 -> 90 is 25.00%; 130 -> 117 is 10.00%.
    expect(d.maxDrawdownBps).toBe(2500);
    expect(d.currentDrawdownBps).toBe(1000);
    expect(d.peak).toEqual(usd(120_00));
    expect(d.trough).toEqual(usd(90_00));
    expect(d.peakAt).toBe(2);
    expect(d.troughAt).toBe(3);
  });

  it('is zero on a curve that only rises', () => {
    const d = maxDrawdown([eq(1, 100), eq(2, 110), eq(3, 120)]);
    if (d.status !== 'ok') throw new Error('empty');
    expect(d.maxDrawdownBps).toBe(0);
  });

  it('reads points in time order whatever order they arrive in', () => {
    const d = maxDrawdown([eq(3, 90_00), eq(1, 100_00), eq(2, 120_00)]);
    if (d.status !== 'ok') throw new Error('empty');
    expect(d.maxDrawdownBps).toBe(2500);
  });

  it('needs at least two points', () => {
    expect(maxDrawdown([]).status).toBe('empty');
    expect(maxDrawdown([eq(1, 100)]).status).toBe('empty');
  });

  it('builds a curve from a start and dated P&L, with the start before the first event', () => {
    const c = equityCurve(usd(1_000_00), [
      { at: 20, pnl: usd(-300_00) },
      { at: 10, pnl: usd(100_00) },
    ]);
    expect(c.map((p) => [p.at, p.equity.atoms])).toEqual([
      [9, '100000'],
      [10, '110000'],
      [20, '80000'],
    ]);
    const d = maxDrawdown(c);
    if (d.status !== 'ok') throw new Error('empty');
    expect(d.maxDrawdownBps).toBe(2727); // 300 of 1100
  });

  it('has no curve without events', () => {
    expect(equityCurve(usd(100), [])).toEqual([]);
  });
});

describe('coolingOffTime', () => {
  const now = Date.parse('2026-09-02T15:00:00Z');

  it('reports how far through the 24h hold a loosening is', () => {
    const endsAt = now + 6 * 3600 * 1000;
    const c = coolingOffTime({ status: 'cooling_off', cooldownEndsAt: endsAt, now });
    expect(c).toEqual({
      active: true,
      holdMs: 86_400_000,
      remainingMs: 21_600_000,
      elapsedMs: 64_800_000,
      progressBps: 7500,
    });
  });

  it('is inactive when nothing is cooling off, or when the hold has run', () => {
    expect(coolingOffTime({ status: 'pinned', now }).active).toBe(false);
    const done = coolingOffTime({ status: 'cooling_off', cooldownEndsAt: now - 1, now });
    expect(done).toMatchObject({ active: false, remainingMs: 0, progressBps: 10_000 });
  });

  it('never claims more than the hold itself', () => {
    const c = coolingOffTime({ status: 'cooling_off', cooldownEndsAt: now + 999_999_999_999, now });
    expect(c.remainingMs).toBe(c.holdMs);
    expect(c.elapsedMs).toBe(0);
  });
});

describe('buildReport', () => {
  const candles = [
    candle(0, 6_799_000, 6_801_000, 6_800_000),
    candle(1, 6_770_000, 6_800_000, 6_775_000),
    candle(2, 6_770_000, 6_840_000, 6_830_000),
  ];
  const trades: AnalyticsTrade[] = [
    refusedOn('r1', 'p_bos', 'bos_bullish', T0),
    trade({
      id: 'e1',
      status: 'executed',
      createdAt: T0,
      executedAt: T0,
      equity: usd(10_000_00),
      entry: usd(6_800_000),
      stop: usd(6_700_000),
      results: [{ predicateId: 'p_bos', kind: 'k', symbol: 'bos_bullish', satisfied: true }],
    }),
  ];

  const report = buildReport({
    now: T0 + 3 * 900_000,
    strategy: { id: 's1', status: 'pinned', specHash: '0xabc', asset: 'BTC/USD' },
    trades,
    series: { 'BTC/USD': { bucketSeconds: 900, candles } },
    account: { collateral: usd(10_000_00) },
    positions: [],
    marks: {},
  });

  it('leads with adherence and what the refusal saved', () => {
    expect(report.adherence).toMatchObject({ executed: 1, refused: 1, adherenceBps: 5000 });
    expect(report.avoided).toMatchObject({ judged: 1, wouldHaveLostCount: 1 });
    expect(report.avoided.lossAvoided).toEqual(usd(20_000));
    expect(report.byPredicate[0]).toMatchObject({ label: 'bos_bullish', latestTradeId: 'r1' });
  });

  it('models the executed trade, curves it from the equity it was sized against, and labels nothing as fill', () => {
    // e1 (long 1 BTC at 68,000.00) is marked at the final close, 68,300.00 -> +300.00.
    expect(report.pnl).toEqual({ total: usd(30_000), trades: 1 });
    expect(report.equityCurve).toHaveLength(2);
    expect(report.equityCurve[0]!.equity).toEqual(usd(10_000_00));
    expect(report.equityCurve[1]!.equity).toEqual(usd(10_300_00));
    expect(report.drawdown.status).toBe('ok');
  });

  it('carries a flat account through as flat, and no account as none', () => {
    expect(report.risk.status).toBe('flat');
    const none = buildReport({
      now: T0,
      strategy: { id: 's1', status: 'pinned', specHash: '0x', asset: 'BTC/USD' },
      trades: [],
      series: {},
      account: null,
      positions: [],
      marks: {},
    });
    expect(none.risk.status).toBe('none');
    expect(none.adherence.adherenceBps).toBeNull();
    expect(none.drawdown.status).toBe('empty');
  });

  it('is JSON-safe: no bigint survives into the report', () => {
    expect(() => JSON.stringify(report)).not.toThrow();
  });
});
