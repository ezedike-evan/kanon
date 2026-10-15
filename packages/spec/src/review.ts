/**
 * Spec review, as data.
 *
 * Everything the review screen, the compiler's live diff and the strategy card
 * show about a spec is derived here, from the spec alone. Nothing is stored
 * separately, so what the user reads cannot drift from what gets hashed and
 * pinned.
 *
 * "No hidden parameters": every value the compiler chose is listed in
 * `inferred`, and every bound parameter is in `params` with the bounds it can
 * be edited within. `applyParamEdit` is how a user overrules one; the edited
 * value becomes stated (`inferred: false`) because the user now said it.
 */

import type { Decimal } from './decimal';
import { formatBps, formatDecimal } from './decimal';
import { parseSpec, predicateSymbol } from './spec';
import type { Predicate, PredicateKind, StrategySpec, Timeframe } from './spec';

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
const LOOKBACKS = ['15m', '1h', '4h', '1D', '1W'] as const;
const LOW_REFERENCES = ['prev_day_low', 'prev_session_low', 'swing_low'] as const;
const HIGH_REFERENCES = ['prev_day_high', 'prev_session_high', 'swing_high'] as const;

const REFERENCE_LABEL: Record<string, string> = {
  prev_day_low: "previous day's low",
  prev_day_high: "previous day's high",
  prev_session_low: "previous session's low",
  prev_session_high: "previous session's high",
  swing_low: 'swing low',
  swing_high: 'swing high',
};

/** A sentence fragment: literal text, or a bound parameter the user can edit. */
export type ReviewSegment = string | { param: string; key: string };

export type ParamKind = 'int' | 'enum';

export interface EditableParam {
  /** `<predicateId>.<field>` or `risk.<field>`. Stable across edits. */
  key: string;
  /** The name it carries in the parametric view. */
  name: string;
  /** Which predicate it belongs to, as its symbol, or `risk`. */
  owner: string;
  kind: ParamKind;
  value: string | number;
  /** How the value is written in the review, e.g. `0.15%`, `5 candles`. */
  display: string;
  inferred: boolean;
  /** Integer bounds, for `int`. */
  min?: number;
  max?: number;
  /** Allowed values, for `enum`. */
  options?: string[];
  /** For `int` parameters held in basis points: the edit box speaks percent. */
  unit: 'candles' | 'bps' | null;
  /**
   * The spec has no value here at all: a target on a rule written before
   * targets existed. `value` is empty and `display` says `not stated`; an edit
   * creates the parameter, stated.
   */
  missing?: boolean;
}

export interface InferredEntry {
  name: string;
  key: string;
  value: string;
}

export interface SpecReview {
  plain: ReviewSegment[][];
  parametric: string[];
  inferred: InferredEntry[];
  params: EditableParam[];
}

// ---------------------------------------------------------------------------
// Parameter table. One place that knows every bound parameter of a spec.
// ---------------------------------------------------------------------------

interface ParamSlot {
  key: string;
  name: string;
  owner: string;
  kind: ParamKind;
  value: string | number;
  inferred: boolean;
  display: string;
  min?: number;
  max?: number;
  options?: string[];
  unit: 'candles' | 'bps' | null;
  missing?: boolean;
}

function tfSlot(p: Predicate): ParamSlot {
  return {
    key: `${p.id}.timeframe`,
    name: 'timeframe',
    owner: predicateSymbol(p),
    kind: 'enum',
    value: p.timeframe.value,
    inferred: p.timeframe.inferred,
    display: p.timeframe.value,
    options: [...TIMEFRAMES],
    unit: null,
  };
}

function slotsOf(spec: StrategySpec): ParamSlot[] {
  const out: ParamSlot[] = [];
  for (const p of spec.predicates) {
    const owner = predicateSymbol(p);
    switch (p.kind) {
      case 'break_of_structure':
        out.push({
          key: `${p.id}.swingLookbackCandles`,
          name: 'swing_lookback',
          owner,
          kind: 'int',
          value: p.swingLookbackCandles.value,
          inferred: p.swingLookbackCandles.inferred,
          display: `${p.swingLookbackCandles.value} candles`,
          min: 2,
          max: 200,
          unit: 'candles',
        });
        out.push(tfSlot(p));
        break;
      case 'fair_value_gap':
        out.push({
          key: `${p.id}.minGapBps`,
          name: 'min_gap_size',
          owner,
          kind: 'int',
          value: p.minGapBps.value,
          inferred: p.minGapBps.inferred,
          display: formatBps(p.minGapBps.value),
          min: 1,
          max: 10_000,
          unit: 'bps',
        });
        out.push(tfSlot(p));
        break;
      case 'liquidity_sweep':
        out.push({
          key: `${p.id}.referenceExtreme`,
          name: 'reference_extreme',
          owner,
          kind: 'enum',
          value: p.referenceExtreme.value,
          inferred: p.referenceExtreme.inferred,
          display: REFERENCE_LABEL[p.referenceExtreme.value] ?? p.referenceExtreme.value,
          options: [...(p.direction === 'long' ? LOW_REFERENCES : HIGH_REFERENCES)],
          unit: null,
        });
        out.push({
          key: `${p.id}.lookback`,
          name: 'sweep_lookback',
          owner,
          kind: 'enum',
          value: p.lookback.value,
          inferred: p.lookback.inferred,
          display: p.lookback.value,
          options: [...LOOKBACKS],
          unit: null,
        });
        out.push(tfSlot(p));
        break;
    }
  }
  out.push({
    key: 'risk.riskPerTradeBps',
    name: 'risk_per_trade',
    owner: 'risk',
    kind: 'int',
    value: spec.risk.riskPerTradeBps.value,
    inferred: spec.risk.riskPerTradeBps.inferred,
    display: formatBps(spec.risk.riskPerTradeBps.value),
    min: 1,
    max: 10_000,
    unit: 'bps',
  });
  out.push({
    key: 'risk.stopDistanceBps',
    name: 'stop_distance',
    owner: 'risk',
    kind: 'int',
    value: spec.risk.stopDistanceBps.value,
    inferred: spec.risk.stopDistanceBps.inferred,
    display: formatBps(spec.risk.stopDistanceBps.value),
    min: 1,
    max: 10_000,
    unit: 'bps',
  });
  // Always a slot, even where the spec has none: a missing target is shown, never skipped.
  const target = spec.risk.targetDistanceBps;
  out.push({
    key: 'risk.targetDistanceBps',
    name: 'target_distance',
    owner: 'risk',
    kind: 'int',
    value: target ? target.value : '',
    inferred: target ? target.inferred : false,
    display: target ? formatBps(target.value) : 'not stated',
    min: 1,
    max: 10_000,
    unit: 'bps',
    ...(target ? {} : { missing: true }),
  });
  return out;
}

export function editableParams(spec: StrategySpec): EditableParam[] {
  return slotsOf(spec).map((s) => ({ ...s }));
}

/** Where the compiler chose the value rather than reading it. Never silent. */
export function inferredEntries(spec: StrategySpec): InferredEntry[] {
  return slotsOf(spec)
    .filter((s) => s.inferred)
    .map((s) => ({
      name: s.owner === 'risk' ? s.name : `${s.owner}.${s.name}`,
      key: s.key,
      value: s.display,
    }));
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export type EditResult = { ok: true; spec: StrategySpec } | { ok: false; error: string };

/**
 * Overrules one parameter. The result is re-validated as a whole spec, and the
 * edited parameter is marked stated: the user said it, so it is no longer an
 * inferred default.
 */
export function applyParamEdit(
  spec: StrategySpec,
  key: string,
  raw: string | number,
): EditResult {
  const slot = slotsOf(spec).find((s) => s.key === key);
  if (!slot) return { ok: false, error: `unknown parameter ${key}` };

  let value: string | number;
  if (slot.kind === 'int') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n)) return { ok: false, error: `${slot.name} must be a whole number` };
    if (n < (slot.min ?? -Infinity) || n > (slot.max ?? Infinity)) {
      return { ok: false, error: `${slot.name} must be between ${slot.min} and ${slot.max}` };
    }
    value = n;
  } else {
    const s = String(raw);
    if (!slot.options?.includes(s)) {
      return { ok: false, error: `${slot.name} must be one of ${slot.options?.join(', ')}` };
    }
    value = s;
  }

  const next = structuredClone(spec) as StrategySpec;
  const [owner, field] = key.split('.') as [string, string];
  const target: Record<string, { value: unknown; inferred: boolean }> | undefined =
    owner === 'risk'
      ? (next.risk as unknown as Record<string, { value: unknown; inferred: boolean }>)
      : (next.predicates.find((p) => p.id === owner) as unknown as
          | Record<string, { value: unknown; inferred: boolean }>
          | undefined);
  const param = target?.[field];
  if (param) {
    param.value = value;
    param.inferred = false;
  } else if (slot.missing && target) {
    // A target on a rule written before targets existed: the user is stating it for the first time.
    target[field] = { value, inferred: false };
  } else {
    return { ok: false, error: `unknown parameter ${key}` };
  }

  try {
    return { ok: true, spec: parseSpec(next) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid spec' };
  }
}

// ---------------------------------------------------------------------------
// The two registers
// ---------------------------------------------------------------------------

function chip(slot: ParamSlot | undefined): ReviewSegment {
  // A missing slot would mean a predicate the table does not know: show nothing
  // editable rather than crash the review.
  return slot ? { param: slot.display, key: slot.key } : '';
}

function riskSentence(slots: Map<string, ParamSlot>): ReviewSegment[] {
  const target = slots.get('risk.targetDistanceBps');
  return [
    'Risk no more than ',
    chip(slots.get('risk.riskPerTradeBps')),
    ' of the account on a trade, with the stop ',
    chip(slots.get('risk.stopDistanceBps')),
    ' from entry and the target ',
    chip(target),
    target?.missing ? '.' : ' from entry.',
  ];
}

/** One sentence per predicate, in SMC language, with bound parameters as chips. */
export function reviewSpec(spec: StrategySpec): SpecReview {
  const slots = new Map(slotsOf(spec).map((s) => [s.key, s]));
  const plain: ReviewSegment[][] = [];

  for (const p of spec.predicates) {
    const long = p.direction === 'long';
    switch (p.kind) {
      case 'break_of_structure':
        plain.push([
          long
            ? 'Enter long only after price closes above the prior swing high, measured over a lookback of '
            : 'Enter short only after price closes below the prior swing low, measured over a lookback of ',
          chip(slots.get(`${p.id}.swingLookbackCandles`)),
          ' on the ',
          chip(slots.get(`${p.id}.timeframe`)),
          ' timeframe.',
        ]);
        break;
      case 'fair_value_gap':
        plain.push([
          long
            ? 'A bullish three-candle fair value gap must be present, no smaller than '
            : 'A bearish three-candle fair value gap must be present, no smaller than ',
          chip(slots.get(`${p.id}.minGapBps`)),
          ' of price, on the ',
          chip(slots.get(`${p.id}.timeframe`)),
          ' timeframe.',
        ]);
        break;
      case 'liquidity_sweep':
        plain.push([
          long
            ? 'Liquidity must be swept below the '
            : 'Liquidity must be swept above the ',
          chip(slots.get(`${p.id}.referenceExtreme`)),
          ', a wick through it that closes back inside, within a ',
          chip(slots.get(`${p.id}.lookback`)),
          ' lookback on the ',
          chip(slots.get(`${p.id}.timeframe`)),
          ' timeframe.',
        ]);
        break;
    }
  }
  plain.push(riskSentence(slots));

  return {
    plain,
    parametric: parametricLines(spec),
    inferred: inferredEntries(spec),
    params: editableParams(spec),
  };
}

const RENDER_ORDER: Record<string, string[]> = {
  break_of_structure: ['swing_lookback', 'timeframe'],
  fair_value_gap: ['min_gap_size', 'timeframe'],
  liquidity_sweep: ['reference_extreme', 'sweep_lookback', 'timeframe'],
};

/**
 * `key: value` lines, the register a rule is written in when it is exact. The
 * pinned series is the first line: a spec is meaningless without it.
 */
export function parametricLines(spec: StrategySpec): string[] {
  const slots = slotsOf(spec);
  const lines: string[] = [
    `series: ${spec.series.asset} · ${spec.series.feed}`,
    `series_cadence: ${spec.series.cadenceSeconds}s`,
    `series_bucket: ${spec.series.bucketSeconds}s`,
    `direction: ${spec.direction}`,
  ];
  for (const p of spec.predicates) {
    lines.push(`require: ${predicateSymbol(p)}`);
    const owned = slots.filter((s) => s.key.startsWith(`${p.id}.`));
    const order = RENDER_ORDER[p.kind] ?? [];
    for (const name of order) {
      const s = owned.find((o) => o.name === name);
      if (!s) continue;
      const shown = s.unit === 'candles' ? String(s.value) : s.display;
      lines.push(`${s.name}: ${shown}`);
    }
  }
  const risk = slots.filter((s) => s.owner === 'risk');
  for (const s of risk) lines.push(`${s.name}: ${s.display}`);
  return lines;
}

/** The compiler's live spec panel: lines, and which ones this turn changed. */
export function specLines(
  spec: StrategySpec,
  previous?: StrategySpec | null,
): Array<{ text: string; changed: boolean }> {
  const now = parametricLines(spec);
  if (!previous) return now.map((text) => ({ text, changed: false }));
  const before = new Set(parametricLines(previous));
  return now.map((text) => ({ text, changed: !before.has(text) }));
}

// ---------------------------------------------------------------------------
// Headings and summaries, all derived
// ---------------------------------------------------------------------------

/** `BTC/USD` -> `BTC / USD`, the way the rule card writes an asset. */
export function assetLabel(spec: StrategySpec): string {
  return spec.series.asset.replace('/', ' / ');
}

/** Distinct predicate timeframes, upper-case: `15M`, or `15M · 1H`. */
export function timeframeLabel(spec: StrategySpec): string {
  const seen: string[] = [];
  for (const p of spec.predicates) {
    const tf = p.timeframe.value.toUpperCase();
    if (!seen.includes(tf)) seen.push(tf);
  }
  return seen.join(' · ');
}

/** One line per predicate for the rule card. */
export function predicateHeadlines(spec: StrategySpec): string[] {
  return spec.predicates.map((p) => {
    const dir = p.direction === 'long' ? 'Bullish' : 'Bearish';
    switch (p.kind) {
      case 'break_of_structure':
        return `${dir} break of structure confirmed`;
      case 'fair_value_gap':
        return `${dir} fair value gap present`;
      case 'liquidity_sweep':
        return `Liquidity swept beyond ${REFERENCE_LABEL[p.referenceExtreme.value] ?? p.referenceExtreme.value}`;
    }
  });
}

/** The two-line compressed spec on the strategy card. */
export function shareSummary(spec: StrategySpec): string[] {
  const top = spec.predicates.map((p) =>
    p.kind === 'fair_value_gap'
      ? `fvg ≥ ${formatBps(p.minGapBps.value)}`
      : predicateSymbol(p),
  );
  const bottom = [`risk ≤ ${formatBps(spec.risk.riskPerTradeBps.value)}`];
  const bos = spec.predicates.find((p) => p.kind === 'break_of_structure');
  if (bos && bos.kind === 'break_of_structure') {
    bottom.push(`lookback ${bos.swingLookbackCandles.value}`);
  }
  const tfs: string[] = [];
  for (const p of spec.predicates) if (!tfs.includes(p.timeframe.value)) tfs.push(p.timeframe.value);
  bottom.push(`tf ${tfs.join('/')}`);
  return [top.join(' · '), bottom.join(' · ')];
}

// ---------------------------------------------------------------------------
// Numbers a refusal names
// ---------------------------------------------------------------------------

/**
 * A fair value gap is decided in basis points; the other two in price. The
 * figure a refusal names has to be written in the unit it was decided in.
 */
export function formatPredicateValue(kind: PredicateKind, value: Decimal): string {
  if (kind === 'fair_value_gap') return formatBps(Number(value.atoms));
  return formatDecimal(value);
}

export function formatPredicateDelta(kind: PredicateKind, delta: Decimal): string {
  if (kind === 'fair_value_gap') return formatBps(Number(delta.atoms), { signed: true });
  return formatDecimal(delta, { signed: true });
}

/** Truncates (never rounds up) to `decimals` places, for display of long-scale amounts. */
export function truncateDecimal(d: Decimal, decimals: number): Decimal {
  if (d.decimals <= decimals) return d;
  const drop = 10n ** BigInt(d.decimals - decimals);
  return { atoms: (BigInt(d.atoms) / drop).toString(), decimals };
}

/**
 * The comparison a predicate made, in the direction it was made, with the
 * numbers that decided it: `68,441.20 > 68,412.50`. The same arithmetic the
 * contract does, written out so a trader can check it by eye.
 */
export function predicateComparison(
  p: Pick<Predicate, 'kind' | 'direction'>,
  deciding: Decimal,
  reference: Decimal,
  satisfied: boolean,
): string {
  const long = p.direction === 'long';
  let op: string;
  switch (p.kind) {
    case 'break_of_structure':
      op = long ? '>' : '<';
      break;
    case 'fair_value_gap':
      op = '≥';
      break;
    case 'liquidity_sweep':
      op = long ? '<' : '>';
      break;
  }
  if (!satisfied) {
    // A failed predicate reads as the opposite claim: the number that fell short.
    op = op === '>' ? '≤' : op === '<' ? '≥' : '<';
  }
  return `${formatPredicateValue(p.kind, deciding)} ${op} ${formatPredicateValue(p.kind, reference)}`;
}

// ---------------------------------------------------------------------------
// Integer ratios
// ---------------------------------------------------------------------------

function alignedAtoms(a: Decimal, b: Decimal): [bigint, bigint] {
  const decimals = Math.max(a.decimals, b.decimals);
  const scale = (d: Decimal) => BigInt(d.atoms) * 10n ** BigInt(decimals - d.decimals);
  return [scale(a), scale(b)];
}

/**
 * Integer basis points of `numerator` over `denominator`, rounded half away
 * from zero. Zero when the denominator is zero: a ratio against nothing is not
 * a number worth naming.
 */
export function roundedBps(numerator: Decimal, denominator: Decimal): number {
  const [n, d] = alignedAtoms(numerator, denominator);
  if (d === 0n) return 0;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const scaled = n * 10_000n;
  const q = (abs(scaled) + abs(d) / 2n) / abs(d);
  return Number((scaled < 0n) !== (d < 0n) ? -q : q);
}

/**
 * `part` of `whole`, two whole counts, in integer basis points rounded half up.
 * `null` before there is anything to divide.
 */
export function ratioBps(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.floor((part * 10_000 * 2 + whole) / (whole * 2));
}

/**
 * Of the setups put to the rule, the share that satisfied it, in integer basis
 * points rounded half up. `null` before there is anything to divide.
 */
export function adherenceBps(taken: number, blocked: number): number | null {
  return ratioBps(taken, taken + blocked);
}

/**
 * What the on-chain gate can and cannot see, said before anything is pinned.
 * The gate's series records one price per bucket, so each candle it holds has
 * its wick at its close. A liquidity sweep needs a wick through the level that
 * closes back inside, which such a candle can never show: the gate refuses a
 * sweep rule every time. It still compiles and pins; this says so plainly.
 */
export function onchainGateNote(spec: StrategySpec): string | null {
  if (!spec.predicates.some((p) => p.kind === 'liquidity_sweep')) return null;
  const minutes = Math.round(spec.series.bucketSeconds / 60);
  const bucket = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  return (
    `This rule cannot pass the on-chain gate: Kanon records one price per ${bucket} bucket on-chain, ` +
    "so a candle's wick is its close, and a liquidity sweep needs a wick through the level that " +
    'closes back inside. The gate will refuse every setup this rule puts to it.'
  );
}

/** The words a reference extreme is written in: `previous day's low`. */
export function referenceLabel(reference: string): string {
  return REFERENCE_LABEL[reference] ?? reference;
}


/**
 * A percentage the user typed (`0.15`, `0.5%`, `1`) as integer basis points,
 * parsed from the string so no float touches it. Anything finer than a basis
 * point, or not a number, is rejected rather than rounded: a rule must not
 * silently become a different rule.
 */
export function parsePercentToBps(input: string): number | null {
  const m = /^\s*(\d+)(?:\.(\d{0,2}))?\s*%?\s*$/.exec(input);
  if (!m) return null;
  const whole = m[1] ?? '0';
  const frac = (m[2] ?? '').padEnd(2, '0');
  return Number(whole) * 100 + Number(frac);
}

/** Basis points as the text an edit box starts from: `15` -> `0.15`. */
export function bpsToPercentText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}
