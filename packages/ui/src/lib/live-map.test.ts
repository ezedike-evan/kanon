import { describe, expect, it } from 'vitest';
import {
  RULE_04,
  RULE_04_LOOSENED,
  applyParamEdit,
  dec,
  formatDecimal,
  parseDecimal,
  type Candle,
  type StrategySpec,
} from '@kanon/spec';
import {
  blockedLogFromTrades,
  blockedRow,
  compilerData,
  coolingOffFromStrategy,
  countTrades,
  emptyRule,
  homeFromTrades,
  pickStrategies,
  pinAvailabilityFor,
  pinningData,
  priceLine,
  proposalFromTrade,
  refusalFromTrade,
  reviewData,
  ruleFromStrategy,
  safeSpec,
  shareCardFromStrategy,
  tradeDetailFromTrade,
  utcFull,
  utcShort,
  type LiveStrategy,
  type LiveTrade,
} from './live-map';

const usd = (v: string) => parseDecimal(v, 2);
const T = Date.parse('2026-09-02T14:32:07Z');

const strategy = (over: Partial<LiveStrategy> = {}): LiveStrategy => ({
  _id: 's1',
  _creationTime: 1,
  status: 'pinned',
  spec: RULE_04,
  specHash: '0x7f3c9a41b8e2d055c31a7f3c9a41b8e2d055c31a7f3c9a41b8e2d055c31a0000',
  pinnedAt: Date.parse('2026-08-14T10:00:00Z'),
  pinTxHash: `0x${'ab'.repeat(32)}`,
  registryAddress: '0x1234567890abcdef1234567890abcdef12345678',
  ...over,
});

const bosRefusal: LiveTrade = {
  _id: 't-refused',
  strategyId: 's1',
  direction: 'long',
  asset: 'BTC/USD',
  entry: usd('68207.30'),
  size: dec('1840', 4),
  stop: usd('67866.00'),
  status: 'refused',
  satisfiedPredicateIds: [],
  failedPredicateId: 'p1',
  failedSymbol: 'bos_bullish',
  failingValue: usd('68207.30'),
  requiredValue: usd('68412.50'),
  evidenceRefs: ['pyth/btc-usd#900s@1788359400'],
  createdAt: T,
  feed: 'pyth/btc-usd',
  results: [
    {
      predicateId: 'p1',
      kind: 'break_of_structure',
      symbol: 'bos_bullish',
      satisfied: false,
      decidingValue: usd('68207.30'),
      referenceValue: usd('68412.50'),
      at: 1788359400,
    },
  ],
};

const proposed: LiveTrade = {
  ...bosRefusal,
  _id: 't-proposed',
  status: 'proposed',
  entry: usd('68441.20'),
  stop: usd('68098.99'),
  size: dec('1840', 4),
  failedPredicateId: undefined as never,
  failedSymbol: undefined as never,
  failingValue: undefined as never,
  requiredValue: undefined as never,
  undoExpiresAt: T + 7000,
  equity: usd('25000.00'),
  equitySource: 'paper',
  riskBps: 50,
  results: [
    {
      predicateId: 'p1',
      kind: 'break_of_structure',
      symbol: 'bos_bullish',
      satisfied: true,
      decidingValue: usd('68441.20'),
      referenceValue: usd('68412.50'),
      at: 1788359400,
    },
    {
      predicateId: 'p2',
      kind: 'fair_value_gap',
      symbol: 'fvg_present',
      satisfied: true,
      decidingValue: dec('22', 0),
      referenceValue: dec('15', 0),
      at: 1788359400,
    },
  ],
  evidenceRefs: ['a', 'b'],
};

describe('pickStrategies', () => {
  it('picks the latest pinned strategy and the latest draft, and numbers them by age', () => {
    const list: LiveStrategy[] = [
      strategy({ _id: 'a', _creationTime: 10 }),
      strategy({ _id: 'b', _creationTime: 20, status: 'draft', spec: undefined, pendingSpec: RULE_04 }),
      strategy({ _id: 'c', _creationTime: 30, status: 'cooling_off' }),
      strategy({ _id: 'd', _creationTime: 40, status: 'draft', spec: undefined }),
    ];
    const picked = pickStrategies(list);
    expect(picked.active?._id).toBe('c');
    expect(picked.draft?._id).toBe('d');
    expect(picked.ordinalOf('a')).toBe('RULE 01');
    expect(picked.ordinalOf('c')).toBe('RULE 03');
    expect(picked.nextOrdinal).toBe('RULE 05');
  });

  it('is empty, not throwing, before anything has loaded', () => {
    const picked = pickStrategies(undefined);
    expect(picked.active).toBeUndefined();
    expect(picked.nextOrdinal).toBe('RULE 01');
  });
});

describe('safeSpec', () => {
  it('returns null for a row that does not parse, rather than rendering it', () => {
    expect(safeSpec({ nonsense: true })).toBeNull();
    expect(safeSpec(undefined)).toBeNull();
    expect(safeSpec(RULE_04)?.id).toBe('rule-04');
  });
});

describe('ruleFromStrategy', () => {
  it('derives the rule card from the pinned spec and its real hash', () => {
    const rule = ruleFromStrategy({ strategy: strategy(), spec: RULE_04, ordinal: 'RULE 04' });
    expect(rule.asset).toBe('BTC / USD');
    expect(rule.timeframe).toBe('15M');
    expect(rule.pinnedOn).toBe('PINNED 08-14');
    expect(rule.specHash.startsWith('0x7f3c9a41b8')).toBe(true);
    expect(rule.predicates).toHaveLength(3);
    expect(rule.bucketSeconds).toBe(900);
    expect(rule.contract).toBe('0x1234…5678');
  });

  it('says not deployed when the strategy has no registry', () => {
    const rule = ruleFromStrategy({
      strategy: strategy({ registryAddress: undefined as never }),
      spec: RULE_04,
      ordinal: 'RULE 01',
    });
    expect(rule.contract).toBe('NOT DEPLOYED');
  });

  it('the empty rule carries no hash and no predicates', () => {
    const rule = emptyRule('RULE 01');
    expect(rule.specHash).toBe('');
    expect(rule.predicates).toEqual([]);
  });
});

describe('home', () => {
  const trades = [
    { ...proposed, status: 'executed' as const },
    { ...proposed, _id: 'x', status: 'executed' as const },
    { ...proposed, _id: 'y', status: 'undone' as const },
    bosRefusal,
  ];

  it('counts only executed and refused, and computes adherence in integer bps', () => {
    expect(countTrades(trades)).toEqual({ taken: 2, blocked: 1 });
    const home = homeFromTrades(trades, priceLine([]));
    expect(home.adherenceBps).toBe(6667);
    expect(home.attempts).toBe(3);
  });

  it('has no P&L to show until something has closed', () => {
    expect(formatDecimal(homeFromTrades(trades, priceLine([])).pnl30d)).toBe('0.00');
  });

  it('has zero attempts, not a made-up adherence, for a fresh rule', () => {
    const home = homeFromTrades([], priceLine([]));
    expect(home.attempts).toBe(0);
  });
});

describe('priceLine', () => {
  const candle = (i: number, close: string): Candle => ({
    bucketIndex: i,
    timestamp: i * 900,
    open: usd(close),
    high: usd(close),
    low: usd(close),
    close: usd(close),
    synthetic: false,
  });

  it('uses the latest close, its move over the window, and integer bar heights', () => {
    const line = priceLine([candle(0, '100.00'), candle(1, '101.00'), candle(2, '99.00'), candle(3, '102.00')]);
    expect(formatDecimal(line.price)).toBe('102.00');
    expect(line.changeBps).toBe(200);
    expect(line.sparkline).toHaveLength(4);
    for (const h of line.sparkline) {
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(20);
      expect(h).toBeLessThanOrEqual(100);
    }
    expect(line.sparkline[3]).toBe(100);
    expect(line.sparkline[2]).toBe(20);
  });

  it('a flat series is a flat line, not a division by zero', () => {
    const line = priceLine([candle(0, '100.00'), candle(1, '100.00')]);
    expect(line.sparkline).toEqual([60, 60]);
    expect(line.changeBps).toBe(0);
  });

  it('an empty series has no price', () => {
    expect(priceLine([]).sparkline).toEqual([]);
  });
});

describe('refusalFromTrade', () => {
  it('names the predicate and the exact numbers, without apology', () => {
    const r = refusalFromTrade(bosRefusal, RULE_04)!;
    expect(r.predicate).toBe('bos_bullish');
    expect(formatDecimal(r.requiredHigh)).toBe('68,412.50');
    expect(formatDecimal(r.currentPrice)).toBe('68,207.30');
    expect(formatDecimal(r.shortfall)).toBe('−205.20');
    expect(r.shortfallBps).toBe(-30);
    expect(r.reason).toContain('closed candle above the prior swing high');
    expect(r.requiredLabel).toBe('REQUIRED HIGH');
    expect(r.unit).toBe('price');
    expect(r.at).toBe('2026-09-02 14:32:07 UTC');
    expect(r.tradeId).toBe('t-refused');
    // Not claimed to be on-chain: the proposer judged it against the pinned spec.
    expect(r.label).not.toMatch(/on-chain/i);
    expect(r.reason.toLowerCase()).not.toMatch(/sorry|error|failed|oops/);
  });

  it('writes a fair value gap in percent', () => {
    const trade: LiveTrade = {
      ...bosRefusal,
      failedPredicateId: 'p2',
      failedSymbol: 'fvg_present',
      failingValue: dec('9', 0),
      requiredValue: dec('15', 0),
    };
    const r = refusalFromTrade(trade, RULE_04)!;
    expect(r.unit).toBe('bps');
    expect(r.shortfallBps).toBe(-6);
    expect(r.reason).toContain('at least 0.15%');
    expect(r.requiredLabel).toBe('REQUIRED GAP');
  });

  it('is null for a trade that was not refused', () => {
    expect(refusalFromTrade(proposed, RULE_04)).toBeNull();
  });
});

describe('proposalFromTrade', () => {
  it('shows each satisfied predicate beside the arithmetic that satisfied it', () => {
    const p = proposalFromTrade(proposed, RULE_04, T)!;
    expect(p.checks).toEqual([
      { label: 'Break of structure', evidence: '68,441.20 > 68,412.50' },
      { label: 'Fair value gap', evidence: '0.22% ≥ 0.15%' },
    ]);
    expect(p.undoSeconds).toBe(7);
    expect(p.sizeUnit).toBe('BTC');
    expect(p.sizing).toBe('25,000.00 PAPER EQUITY');
    expect(p.status).toBe('proposed');
  });

  it('pins no target, because the spec pins none', () => {
    expect(proposalFromTrade(proposed, RULE_04, T)!.target).toBeNull();
  });

  it('counts the undo window down against the clock it is given', () => {
    expect(proposalFromTrade(proposed, RULE_04, T + 3500)!.undoSeconds).toBe(4);
    expect(proposalFromTrade(proposed, RULE_04, T + 60_000)!.undoSeconds).toBe(0);
  });

  it('an undone trade has no window left', () => {
    const p = proposalFromTrade({ ...proposed, status: 'undone' }, RULE_04, T)!;
    expect(p.status).toBe('undone');
    expect(p.undoSeconds).toBe(0);
  });

  it('is null for a refusal', () => {
    expect(proposalFromTrade(bosRefusal, RULE_04, T)).toBeNull();
  });
});

describe('tradeDetailFromTrade', () => {
  it('lists every predicate as a claim with the candle that decided it', () => {
    const d = tradeDetailFromTrade(proposed, RULE_04);
    expect(d.claims.map((c) => c.symbol)).toEqual(['bos_bullish', 'fvg_present']);
    const bos = d.claims[0]!;
    expect(bos.fields).toContainEqual(['close', '68,441.20']);
    expect(bos.fields).toContainEqual(['prior swing extreme', '68,412.50']);
    expect(bos.fields).toContainEqual(['comparison', '68,441.20 > 68,412.50']);
    expect(bos.fields).toContainEqual(['evidence ref', 'a']);
    expect(bos.fields.find(([k]) => k === 'scan window')).toBeUndefined(); // this fixture recorded none
    expect(d.side).toBe('LONG · PROPOSED');
  });

  it('shows the scan window a trade was evaluated in, when the row recorded one', () => {
    const d = tradeDetailFromTrade(
      { ...proposed, scan: { from: 1788358500, to: 1788359400, asOf: 1788359400 } },
      RULE_04,
    );
    const field = d.claims[0]!.fields.find(([k]) => k === 'scan window');
    expect(field?.[1]).toMatch(/UTC to .* UTC$/);
  });

  it('reports no result, exit or return for a trade that has not closed', () => {
    const d = tradeDetailFromTrade(proposed, RULE_04);
    expect(d.result).toBeNull();
    expect(d.exit).toBeNull();
    expect(d.returnBps).toBeNull();
  });

  it('a refused trade is evidence too, with the unmet claim marked', () => {
    const d = tradeDetailFromTrade(bosRefusal, RULE_04);
    expect(d.side).toBe('LONG · REFUSED');
    expect(d.claims[0]!.badge).toBe('NOT MET');
    expect(d.claims[0]!.tone).toBe('ash');
  });
});

describe('blocked log', () => {
  it('writes the row as predicate, then required, got and the difference', () => {
    expect(blockedRow(bosRefusal, RULE_04)).toEqual({
      symbol: 'bos_bullish',
      at: '09-02 14:32',
      detail: 'req 68,412.50 · got 68,207.30 · −205.20',
      tradeId: 't-refused',
    });
  });

  it('counts would-have-lost from the modelled outcomes, and leaves pending ones out', () => {
    const second: LiveTrade = { ...bosRefusal, _id: 't2', createdAt: T + 1000 };
    const third: LiveTrade = { ...bosRefusal, _id: 't3', createdAt: T + 2000 };
    const log = blockedLogFromTrades({
      trades: [bosRefusal, second, third, proposed],
      spec: RULE_04,
      now: T,
      report: {
        't-refused': { status: 'stopped', exit: usd('67866.00'), pnl: usd('-627.36'), lost: true, at: 1 },
        t2: { status: 'open', exit: usd('68500.00'), pnl: usd('53.93'), lost: false, at: 1 },
        t3: { status: 'pending' },
      },
    });
    expect(log.refused).toBe(3);
    expect(formatDecimal(log.wouldHaveLost)).toBe('−627.36');
    expect(log.note).toContain('1 of 2 would have closed at a loss');
    expect(log.note).toContain('1 awaiting later prices');
    expect(log.rows.map((r) => r.tradeId)).toEqual(['t3', 't2', 't-refused']);
    expect(log.period).toBe('SEP 2026 ▾');
  });

  it('says nothing was refused when nothing was, rather than showing fixtures', () => {
    const log = blockedLogFromTrades({ trades: [], spec: RULE_04, report: {}, now: T });
    expect(log.refused).toBe(0);
    expect(log.rows).toEqual([]);
    expect(log.note).toMatch(/nothing has been refused/i);
  });

  it('is loading while the report has not arrived and there is something to model', () => {
    const log = blockedLogFromTrades({ trades: [bosRefusal], spec: RULE_04, report: undefined, now: T });
    expect(log.loading).toBe(true);
  });
});

describe('coolingOffFromStrategy', () => {
  const ends = Date.parse('2026-09-03T14:41:00Z');

  it('reads the hold from cooldownEndsAt', () => {
    const c = coolingOffFromStrategy(
      strategy({ status: 'cooling_off', pendingSpec: RULE_04_LOOSENED, cooldownEndsAt: ends }),
      T,
    )!;
    expect(c.requestedAt).toBe(Date.parse('2026-09-02T14:41:00Z'));
    expect(c.endsAt).toBe(ends);
    expect(c.requestedLabel).toBe('REQUESTED 09-02 14:41 UTC · 24H HOLD');
    expect(c.pendingSpec.risk.stopDistanceBps.value).toBe(90);
    expect(c.currentSpec.risk.stopDistanceBps.value).toBe(50);
  });

  it('is null when nothing is cooling off, or the rows do not parse', () => {
    expect(coolingOffFromStrategy(strategy(), T)).toBeNull();
    expect(coolingOffFromStrategy(undefined, T)).toBeNull();
    expect(
      coolingOffFromStrategy(strategy({ status: 'cooling_off', pendingSpec: {}, cooldownEndsAt: ends }), T),
    ).toBeNull();
  });
});

describe('shareCardFromStrategy', () => {
  it('carries the real hash, real counts, and no P&L it cannot verify', () => {
    const s = strategy();
    const card = shareCardFromStrategy({
      strategy: s,
      spec: RULE_04,
      trades: [{ ...proposed, status: 'executed' }, bosRefusal],
      now: Date.parse('2026-08-17T10:00:00Z'),
    });
    expect(card.specHash).toBe(s.specHash);
    expect(card.url).toBe('kanon.xyz/v/7f3c9a41');
    expect(card.window).toBe('PINNED 3D');
    expect(card.taken).toBe(1);
    expect(card.blocked).toBe(1);
    expect(card.adherenceBps).toBe(5000);
    expect(card.verifiedPnlBps).toBeNull();
    expect(card.overrides).toBe(0);
    expect(card.summary).toEqual([
      'bos_bullish · fvg ≥ 0.15% · sweep_prev_day_low',
      'risk ≤ 0.50% · lookback 5 · tf 15m',
    ]);
  });

  it('a card pinned today says so', () => {
    const card = shareCardFromStrategy({ strategy: strategy(), spec: RULE_04, trades: [], now: strategy().pinnedAt! });
    expect(card.window).toBe('PINNED TODAY');
  });
});

describe('compilerData and reviewData', () => {
  it('flags the lines the last turn changed and reports whether there is a spec to review', () => {
    const edited = applyParamEdit(RULE_04, 'risk.riskPerTradeBps', 25);
    if (!edited.ok) throw new Error('edit failed');
    const c = compilerData({
      ordinal: 'RULE 07',
      transcript: [],
      spec: edited.spec,
      previous: RULE_04,
      status: 'idle',
    });
    expect(c.draft).toBe('DRAFT · RULE 07');
    expect(c.hasSpec).toBe(true);
    expect(c.lines.filter((l) => l.changed).map((l) => l.text)).toEqual(['risk_per_trade: 0.25%']);
    expect(compilerData({ ordinal: 'RULE 07', transcript: [], spec: null, previous: null, status: 'idle' }).hasSpec).toBe(false);
  });

  it('surfaces a compile failure text without dropping the transcript', () => {
    const c = compilerData({
      ordinal: 'RULE 01',
      transcript: [{ from: 'YOU', at: '10:00', text: 'x' }],
      spec: null,
      previous: null,
      status: 'failed',
      error: 'DashScope API authentication failed',
    });
    expect(c.status).toBe('failed');
    expect(c.error).toContain('authentication');
    expect(c.transcript).toHaveLength(1);
  });

  it('a draft review lists every inferred default, from the spec', () => {
    const r = reviewData({ spec: RULE_04, baseline: null, mode: 'draft', acknowledged: false, busy: false });
    expect(r.inferred).toHaveLength(3);
    expect(r.acknowledged).toBe(false);
    expect(r.preview).toBeNull();
    expect(r.params.length).toBeGreaterThan(3);
  });

  it('an amend review previews tightening as immediate and loosening as a hold', () => {
    const tight = applyParamEdit(RULE_04, 'risk.riskPerTradeBps', 25);
    const loose = applyParamEdit(RULE_04, 'risk.stopDistanceBps', 90);
    if (!tight.ok || !loose.ok) throw new Error('edit failed');
    const a = reviewData({ spec: tight.spec, baseline: RULE_04, mode: 'amend', acknowledged: true, busy: false });
    expect(a.preview?.kind).toBe('immediate');
    const b = reviewData({ spec: loose.spec, baseline: RULE_04, mode: 'amend', acknowledged: true, busy: false });
    expect(b.preview?.kind).toBe('cooling_off');
    expect(b.preview?.cooldownSeconds).toBe(86_400);
    const c = reviewData({ spec: RULE_04, baseline: RULE_04, mode: 'amend', acknowledged: true, busy: false });
    expect(c.preview?.kind).toBe('none');
  });

  it('an empty review has nothing in it', () => {
    const r = reviewData({ spec: null, baseline: null, mode: 'empty', acknowledged: false, busy: false });
    expect(r.plain).toEqual([]);
    expect(r.inferred).toEqual([]);
  });
});

describe('pinningData', () => {
  it('shows the registry minimum at four places, and the hold from the spec package', () => {
    const p = pinningData({
      specHash: strategy().specHash,
      contract: '0x1234567890abcdef1234567890abcdef12345678',
      minBond: dec('250000000000000000', 18),
      nativeSymbol: 'MON',
      availability: { state: 'ready' },
      busy: false,
    });
    expect(formatDecimal(p.bond)).toBe('0.2500');
    expect(p.bondUnit).toBe('MON');
    expect(p.contract).toBe('0x1234…5678');
    expect(p.agreements[2]).toContain('24-hour');
  });

  it('says NOT DEPLOYED, and carries the reason, when there is no registry', () => {
    const p = pinningData({
      specHash: '',
      contract: undefined,
      minBond: null,
      nativeSymbol: 'MON',
      availability: { state: 'not_deployed', message: 'The registry has not been deployed.' },
      busy: false,
    });
    expect(p.contract).toBe('NOT DEPLOYED');
    expect(p.availability.state).toBe('not_deployed');
    expect(formatDecimal(p.bond)).toBe('0.0000');
  });
});

describe('time', () => {
  it('formats in UTC', () => {
    expect(utcFull(T)).toBe('2026-09-02 14:32:07 UTC');
    expect(utcShort(T)).toBe('09-02 14:32');
  });
});

it('keeps the fixture spec type-compatible', () => {
  const s: StrategySpec = RULE_04;
  expect(s.predicates).toHaveLength(3);
});

describe('pinAvailabilityFor', () => {
  const ok = {
    ok: true as const,
    target: {
      specHash: `0x${'ab'.repeat(32)}`,
      predicatesCommitment: `0x${'cd'.repeat(32)}`,
      series: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
    },
  };
  const missing = {
    ok: false as const,
    reason: 'series_not_deployed' as const,
    message: 'No canonical series is deployed for BTC/USD, so this rule cannot be pinned yet.',
  };

  it('a ready registry and wallet are not enough without a deployed series', () => {
    const a = pinAvailabilityFor({ state: 'ready' }, missing);
    expect(a.state).toBe('not_deployed');
    expect('message' in a && a.message).toMatch(/no canonical series/i);
  });

  it('is ready when the target could be built, and unchanged before it has been worked out', () => {
    expect(pinAvailabilityFor({ state: 'ready' }, ok)).toEqual({ state: 'ready' });
    expect(pinAvailabilityFor({ state: 'ready' }, null)).toEqual({ state: 'ready' });
  });

  it('never upgrades a state that was already blocked', () => {
    const blocked = { state: 'no_wallet' as const, message: 'No wallet.' };
    expect(pinAvailabilityFor(blocked, ok)).toBe(blocked);
    expect(pinAvailabilityFor(blocked, missing)).toBe(blocked);
  });

  it('pinningData shows the commitment and series, or NOT DEPLOYED for the series', () => {
    const base = {
      specHash: `0x${'ab'.repeat(32)}`,
      contract: '0x1234567890abcdef1234567890abcdef12345678',
      minBond: dec('250000000000000000', 18),
      nativeSymbol: 'MON',
      availability: { state: 'ready' as const },
      busy: false,
    };
    const good = pinningData({ ...base, target: ok });
    expect(good.commitment?.startsWith('0xcdcdcdcdcd')).toBe(true);
    expect(good.series).toBe('0xDc64…F6C9');
    expect(good.availability.state).toBe('ready');

    const bad = pinningData({ ...base, target: missing });
    expect(bad.series).toBe('NOT DEPLOYED');
    expect(bad.availability.state).toBe('not_deployed');

    // Demo and pre-computation: the rows are simply absent.
    expect(pinningData(base).commitment).toBeUndefined();
  });
});
