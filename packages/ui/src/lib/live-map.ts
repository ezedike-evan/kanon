/**
 * Live rows -> the shapes screens render.
 *
 * Every function here is pure: rows in, display data out, with the clock passed
 * as an argument. That is what lets the refusal copy, the evidence chain and
 * the blocked-log arithmetic be pinned down in `live-map.test.ts` rather than
 * trusted on sight.
 *
 * Nothing invents a figure. A trade that has not closed has no result; a spec
 * with no target has no target; a market with no candles has no price. Where a
 * value is genuinely absent the mapping says so with `null`, and the screen
 * says so in words.
 */

import {
  COOLING_OFF_SECONDS,
  PREDICATE_LABEL,
  abbreviateHash,
  adherenceBps,
  assetLabel,
  formatBps,
  formatDecimal,
  formatPredicateDelta,
  formatPredicateValue,
  parseSpec,
  planAmendment,
  predicateComparison,
  predicateHeadlines,
  referenceLabel,
  reviewSpec,
  roundedBps,
  shareSummary,
  specLines,
  subDecimal,
  timeframeLabel,
  truncateDecimal,
  type Candle,
  type Decimal,
  type Predicate,
  type PredicateKind,
  type StrategySpec,
} from '@kanon/spec';
import type {
  BlockedLogData,
  BlockedRow,
  Claim,
  CompilerData,
  CoolingOffData,
  EvidenceField,
  HomeStats,
  PinningData,
  ProposalData,
  RefusalData,
  ReviewData,
  RuleData,
  ShareCardData,
  TradeDetailData,
  TranscriptTurn,
} from './data';
import type { AmendmentPreview, PinAvailability, ReviewMode } from './flow-types';
import type { PinTargetResult } from './pin';

// ---------------------------------------------------------------------------
// Row shapes: what a Convex document looks like once it crosses the wire.
// ---------------------------------------------------------------------------

export interface LiveStrategy {
  _id: string;
  _creationTime: number;
  status: 'draft' | 'pinned' | 'cooling_off';
  spec?: unknown;
  pendingSpec?: unknown;
  specHash: string;
  pinnedAt?: number;
  bondAtoms?: Decimal;
  cooldownEndsAt?: number;
  chainId?: number;
  registryAddress?: string;
  chainStrategyId?: string;
  pinTxHash?: string;
  /** What is active on-chain next to the spec hash. */
  predicatesCommitment?: string;
  seriesAddress?: string;
}

export interface LiveOutcome {
  predicateId: string;
  kind: string;
  symbol: string;
  satisfied: boolean;
  decidingValue: Decimal;
  referenceValue: Decimal;
  at: number;
}

export interface LiveTrade {
  _id: string;
  strategyId: string;
  direction: 'long' | 'short';
  asset: string;
  entry: Decimal;
  size: Decimal;
  stop: Decimal;
  status: 'proposed' | 'executed' | 'refused' | 'undone';
  satisfiedPredicateIds: string[];
  failedPredicateId?: string;
  failedSymbol?: string;
  failingValue?: Decimal;
  requiredValue?: Decimal;
  evidenceRefs: string[];
  createdAt: number;
  results?: LiveOutcome[];
  scan?: { from: number; to: number; asOf: number };
  equity?: Decimal;
  equitySource?: 'account' | 'paper';
  riskBps?: number;
  undoExpiresAt?: number;
  feed?: string;
  specHash?: string;
  executedAt?: number;
}

/** What `blockedReport` returns per refusal. */
export type LiveModelled =
  | { status: 'pending' }
  | { status: 'stopped' | 'open'; exit: Decimal; pnl: Decimal; lost: boolean; at: number };

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `2026-09-02 14:32:07 UTC`. */
export function utcFull(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** `09-02 14:32`, the blocked-log row form. */
export function utcShort(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** `14:32:07 UTC` from unix seconds. */
export function utcTime(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(11, 19)} UTC`;
}

// ---------------------------------------------------------------------------
// Picking the rows a screen is about
// ---------------------------------------------------------------------------

export interface PickedStrategies {
  /** The most recently created pinned or cooling-off strategy. */
  active: LiveStrategy | undefined;
  /** The most recently created draft. */
  draft: LiveStrategy | undefined;
  /** `RULE 04`: the strategy's position among the owner's, oldest first. */
  ordinalOf(id: string | undefined): string;
  /** What the next strategy would be called. */
  nextOrdinal: string;
}

export function pickStrategies(list: readonly LiveStrategy[] | undefined): PickedStrategies {
  const sorted = [...(list ?? [])].sort((a, b) => a._creationTime - b._creationTime);
  const last = (pred: (s: LiveStrategy) => boolean) => {
    for (let i = sorted.length - 1; i >= 0; i--) if (pred(sorted[i]!)) return sorted[i];
    return undefined;
  };
  const ordinal = (n: number) => `RULE ${pad2(n)}`;
  return {
    active: last((s) => s.status === 'pinned' || s.status === 'cooling_off'),
    draft: last((s) => s.status === 'draft'),
    ordinalOf(id) {
      const i = sorted.findIndex((s) => s._id === id);
      return i === -1 ? ordinal(sorted.length + 1) : ordinal(i + 1);
    },
    nextOrdinal: ordinal(sorted.length + 1),
  };
}

/** A stored spec, or null. A row that does not parse is never rendered as if it did. */
export function safeSpec(raw: unknown): StrategySpec | null {
  if (raw === undefined || raw === null) return null;
  try {
    return parseSpec(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

export function ruleFromStrategy(input: {
  strategy: LiveStrategy;
  spec: StrategySpec;
  ordinal: string;
}): RuleData {
  const { strategy, spec, ordinal } = input;
  const pinnedOn = strategy.pinnedAt
    ? `PINNED ${utcShort(strategy.pinnedAt).slice(0, 5)}`
    : 'NOT PINNED';
  return {
    ordinal,
    id: strategy._id,
    name: spec.name,
    asset: assetLabel(spec),
    timeframe: timeframeLabel(spec),
    pinnedOn,
    specHash: abbreviateHash(strategy.specHash, 10, 8),
    txAbbrev: abbreviateHash(strategy.pinTxHash ?? strategy.specHash),
    contract: strategy.registryAddress ? abbreviateHash(strategy.registryAddress, 4, 4) : 'NOT DEPLOYED',
    predicates: predicateHeadlines(spec),
    bucketSeconds: spec.series.bucketSeconds,
    symbol: spec.series.asset,
  };
}

/** A signed-in user with nothing pinned. It carries no figures a screen could mistake for theirs. */
export function emptyRule(ordinal: string): RuleData {
  return {
    ordinal,
    id: 'none',
    name: 'NO RULE PINNED',
    asset: 'BTC / USD',
    timeframe: '15M',
    pinnedOn: 'NOT PINNED',
    specHash: '',
    txAbbrev: '',
    contract: 'NOT DEPLOYED',
    predicates: [],
    bucketSeconds: 900,
    symbol: 'BTC/USD',
  };
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export function countTrades(trades: readonly LiveTrade[] | undefined): {
  taken: number;
  blocked: number;
} {
  const list = trades ?? [];
  return {
    taken: list.filter((t) => t.status === 'executed').length,
    blocked: list.filter((t) => t.status === 'refused').length,
  };
}

/** No P&L figure exists until a trade has closed, so this is zero, honestly, until then. */
const ZERO_USD: Decimal = { atoms: '0', decimals: 2 };

export function homeFromTrades(
  trades: readonly LiveTrade[] | undefined,
  price: Pick<HomeStats, 'price' | 'changeBps' | 'sparkline' | 'sparklineHead'>,
): HomeStats {
  const { taken, blocked } = countTrades(trades);
  return {
    taken,
    blocked,
    adherenceBps: adherenceBps(taken, blocked) ?? 0,
    attempts: taken + blocked,
    pnl30d: ZERO_USD,
    ...price,
  };
}

export const NO_PRICE: Pick<HomeStats, 'price' | 'changeBps' | 'sparkline' | 'sparklineHead'> = {
  price: { atoms: '0', decimals: 2 },
  changeBps: 0,
  sparkline: [],
  sparklineHead: 2,
};

/**
 * The price line under the rule: the latest close, its move over the candles
 * given, and a small monochrome bar series. Heights are integers 20..100,
 * min-max scaled over the window with no floats.
 */
export function priceLine(
  candles: readonly Candle[],
  bars = 18,
): Pick<HomeStats, 'price' | 'changeBps' | 'sparkline' | 'sparklineHead'> {
  const last = candles[candles.length - 1];
  const first = candles[0];
  if (!last || !first) return NO_PRICE;

  const window = candles.slice(-bars);
  const scale = Math.max(...window.map((c) => c.close.decimals));
  const atoms = window.map((c) => BigInt(c.close.atoms) * 10n ** BigInt(scale - c.close.decimals));
  const lo = atoms.reduce((m, v) => (v < m ? v : m));
  const hi = atoms.reduce((m, v) => (v > m ? v : m));
  const span = hi - lo;
  const sparkline = atoms.map((v) => (span === 0n ? 60 : 20 + Number(((v - lo) * 80n) / span)));

  return {
    price: last.close,
    changeBps: roundedBps(subDecimal(last.close, first.close), first.close),
    sparkline,
    sparklineHead: 2,
  };
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

const PRICE_UNIT = (kind: string): 'price' | 'bps' => (kind === 'fair_value_gap' ? 'bps' : 'price');

function findPredicate(spec: StrategySpec, id: string | undefined): Predicate | undefined {
  return spec.predicates.find((p) => p.id === id);
}

interface RefusalCopy {
  reason: string;
  requiredLabel: string;
  requiredSub: string;
  actualLabel: string;
  actualSub: string;
}

/** The sentence and labels a refusal is read in, per predicate. SMC language, no apology. */
export function refusalCopy(p: Predicate, required: Decimal, asset: string, timeframe: string): RefusalCopy {
  const long = p.direction === 'long';
  switch (p.kind) {
    case 'break_of_structure':
      return {
        reason: long
          ? 'Bullish break of structure not confirmed. Entry requires a closed candle above the prior swing high.'
          : 'Bearish break of structure not confirmed. Entry requires a closed candle below the prior swing low.',
        requiredLabel: long ? 'REQUIRED HIGH' : 'REQUIRED LOW',
        requiredSub: 'PRIOR SWING',
        actualLabel: 'LAST CLOSE',
        actualSub: `${asset} · ${timeframe}`,
      };
    case 'fair_value_gap':
      return {
        reason: `Fair value gap too small. Entry requires a three-candle imbalance of at least ${formatBps(Number(required.atoms))}.`,
        requiredLabel: 'REQUIRED GAP',
        requiredSub: 'MINIMUM',
        actualLabel: 'MEASURED GAP',
        actualSub: `${asset} · ${timeframe}`,
      };
    case 'liquidity_sweep':
      return {
        reason: `Liquidity sweep not confirmed. Entry requires a wick ${long ? 'below' : 'above'} the ${referenceLabel(p.referenceExtreme.value)} that closes back inside.`,
        requiredLabel: long ? 'REFERENCE LOW' : 'REFERENCE HIGH',
        requiredSub: referenceLabel(p.referenceExtreme.value).toUpperCase(),
        actualLabel: long ? 'WICK LOW' : 'WICK HIGH',
        actualSub: `${asset} · ${timeframe}`,
      };
  }
}

export function refusalFromTrade(trade: LiveTrade, spec: StrategySpec): RefusalData | null {
  if (trade.status !== 'refused' || !trade.failingValue || !trade.requiredValue) return null;
  const p = findPredicate(spec, trade.failedPredicateId);
  if (!p) return null;

  const unit = PRICE_UNIT(p.kind);
  const shortfall = subDecimal(trade.failingValue, trade.requiredValue);
  const shortfallBps =
    unit === 'bps' ? Number(shortfall.atoms) : roundedBps(shortfall, trade.requiredValue);
  const copy = refusalCopy(p, trade.requiredValue, assetLabel(spec), timeframeLabel(spec));

  return {
    predicate: trade.failedSymbol ?? p.id,
    reason: copy.reason,
    requiredHigh: trade.requiredValue,
    currentPrice: trade.failingValue,
    shortfall,
    shortfallBps,
    at: utcFull(trade.createdAt),
    block: trade.feed ? `${trade.feed} · ${spec.series.bucketSeconds}s` : `${spec.series.bucketSeconds}s`,
    label: 'REFUSED BY YOUR PINNED RULE',
    unit,
    requiredLabel: copy.requiredLabel,
    requiredSub: copy.requiredSub,
    actualLabel: copy.actualLabel,
    actualSub: copy.actualSub,
    tradeId: trade._id,
  };
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export function proposalFromTrade(
  trade: LiveTrade,
  spec: StrategySpec,
  nowMs: number,
): ProposalData | null {
  if (trade.status === 'refused') return null;
  const checks = (trade.results ?? []).map((r) => {
    const p = findPredicate(spec, r.predicateId);
    const kind = (p?.kind ?? r.kind) as PredicateKind;
    return {
      label: PREDICATE_LABEL[kind] ?? r.symbol,
      evidence: p
        ? predicateComparison(p, r.decidingValue, r.referenceValue, r.satisfied)
        : `${formatPredicateValue(kind, r.decidingValue)} · ${formatPredicateValue(kind, r.referenceValue)}`,
    };
  });
  const left =
    trade.status === 'proposed' && trade.undoExpiresAt !== undefined
      ? Math.max(0, Math.ceil((trade.undoExpiresAt - nowMs) / 1000))
      : 0;

  return {
    entry: trade.entry,
    stop: trade.stop,
    // The spec pins no target. A target the user never wrote would be a hidden parameter.
    target: null,
    size: trade.size,
    riskBps: trade.riskBps ?? spec.risk.riskPerTradeBps.value,
    undoSeconds: left,
    ...(trade.status === 'proposed' && trade.undoExpiresAt !== undefined
      ? { undoExpiresAt: trade.undoExpiresAt }
      : {}),
    checks,
    tradeId: trade._id,
    status: trade.status === 'proposed' ? 'proposed' : trade.status === 'undone' ? 'undone' : 'executed',
    direction: trade.direction,
    sizeUnit: (trade.asset.split('/')[0] ?? trade.asset).toUpperCase(),
    sizing:
      trade.equity && trade.equitySource
        ? `${formatDecimal(trade.equity)} ${trade.equitySource === 'paper' ? 'PAPER EQUITY' : 'ACCOUNT EQUITY'}`
        : 'ACCOUNT EQUITY',
  };
}

// ---------------------------------------------------------------------------
// Trade detail: the evidence chain
// ---------------------------------------------------------------------------

const EVIDENCE_LABELS: Record<PredicateKind, [string, string]> = {
  break_of_structure: ['close', 'prior swing extreme'],
  fair_value_gap: ['measured gap', 'minimum gap'],
  liquidity_sweep: ['wick', 'reference extreme'],
};

const STATUS_LABEL: Record<LiveTrade['status'], string> = {
  proposed: 'PROPOSED',
  executed: 'EXECUTED',
  refused: 'REFUSED',
  undone: 'UNDONE',
};

export function tradeDetailFromTrade(trade: LiveTrade, spec: StrategySpec): TradeDetailData {
  const claims: Claim[] = (trade.results ?? []).map((r, i) => {
    const p = findPredicate(spec, r.predicateId);
    const kind = (p?.kind ?? r.kind) as PredicateKind;
    const [decidingLabel, referenceLabel_] = EVIDENCE_LABELS[kind] ?? ['value', 'threshold'];
    const ref = trade.evidenceRefs[i];
    const fields: EvidenceField[] = [
      [decidingLabel, formatPredicateValue(kind, r.decidingValue)],
      [referenceLabel_, formatPredicateValue(kind, r.referenceValue)],
      ['candle', utcFull(r.at * 1000)],
      ['series', `${trade.feed ?? spec.series.feed} · ${spec.series.bucketSeconds}s`],
    ];
    if (p) fields.push(['comparison', predicateComparison(p, r.decidingValue, r.referenceValue, r.satisfied)]);
    // The window the evaluation was allowed to decide in. Recorded on the row, so it is shown, not assumed.
    if (trade.scan) fields.push(['scan window', `${utcTime(trade.scan.from)} to ${utcTime(trade.scan.to)}`]);
    if (ref) fields.push(['evidence ref', ref]);
    return {
      symbol: r.symbol,
      summary: `${utcTime(r.at)} \u00B7 ${formatPredicateValue(kind, r.decidingValue)}`,
      fields,
      // Candles on the canonical series, not a signed attestation: say what it is.
      badge: r.satisfied ? 'MET' : 'NOT MET',
      tone: r.satisfied ? 'long' : 'ash',
    };
  });

  return {
    id: trade._id,
    side: `${trade.direction.toUpperCase()} · ${STATUS_LABEL[trade.status]}`,
    result: null,
    entry: trade.entry,
    exit: null,
    returnBps: null,
    claims,
  };
}

/** `d`'s atoms at exactly `decimals` places, truncating toward zero when it has more. */
function atomsAt(d: Decimal, decimals: number): bigint {
  const atoms = BigInt(d.atoms);
  return d.decimals <= decimals
    ? atoms * 10n ** BigInt(decimals - d.decimals)
    : atoms / 10n ** BigInt(d.decimals - decimals);
}

// ---------------------------------------------------------------------------
// Blocked log
// ---------------------------------------------------------------------------

export function blockedRow(trade: LiveTrade, spec: StrategySpec): BlockedRow {
  const failing = (trade.results ?? []).find((r) => r.predicateId === trade.failedPredicateId);
  const kind = (findPredicate(spec, trade.failedPredicateId)?.kind ?? failing?.kind ?? 'break_of_structure') as PredicateKind;
  const req = trade.requiredValue;
  const got = trade.failingValue;
  const detail =
    req && got
      ? `req ${formatPredicateValue(kind, req)} · got ${formatPredicateValue(kind, got)} · ${formatPredicateDelta(kind, subDecimal(got, req))}`
      : '';
  return {
    symbol: trade.failedSymbol ?? trade.failedPredicateId ?? 'unknown',
    at: utcShort(trade.createdAt),
    detail,
    tradeId: trade._id,
  };
}

export function blockedLogFromTrades(input: {
  trades: readonly LiveTrade[] | undefined;
  spec: StrategySpec | null;
  report: Record<string, LiveModelled> | undefined;
  now: number;
}): BlockedLogData {
  const { spec, report, now } = input;
  const refused = (input.trades ?? [])
    .filter((t) => t.status === 'refused')
    .sort((a, b) => b.createdAt - a.createdAt);
  const d = new Date(now);
  const period = `${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;

  const rows = spec ? refused.map((t) => blockedRow(t, spec)) : [];

  let judged = 0;
  let pending = 0;
  let lost = 0;
  let total = 0n;
  for (const t of refused) {
    const o = report?.[t._id];
    if (!o || o.status === 'pending') {
      pending += 1;
      continue;
    }
    judged += 1;
    if (o.lost) {
      lost += 1;
      total += atomsAt(o.pnl, 2);
    }
  }

  const loading = report === undefined && refused.length > 0;
  const note =
    refused.length === 0
      ? 'Nothing has been refused yet. Every setup so far satisfied the rule.'
      : judged === 0
        ? 'Waiting on price data printed after each refusal. Modelled to each setup’s own stop.'
        : `Modelled to each setup’s own stop. ${lost} of ${judged} would have closed at a loss${pending > 0 ? `. ${pending} awaiting later prices` : ''}.`;

  return {
    period: `${period} ▾`,
    refused: refused.length,
    wouldHaveLost: { atoms: total.toString(), decimals: 2 },
    note,
    rows,
    loading,
  };
}

// ---------------------------------------------------------------------------
// Cooling-off
// ---------------------------------------------------------------------------

export function coolingOffFromStrategy(strategy: LiveStrategy | undefined, nowMs: number): CoolingOffData | null {
  if (!strategy || strategy.status !== 'cooling_off' || strategy.cooldownEndsAt === undefined) return null;
  const current = safeSpec(strategy.spec);
  const pending = safeSpec(strategy.pendingSpec);
  if (!current || !pending) return null;
  const holdSeconds = COOLING_OFF_SECONDS;
  const requestedAt = strategy.cooldownEndsAt - holdSeconds * 1000;
  return {
    requestedAt,
    nowAt: nowMs,
    requestedLabel: `REQUESTED ${utcShort(requestedAt)} UTC · ${Math.round(holdSeconds / 3600)}H HOLD`,
    currentSpec: current,
    pendingSpec: pending,
    holdSeconds,
    endsAt: strategy.cooldownEndsAt,
  };
}

// ---------------------------------------------------------------------------
// Strategy card
// ---------------------------------------------------------------------------

export function shareCardFromStrategy(input: {
  strategy: LiveStrategy;
  spec: StrategySpec;
  trades: readonly LiveTrade[] | undefined;
  now: number;
}): ShareCardData {
  const { strategy, spec, trades, now } = input;
  const { taken, blocked } = countTrades(trades);
  const days = strategy.pinnedAt ? Math.floor((now - strategy.pinnedAt) / 86_400_000) : 0;
  return {
    window: days <= 0 ? 'PINNED TODAY' : `PINNED ${days}D`,
    summary: shareSummary(spec),
    adherenceBps: adherenceBps(taken, blocked) ?? 0,
    // Nothing has closed, so nothing is verified. A card that showed a return would be self-reported.
    verifiedPnlBps: null,
    taken,
    blocked,
    // There is no override path, so this is zero by construction, not by measurement.
    overrides: 0,
    url: `kanon.xyz/v/${strategy.specHash.slice(2, 10)}`,
    disclaimer:
      'Anyone can verify the spec hash against the registry. Nothing here is self-reported.',
    specHash: strategy.specHash,
  };
}

// ---------------------------------------------------------------------------
// Compiler, review, pinning
// ---------------------------------------------------------------------------

export function clockLabel(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function turn(from: 'KANON' | 'YOU', text: string, ms: number): TranscriptTurn {
  return { from, at: clockLabel(ms), text };
}

export function compilerData(input: {
  ordinal: string;
  transcript: TranscriptTurn[];
  spec: StrategySpec | null;
  previous: StrategySpec | null;
  status: CompilerData['status'];
  error?: string | undefined;
}): CompilerData {
  const base: CompilerData = {
    draft: `DRAFT · ${input.ordinal}`,
    transcript: input.transcript,
    lines: input.spec ? specLines(input.spec, input.previous) : [],
    status: input.status,
    hasSpec: input.spec !== null,
  };
  return input.error ? { ...base, error: input.error } : base;
}

export function reviewData(input: {
  spec: StrategySpec | null;
  /** In amend mode, the pinned spec the staged one is compared against. */
  baseline: StrategySpec | null;
  mode: ReviewMode;
  acknowledged: boolean;
  busy: boolean;
  error?: string | undefined;
}): ReviewData {
  const { spec, baseline } = input;
  const review = spec ? reviewSpec(spec) : { plain: [], parametric: [], inferred: [], params: [] };
  let preview: AmendmentPreview | null = null;
  if (input.mode === 'amend' && spec && baseline) {
    const plan = planAmendment(baseline, spec);
    preview =
      plan.kind === 'none'
        ? { kind: 'none', changes: [], cooldownSeconds: 0 }
        : {
            kind: plan.kind,
            changes: plan.diff.changes,
            cooldownSeconds: plan.kind === 'cooling_off' ? plan.cooldownSeconds : 0,
          };
  }
  const data: ReviewData = {
    plain: review.plain,
    parametric: review.parametric,
    inferred: review.inferred.map((i) => ({ name: i.name, value: i.value, key: i.key })),
    mode: input.mode,
    params: review.params,
    acknowledged: input.acknowledged,
    preview,
    busy: input.busy,
  };
  return input.error ? { ...data, error: input.error } : data;
}

/**
 * A registry and a wallet are not enough to pin a particular rule: it also needs a
 * deployed series for its asset and cadence, and predicates the gate can encode.
 * Where either is missing the ceremony says "not deployed" up front, in the
 * builder's own words, instead of failing at the sign button.
 */
export function pinAvailabilityFor(
  base: PinAvailability,
  target: PinTargetResult | null,
): PinAvailability {
  if (base.state !== 'ready' || target === null || target.ok) return base;
  return { state: 'not_deployed', message: target.message };
}

export function pinningData(input: {
  specHash: string;
  /** The result of `buildPinTarget` for the draft, or null before it has been worked out. */
  target?: PinTargetResult | null;
  contract: string | undefined;
  minBond: Decimal | null;
  nativeSymbol: string;
  availability: PinAvailability;
  busy: boolean;
}): PinningData {
  return {
    step: 'STEP 3 / 3',
    // The registry's own minimum, read from it. Until it has been read there is no bond to show.
    bond: input.minBond ? truncateDecimal(input.minBond, 4) : { atoms: '0', decimals: 4 },
    bondUnit: input.nativeSymbol,
    agreements: [
      'This rule will be enforced on every trade. Kanon will refuse setups that fail it.',
      'Tightening the rule takes effect immediately.',
      `Loosening it requires a ${Math.round(COOLING_OFF_SECONDS / 3600)}-hour cooling-off period before it applies.`,
    ],
    specHash: input.specHash ? abbreviateHash(input.specHash, 10, 8) : '',
    contract: input.contract ? abbreviateHash(input.contract, 4, 4) : 'NOT DEPLOYED',
    ...(input.target?.ok
      ? {
          commitment: abbreviateHash(input.target.target.predicatesCommitment, 10, 8),
          series: abbreviateHash(input.target.target.series, 4, 4),
        }
      : input.target
        ? { commitment: '', series: 'NOT DEPLOYED' }
        : {}),
    availability: pinAvailabilityFor(input.availability, input.target ?? null),
    busy: input.busy,
  };
}
