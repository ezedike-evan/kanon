import { describe, expect, it } from 'vitest';
import {
  RULE_04,
  RULE_04_LOOSENED,
  RULE_04_NO_TARGET,
  BOS20_15M_NO_TARGET,
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
  lossAvoided,
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
  gateTxOf,
  tradeDetailFromTrade,
  utcFull,
  utcShort,
  type LiveStrategy,
  type LiveTrade,
} from './live-map';
import { DEMO_ANALYTICS } from './analytics-demo';
import { BLOCKED } from './demo';

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
    expect(formatDecimal(r.requiredHigh!)).toBe('68,412.50');
    expect(formatDecimal(r.currentPrice!)).toBe('68,207.30');
    expect(formatDecimal(r.shortfall!)).toBe('−205.20');
    expect(r.shortfallBps).toBe(-30);
    expect(r.reason).toContain('closed candle above the prior swing high');
    expect(r.requiredLabel).toBe('REQUIRED HIGH');
    expect(r.unit).toBe('price');
    expect(r.at).toBe('2026-09-02 14:32:07 UTC');
    expect(r.tradeId).toBe('t-refused');
    // Not claimed to be on-chain: a row from before the gate was judged off-chain, and says so.
    expect(r.label).not.toMatch(/on-chain/i);
    expect(r.label).toBe('DECIDED OFF-CHAIN, BEFORE THE GATE');
    expect(r.decided).toBe('offchain');
    expect(r.gate).toBeUndefined();
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
    expect(d.claims.map((c) => c.symbol)).toEqual(['DECIDED OFF-CHAIN', 'bos_bullish', 'fvg_present']);
    const bos = d.claims[1]!;
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
    const field = d.claims[1]!.fields.find(([k]) => k === 'scan window');
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
    expect(d.claims[1]!.badge).toBe('NOT MET');
    expect(d.claims[1]!.tone).toBe('ash');
    // Decided before the gate: said, with no transaction to point at.
    expect(d.claims[0]).toMatchObject({ symbol: 'DECIDED OFF-CHAIN', badge: 'OFF-CHAIN', tone: 'ash' });
    expect(d.gateTx).toBeUndefined();
  });
});

describe('blocked log', () => {
  it('writes the row as predicate, then required, got and the difference', () => {
    expect(blockedRow(bosRefusal, RULE_04)).toEqual({
      symbol: 'bos_bullish',
      at: '09-02 14:32',
      detail: 'req 68,412.50 · got 68,207.30 · −205.20',
      tradeId: 't-refused',
      decided: 'offchain',
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

  it('states its figure as a loss avoided: positive, the way Analytics states it, and never below zero', () => {
    expect(formatDecimal(lossAvoided({ wouldHaveLost: usd('-627.36') }))).toBe('627.36');
    expect(formatDecimal(lossAvoided({ wouldHaveLost: usd('0.00') }))).toBe('0.00');
    // A sum that is somehow a gain avoided no loss: it is not printed as one.
    expect(formatDecimal(lossAvoided({ wouldHaveLost: usd('12.00') }))).toBe('0.00');
    // The demo's two screens are one number.
    expect(lossAvoided(BLOCKED)).toEqual(DEMO_ANALYTICS.avoided.lossAvoided);
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

  it('a review of a rule with both exits stated lists nothing missing', () => {
    const r = reviewData({ spec: RULE_04, baseline: null, mode: 'draft', acknowledged: false, busy: false });
    expect(r.missingExits).toEqual([]);
    expect(r.exitsSentence).toBe('');
  });

  it('a review of a rule with no target lists it, openable, with the sentence', () => {
    const r = reviewData({ spec: RULE_04_NO_TARGET, baseline: null, mode: 'draft', acknowledged: true, busy: false });
    expect(r.missingExits).toEqual([
      { name: 'target_distance', key: 'risk.targetDistanceBps', display: 'not stated', absent: true },
    ]);
    expect(r.exitsSentence).toMatch(/^This rule has no stated target\./);
    expect(r.params.some((p) => p.key === 'risk.targetDistanceBps' && p.missing)).toBe(true);
  });

  it('a stop the compiler chose is listed as missing, with the value it chose', () => {
    const chosen = { ...RULE_04, risk: { ...RULE_04.risk, stopDistanceBps: { value: 50, inferred: true } } };
    const r = reviewData({ spec: chosen, baseline: null, mode: 'draft', acknowledged: true, busy: false });
    expect(r.missingExits).toEqual([
      { name: 'stop_distance', key: 'risk.stopDistanceBps', display: '0.50%', absent: false },
    ]);
  });

  it('amending a rule pinned without a target: stating one previews as immediate, and is an add', () => {
    const r0 = reviewData({ spec: BOS20_15M_NO_TARGET, baseline: BOS20_15M_NO_TARGET, mode: 'amend', acknowledged: true, busy: false });
    expect(r0.missingExits.map((m) => m.name)).toEqual(['target_distance']);
    const added = applyParamEdit(BOS20_15M_NO_TARGET, 'risk.targetDistanceBps', 400);
    if (!added.ok) throw new Error(added.error);
    const r = reviewData({ spec: added.spec, baseline: BOS20_15M_NO_TARGET, mode: 'amend', acknowledged: true, busy: false });
    expect(r.missingExits).toEqual([]);
    expect(r.preview?.kind).toBe('immediate');
    expect(r.preview?.changes).toEqual([{ path: 'target_distance', before: null, after: '400', kind: 'add' }]);
  });

  it('says a sweep rule cannot pass the on-chain gate, and nothing for one without a sweep', () => {
    const sweep = reviewData({ spec: RULE_04, baseline: null, mode: 'draft', acknowledged: false, busy: false });
    expect(sweep.gateNote).toMatch(/^This rule cannot pass the on-chain gate/);
    const bos = reviewData({ spec: BOS20_15M_NO_TARGET, baseline: null, mode: 'draft', acknowledged: false, busy: false });
    expect(bos.gateNote).toBeNull();
    expect(reviewData({ spec: null, baseline: null, mode: 'empty', acknowledged: false, busy: false }).gateNote).toBeNull();
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
      spec: RULE_04,
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
      spec: null,
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
    const a = pinAvailabilityFor({ state: 'ready' }, missing, RULE_04);
    expect(a.state).toBe('not_deployed');
    expect('message' in a && a.message).toMatch(/no canonical series/i);
  });

  it('is ready when the target could be built, and unchanged before it has been worked out', () => {
    expect(pinAvailabilityFor({ state: 'ready' }, ok, RULE_04)).toEqual({ state: 'ready' });
    expect(pinAvailabilityFor({ state: 'ready' }, null, RULE_04)).toEqual({ state: 'ready' });
    expect(pinAvailabilityFor({ state: 'ready' }, ok, null)).toEqual({ state: 'ready' });
  });

  it('never upgrades a state that was already blocked', () => {
    const blocked = { state: 'no_wallet' as const, message: 'No wallet.' };
    expect(pinAvailabilityFor(blocked, ok, RULE_04)).toBe(blocked);
    expect(pinAvailabilityFor(blocked, missing, RULE_04)).toBe(blocked);
  });

  it('a rule without a stated target cannot be pinned on any device, and says so first', () => {
    const sentence = 'This rule has no stated target. A rule is pinned and tested only with a stop and a target you set.';
    expect(pinAvailabilityFor({ state: 'ready' }, ok, RULE_04_NO_TARGET)).toEqual({ state: 'needs_exits', message: sentence });
    expect(pinAvailabilityFor({ state: 'ready' }, missing, RULE_04_NO_TARGET).state).toBe('needs_exits');
    expect(pinAvailabilityFor({ state: 'no_wallet', message: 'No wallet.' }, ok, RULE_04_NO_TARGET).state).toBe('needs_exits');
  });

  it('demo stays demo', () => {
    const demo = { state: 'demo' as const, message: 'Demo data.' };
    expect(pinAvailabilityFor(demo, null, RULE_04_NO_TARGET)).toBe(demo);
  });

  it('pinningData shows the commitment and series, or NOT DEPLOYED for the series', () => {
    const base = {
      specHash: `0x${'ab'.repeat(32)}`,
      spec: RULE_04,
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

    const legacy = pinningData({ ...base, spec: RULE_04_NO_TARGET, target: ok });
    expect(legacy.availability.state).toBe('needs_exits');
  });
});

describe('autopilot on the rows a screen draws', () => {
  /** A proposal the sweep wrote for a pass: no undo window, and what the gateway is asked to open. */
  const waiting: LiveTrade = {
    ...proposed,
    _id: 't-auto',
    origin: 'autopilot',
    handoff: 'pending',
    stakeUsd: 10,
    holdSeconds: 900,
    undoExpiresAt: undefined as never,
  };
  const opened: LiveTrade = {
    ...waiting,
    status: 'executed',
    handoff: 'opened',
    executedAt: T + 4000,
    executionMode: 'paper',
    timedTradeId: 'tt-1',
  };
  const notOpened: LiveTrade = {
    ...waiting,
    status: 'undone',
    handoff: 'not_opened',
    handoffReason: 'The BTC market is closed.',
  };

  it('a rule says whether autopilot is on for it, and a row that does not say is off', () => {
    expect(ruleFromStrategy({ strategy: strategy({ autopilot: true }), spec: RULE_04, ordinal: 'RULE 04' }).autopilot).toBe(true);
    expect(ruleFromStrategy({ strategy: strategy({ autopilot: false }), spec: RULE_04, ordinal: 'RULE 04' }).autopilot).toBe(false);
    expect(ruleFromStrategy({ strategy: strategy(), spec: RULE_04, ordinal: 'RULE 04' }).autopilot).toBe(false);
    expect(emptyRule('RULE 01').autopilot).toBe(false);
  });

  it('a proposal its owner asked for carries no autopilot note', () => {
    expect(proposalFromTrade(proposed, RULE_04, T)).not.toHaveProperty('autopilot');
    expect(tradeDetailFromTrade(proposed, RULE_04)).not.toHaveProperty('autopilot');
    expect(refusalFromTrade(bosRefusal, RULE_04)).not.toHaveProperty('autopilot');
    expect(blockedRow(bosRefusal, RULE_04)).not.toHaveProperty('autopilot');
  });

  it('a waiting autopilot proposal has no undo window, and says it waits for the gateway', () => {
    const p = proposalFromTrade(waiting, RULE_04, T)!;
    expect(p.status).toBe('proposed');
    // Nothing to count down: confirm and undo are not this proposal's.
    expect(p.undoSeconds).toBe(0);
    expect(p).not.toHaveProperty('undoExpiresAt');
    expect(p.autopilot).toMatchObject({ state: 'waiting', label: 'WAITING FOR THE GATEWAY', sent: '$10 · 15m', timedTradeId: null });
  });

  it('an opened one leads to its timed trade, and its size stays the rule\'s own sizing', () => {
    const p = proposalFromTrade(opened, RULE_04, T)!;
    expect(p.status).toBe('executed');
    expect(p.autopilot).toMatchObject({ state: 'opened', timedTradeId: 'tt-1', sent: '$10 · 15m' });
    // The row's size is what the rule's risk setting works out, not the $10 that was sent.
    expect(formatDecimal(p.size)).toBe(formatDecimal(proposed.size));
    // Paper, and said to be: this row's own fill was never a venue fill.
    expect(p.paper).toBe(true);
  });

  it('one that was not opened shows the reason verbatim, and is not called undone', () => {
    const p = proposalFromTrade(notOpened, RULE_04, T)!;
    expect(p.autopilot).toMatchObject({ state: 'not_opened', label: 'NOT OPENED', reason: 'The BTC market is closed.' });
    expect(tradeDetailFromTrade(notOpened, RULE_04).side).toBe('LONG · NOT OPENED');
  });

  it("the evidence screen names autopilot's states in its own words", () => {
    expect(tradeDetailFromTrade(waiting, RULE_04).side).toBe('LONG · WAITING FOR THE GATEWAY');
    expect(tradeDetailFromTrade(opened, RULE_04).side).toBe('LONG · OPENED');
    expect(tradeDetailFromTrade(opened, RULE_04).autopilot?.timedTradeId).toBe('tt-1');
    // The evidence chain is the same arithmetic a button press records.
    expect(tradeDetailFromTrade(opened, RULE_04).claims.map((c) => c.symbol)).toEqual(['DECIDED OFF-CHAIN', 'bos_bullish', 'fvg_present']);
  });

  it('a refusal autopilot recorded is a refusal like any other, and says who asked', () => {
    const refused: LiveTrade = { ...bosRefusal, origin: 'autopilot' };
    const r = refusalFromTrade(refused, RULE_04)!;
    expect(r.predicate).toBe('bos_bullish');
    expect(r.autopilot).toMatchObject({ state: 'refused', sent: null, timedTradeId: null, reason: null });
    expect(tradeDetailFromTrade(refused, RULE_04).side).toBe('LONG · REFUSED');
    expect(blockedRow(refused, RULE_04)).toMatchObject({ symbol: 'bos_bullish', autopilot: true });
    // It still counts as the rule working.
    expect(countTrades([refused, opened])).toEqual({ taken: 1, blocked: 1 });
  });
});

describe('a row the on-chain gate decided', () => {
  const TX = `0x${'cd'.repeat(32)}`;
  // 2026-09-02 14:45 UTC: the bucket the gate judged, and its block 40 s into it.
  const BUCKET = Date.parse('2026-09-02T14:45:00Z') / 1000 / 900;
  const gate = {
    chainId: 10143,
    gate: '0x388f55962954c5083d885543af22b1b6ee640ec0',
    series: '0x74c4b8710fb83dcc18c1a5ae2e35a63dc005257a',
    chainStrategyId: '0',
    txHash: TX,
    blockNumber: 48_000_123,
    blockTime: BUCKET * 900 + 40,
    bucketIndex: BUCKET,
    signer: '0xe0072e39d6fb592bafb3c6783710c1b24ec601b4',
    gasLimit: '317628',
    priceExpo: -8,
    verdict: 'refused' as const,
    symbol: 'bos_bullish',
    decidingValue: '6820730000000',
    offchainVerdict: 'refused' as const,
  };
  const onChain = (v: string) => parseDecimal(v, 8);
  const gateRefusal: LiveTrade = {
    ...bosRefusal,
    _id: 't-gate',
    failingValue: onChain('68207.30'),
    requiredValue: onChain('68412.50'),
    evidenceRefs: [`monad:10143/tx/${TX}`, 'pyth/btc-usd#900s@1788359400'],
    resultsSource: 'chain',
    gate,
    results: [{ ...bosRefusal.results![0]!, decidingValue: onChain('68207.30'), referenceValue: onChain('68412.50') }],
  };

  it('links to the gate transaction on its own chain\'s explorer', () => {
    expect(gateTxOf(gateRefusal)).toEqual({
      hash: TX,
      short: `0xcdcdcd…cdcd`,
      url: `https://testnet.monadscan.com/tx/${TX}`,
      explorer: 'Monadscan',
    });
    expect(gateTxOf({ gate: { ...gate, chainId: 143 } })?.url).toBe(`https://monadscan.com/tx/${TX}`);
    expect(gateTxOf(bosRefusal)).toBeNull();
  });

  it('is refused by the on-chain gate, with the block, the bucket and the chain\'s sample', () => {
    const r = refusalFromTrade(gateRefusal, RULE_04)!;
    expect(r).toMatchObject({
      label: 'REFUSED BY THE ON-CHAIN GATE',
      predicate: 'bos_bullish',
      block: 'BLOCK 48000123 · BUCKET 09-02 14:45 UTC',
      at: '2026-09-02 14:45:40 UTC',
      actualSub: 'CHAIN SAMPLE · BTC / USD · 15M',
      decided: 'chain',
      gate: { tx: { url: `https://testnet.monadscan.com/tx/${TX}` }, offchainVerdict: 'refused' },
    });
    expect(formatDecimal(r.requiredHigh!)).toBe('68,412.50000000');
    expect(formatDecimal(r.currentPrice!)).toBe('68,207.30000000');
    expect(r.shortfallBps).toBe(-30);
    expect(r.reason.toLowerCase()).not.toMatch(/sorry|error|failed|oops/);
  });

  it('says could not evaluate, and how many samples it needs, with no number shown as if one decided it', () => {
    const young: LiveTrade = {
      ...gateRefusal,
      failingValue: undefined as never,
      requiredValue: undefined as never,
      results: [],
      gate: { ...gate, decidingValue: '0', couldNotEvaluate: { predicateId: 'p1', needed: 21, recorded: 3 } },
    };
    const r = refusalFromTrade(young, RULE_04)!;
    expect(r).toMatchObject({ requiredHigh: null, currentPrice: null, shortfall: null, gate: { unevaluated: { needed: 21, recorded: 3 } } });
    expect(r.reason).toBe(
      'Could not evaluate: bos_bullish needs 21 consecutive 15m samples on the chain, and the series has 3. Until it has them, the gate refuses.',
    );
    expect(blockedRow(young, RULE_04)).toMatchObject({
      detail: 'could not evaluate · needs 21 consecutive 15m samples · has 3',
      decided: 'chain',
      tx: { short: '0xcdcdcd…cdcd' },
    });
  });

  it('shows only the chain\'s number when the replay did not reproduce the bar', () => {
    const r = refusalFromTrade({ ...gateRefusal, requiredValue: undefined as never }, RULE_04)!;
    expect(r.currentPrice).toEqual(onChain('68207.30'));
    expect(r.requiredHigh).toBeNull();
    expect(r.shortfall).toBeNull();
  });

  it("states the gate's own refusals in words: the rule's side, a retired rule", () => {
    const side = refusalFromTrade(
      { ...gateRefusal, failedPredicateId: undefined as never, failedSymbol: 'SIDE_MISMATCH', failingValue: undefined as never, requiredValue: undefined as never, gate: { ...gate, symbol: 'SIDE_MISMATCH', decidingValue: '1' } },
      RULE_04,
    )!;
    expect(side).toMatchObject({ predicate: 'SIDE_MISMATCH', reason: 'The rule takes longs only.', requiredHigh: null });
  });

  it('says so when the off-chain check would have passed it', () => {
    expect(refusalFromTrade({ ...gateRefusal, gate: { ...gate, offchainVerdict: 'proposed' } }, RULE_04)!.gate).toMatchObject({ offchainVerdict: 'proposed' });
  });

  it('puts the gate first in the evidence chain, and keeps each outcome with its own candle', () => {
    const d = tradeDetailFromTrade(gateRefusal, RULE_04);
    expect(d.claims.map((c) => c.symbol)).toEqual(['ON-CHAIN GATE', 'bos_bullish']);
    expect(d.claims[0]).toMatchObject({ badge: 'ON-CHAIN', tone: 'long', summary: 'REFUSED · BLOCK 48000123' });
    expect(d.claims[0]!.fields).toEqual([
      ['verdict', 'refused · bos_bullish · 6820730000000'],
      ['transaction', '0xcdcdcd…cdcd'],
      ['block', '48000123'],
      ['bucket', '2026-09-02 14:45:00 UTC · 900s'],
      ['signer', '0xe0072e…01b4'],
      ['gas limit', '317628'],
      ['off-chain said', 'refused too'],
      ['outcomes below', "replayed on the chain's candles"],
    ]);
    // The transaction is the gate's claim; the outcome keeps its candle, not the transaction.
    expect(d.claims[1]!.fields).toContainEqual(['evidence ref', 'pyth/btc-usd#900s@1788359400']);
    expect(d.gateTx?.url).toBe(`https://testnet.monadscan.com/tx/${TX}`);
  });

  it('a pass the gate decided carries its transaction to the proposal screen', () => {
    const pass: LiveTrade = { ...proposed, gate: { ...gate, verdict: 'proposed', symbol: undefined as never, decidingValue: undefined as never, previewDiffers: true } };
    expect(proposalFromTrade(pass, RULE_04, T)!.gateTx?.short).toBe('0xcdcdcd…cdcd');
    const claim = tradeDetailFromTrade(pass, RULE_04).claims[0]!;
    expect(claim.summary).toBe('PASSED · BLOCK 48000123');
    expect(claim.fields).toContainEqual(['off-chain said', 'refused']);
    expect(claim.fields).toContainEqual(['preview', 'said otherwise; the transaction decides']);
    expect(proposalFromTrade(proposed, RULE_04, T)!.gateTx).toBeUndefined();
  });
});
