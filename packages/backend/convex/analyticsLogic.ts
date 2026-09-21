/**
 * The analytics screen's arithmetic: adherence, what the refusals saved, the
 * margin account's health, drawdown and the cooling-off clock.
 *
 * Pure. No `ctx`, no clock (callers pass `now`), no I/O, no model. Every price,
 * size and P&L is a `Decimal` handled as a `bigint`; every ratio is an integer
 * number of basis points. The one place a float could enter is a JS `number`
 * count, and those are only ever counted, never multiplied.
 *
 * The margin maths mirrors `packages/contracts/src/MarginAccount.sol` line for
 * line, including where it truncates, so the figure on screen is the figure the
 * contract would compute from the same inputs:
 *
 *   pnl         = size * (mark - entry) / entry        truncated toward zero, negated for a short
 *   equity      = collateral - debt + sum(pnl)
 *   maintenance = sum(size * maintenanceMarginBps / 1e4)
 *   health      = equity * 1e18 / maintenance          0 when equity <= 0, none when maintenance is 0
 *
 * A position with no usable mark is not guessed at. The contract reverts with
 * `NoRecentPrice` rather than read a stale price; here that is `unpriced`.
 */

import {
  COOLING_OFF_SECONDS,
  adherenceBps,
  dec,
  type AdherenceStats,
  type AnalyticsReport,
  type AvoidedStats,
  type Candle,
  type CoolingOffTime,
  type Decimal,
  type DrawdownStats,
  type EquityPoint,
  type ExposureLine,
  type HealthBand,
  type PredicateRefusal,
  type RiskSnapshot,
} from '@kanon/spec';
import { modelRefusedOutcome, type ModelledOutcome } from './proposerLogic';
import { normalizeAsset } from './seriesLogic';

// ---------------------------------------------------------------------------
// Integer helpers
// ---------------------------------------------------------------------------

const BPS = 10_000n;

const abs = (x: bigint): bigint => (x < 0n ? -x : x);
const compareBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** The atoms of `d` at `decimals` places. `decimals` must not be below `d.decimals`. */
function atomsAt(d: Decimal, decimals: number): bigint {
  return BigInt(d.atoms) * 10n ** BigInt(decimals - d.decimals);
}

function widest(ds: readonly Decimal[], floor = 0): number {
  return ds.reduce((m, d) => Math.max(m, d.decimals), floor);
}

/** `num / den` in basis points, rounded half away from zero. Zero over nothing. */
export function ratioBps(num: bigint, den: bigint): number {
  if (den === 0n) return 0;
  const scaled = abs(num) * BPS * 2n + abs(den);
  const q = scaled / (abs(den) * 2n);
  return Number((num < 0n) !== (den < 0n) ? -q : q);
}

function sumAt(ds: readonly Decimal[], decimals: number): bigint {
  return ds.reduce((s, d) => s + atomsAt(d, decimals), 0n);
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/** The slice of a `trades` row the analytics read. */
export interface AnalyticsTrade {
  id: string;
  direction: 'long' | 'short';
  asset: string;
  entry: Decimal;
  size: Decimal;
  stop: Decimal;
  status: 'proposed' | 'executed' | 'refused' | 'undone';
  failedPredicateId?: string | undefined;
  failedSymbol?: string | undefined;
  results?:
    | ReadonlyArray<{ predicateId: string; kind: string; symbol: string; satisfied: boolean }>
    | undefined;
  /** Milliseconds. */
  createdAt: number;
  executedAt?: number | undefined;
  /** The account equity the size was risked against. */
  equity?: Decimal | undefined;
}

/** True when the trade shows every predicate satisfied and none failed. */
export function satisfiedRule(t: AnalyticsTrade): boolean {
  if (t.failedPredicateId !== undefined) return false;
  return (t.results ?? []).every((r) => r.satisfied);
}

/**
 * Adherence: of the setups that reached a verdict, the share that satisfied the
 * pinned rule and ran. `undone` and `proposed` are not attempts. A cancelled
 * proposal never met the market, and a pending one has no verdict yet.
 *
 * The contract will not run a trade that fails a predicate, so `breaches` is
 * expected to be zero. It is counted anyway: a metric that assumes the property
 * it is meant to demonstrate is not evidence of it.
 */
export function summariseAdherence(trades: readonly AnalyticsTrade[]): AdherenceStats {
  let executed = 0;
  let refused = 0;
  let undone = 0;
  let proposed = 0;
  let satisfied = 0;
  for (const t of trades) {
    if (t.status === 'executed') {
      executed += 1;
      if (satisfiedRule(t)) satisfied += 1;
    } else if (t.status === 'refused') refused += 1;
    else if (t.status === 'undone') undone += 1;
    else proposed += 1;
  }
  const attempts = executed + refused;
  const bps = adherenceBps(satisfied, attempts - satisfied);
  return {
    executed,
    refused,
    undone,
    proposed,
    attempts,
    satisfied,
    breaches: executed - satisfied,
    adherenceBps: bps,
    refusalBps: attempts > 0 ? ratioBps(BigInt(refused), BigInt(attempts)) : null,
  };
}

// ---------------------------------------------------------------------------
// What the refusals would have cost
// ---------------------------------------------------------------------------

/** Candles for one asset, with the width they were bucketed at. */
export interface AssetCandles {
  bucketSeconds: number;
  candles: readonly Candle[];
}

const PENDING: ModelledOutcome = { status: 'pending' };

/**
 * Plays one setup forward to its own stop, over the candles that printed after
 * it. Where the candles do not reach back to the setup (the first one begins
 * more than a bucket after it) the verdict is `pending`: a stop touched before
 * the data begins would be invisible, and saying "would have lost" or "would
 * have won" from a partial view is a claim nobody can check.
 */
export function modelTrade(
  t: AnalyticsTrade,
  series: Readonly<Record<string, AssetCandles>>,
): ModelledOutcome {
  const entry = series[normalizeAsset(t.asset)];
  if (!entry || entry.candles.length === 0) return PENDING;
  const at = t.status === 'executed' ? (t.executedAt ?? t.createdAt) : t.createdAt;
  const first = entry.candles[0]!;
  if (first.timestamp * 1000 > at + entry.bucketSeconds * 1000) return PENDING;
  return modelRefusedOutcome(
    { direction: t.direction, entry: t.entry, stop: t.stop, size: t.size, at },
    entry.candles,
  );
}

/**
 * Tallies modelled outcomes. Sums are aligned to the widest scale present
 * (never below two places) so a 2-decimal and an 8-decimal price add exactly.
 */
export function summariseAvoided(outcomes: readonly ModelledOutcome[]): AvoidedStats {
  let judged = 0;
  let pending = 0;
  let lostCount = 0;
  let wonCount = 0;
  const lost: Decimal[] = [];
  const won: Decimal[] = [];
  for (const o of outcomes) {
    if (o.status === 'pending') {
      pending += 1;
      continue;
    }
    judged += 1;
    if (o.lost) {
      lostCount += 1;
      lost.push(o.pnl);
    } else if (BigInt(o.pnl.atoms) > 0n) {
      wonCount += 1;
      won.push(o.pnl);
    }
  }
  const decimals = widest([...lost, ...won], 2);
  return {
    refused: outcomes.length,
    judged,
    pending,
    wouldHaveLostCount: lostCount,
    lossAvoided: dec(-sumAt(lost, decimals), decimals),
    wouldHaveWonCount: wonCount,
    gainForegone: dec(sumAt(won, decimals), decimals),
  };
}

/** Refusals grouped by the predicate that failed, most refused first. */
export function refusalsByPredicate(
  refused: readonly AnalyticsTrade[],
  outcomes: Readonly<Record<string, ModelledOutcome>>,
): PredicateRefusal[] {
  const groups = new Map<string, AnalyticsTrade[]>();
  for (const t of refused) {
    const key = t.failedPredicateId ?? 'unknown';
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const rows: PredicateRefusal[] = [];
  for (const [predicateId, list] of groups) {
    let latest = list[0]!;
    for (const t of list) if (t.createdAt >= latest.createdAt) latest = t;

    const failed = list
      .flatMap((t) => t.results ?? [])
      .find((r) => r.predicateId === predicateId && !r.satisfied);
    const label = failed?.symbol ?? latest.failedSymbol ?? predicateId;

    const summary = summariseAvoided(list.map((t) => outcomes[t.id] ?? PENDING));
    rows.push({
      predicateId,
      label,
      kind: failed?.kind ?? null,
      count: list.length,
      shareBps: ratioBps(BigInt(list.length), BigInt(refused.length)),
      lostCount: summary.wouldHaveLostCount,
      lossAvoided: summary.lossAvoided,
      latestTradeId: latest.id,
      latestAt: latest.createdAt,
    });
  }
  return rows.sort(
    (a, b) => b.count - a.count || b.latestAt - a.latestAt || a.predicateId.localeCompare(b.predicateId),
  );
}

// ---------------------------------------------------------------------------
// Margin account: health factor and exposure
// ---------------------------------------------------------------------------

/** `MarginAccount.HEALTH_FACTOR_PRECISION`. 1e18 is 100%. */
export const HEALTH_FACTOR_PRECISION = 10n ** 18n;
export const HEALTH_FACTOR_DECIMALS = 18;

/**
 * The risk parameters `MarginAccount` is deployed with. They are immutable
 * constructor arguments there, so these are the `Deploy.s.sol` defaults and are
 * surfaced on screen rather than assumed: a deployment with other values is a
 * different contract, and the deployed one is authoritative.
 */
export interface MarginParams {
  maintenanceMarginBps: number;
  /** 1e18-scaled. The deleveraging band is `[1e18, adlHealthThreshold)`. */
  adlHealthThreshold: bigint;
}

export const DEFAULT_MARGIN_PARAMS: MarginParams = {
  maintenanceMarginBps: 500,
  adlHealthThreshold: 12n * 10n ** 17n,
};

export interface MarginPosition {
  asset: string;
  side: 'long' | 'short';
  /** Notional in collateral units. */
  size: Decimal;
  entryPrice: Decimal;
}

export interface MarginInput {
  collateral: Decimal;
  /** Realised losses beyond collateral. The ledger mirror does not track it yet: absent means zero. */
  debt?: Decimal | undefined;
  positions: readonly MarginPosition[];
  /** Current price per asset, keyed by `normalizeAsset`. */
  marks: Readonly<Record<string, Decimal>>;
  params?: Partial<MarginParams> | undefined;
}

/** `MarginAccount._pnl`: integer division truncating toward zero, then negated for a short. */
export function positionPnl(
  size: bigint,
  entry: Decimal,
  mark: Decimal,
  side: 'long' | 'short',
): bigint {
  const decimals = Math.max(entry.decimals, mark.decimals);
  const e = atomsAt(entry, decimals);
  const m = atomsAt(mark, decimals);
  const pnl = (size * (m - e)) / e;
  return side === 'long' ? pnl : -pnl;
}

function bandOf(health: bigint | null, adl: bigint): HealthBand {
  if (health === null) return 'healthy';
  if (health < HEALTH_FACTOR_PRECISION) return 'liquidatable';
  if (health < adl) return 'deleveraging';
  return 'healthy';
}

export function assessRisk(input: MarginInput): RiskSnapshot {
  const params: MarginParams = { ...DEFAULT_MARGIN_PARAMS, ...input.params };
  const debt = input.debt ?? dec(0n, input.collateral.decimals);
  const { positions } = input;

  const decimals = widest([input.collateral, debt, ...positions.map((p) => p.size)]);

  const missing: string[] = [];
  const marked = positions.map((p) => {
    const mark = input.marks[normalizeAsset(p.asset)];
    const usable =
      mark !== undefined && BigInt(mark.atoms) > 0n && BigInt(p.entryPrice.atoms) > 0n;
    if (!usable && !missing.includes(p.asset)) missing.push(p.asset);
    return { p, mark: usable ? mark : null };
  });

  // Exposure needs no price, so it is read even when health cannot be.
  const gross = marked.reduce((s, { p }) => s + atomsAt(p.size, decimals), 0n);
  const lines: ExposureLine[] = marked
    .map(({ p, mark }) => {
      const notional = atomsAt(p.size, decimals);
      return {
        asset: p.asset,
        side: p.side,
        notional: dec(notional, decimals),
        shareBps: ratioBps(notional, gross),
        entryPrice: p.entryPrice,
        markPrice: mark,
        pnl: mark ? dec(positionPnl(BigInt(p.size.atoms), p.entryPrice, mark, p.side), p.size.decimals) : null,
      };
    })
    .sort(
      (a, b) =>
        compareBig(BigInt(b.notional.atoms), BigInt(a.notional.atoms)) ||
        a.asset.localeCompare(b.asset),
    );

  if (positions.length === 0) return { status: 'flat', collateral: input.collateral, lines };
  if (missing.length > 0) {
    return { status: 'unpriced', missing, collateral: input.collateral, lines };
  }

  let unrealized = 0n;
  let maintenance = 0n;
  let long = 0n;
  let short = 0n;
  for (const { p, mark } of marked) {
    const size = BigInt(p.size.atoms);
    const scale = 10n ** BigInt(decimals - p.size.decimals);
    unrealized += positionPnl(size, p.entryPrice, mark!, p.side) * scale;
    maintenance += ((size * BigInt(params.maintenanceMarginBps)) / BPS) * scale;
    if (p.side === 'long') long += size * scale;
    else short += size * scale;
  }

  const equity = atomsAt(input.collateral, decimals) - atomsAt(debt, decimals) + unrealized;
  // The contract returns type(uint256).max when nothing needs maintenance: no factor to state.
  const health: bigint | null =
    maintenance === 0n ? null : equity <= 0n ? 0n : (equity * HEALTH_FACTOR_PRECISION) / maintenance;

  return {
    status: 'ok',
    collateral: input.collateral,
    lines,
    debt: dec(atomsAt(debt, decimals), decimals),
    unrealizedPnl: dec(unrealized, decimals),
    equity: dec(equity, decimals),
    maintenance: dec(maintenance, decimals),
    maintenanceBps: params.maintenanceMarginBps,
    healthFactor: health === null ? null : dec(health, HEALTH_FACTOR_DECIMALS),
    adlHealthThreshold: dec(params.adlHealthThreshold, HEALTH_FACTOR_DECIMALS),
    band: bandOf(health, params.adlHealthThreshold),
    gross: dec(gross, decimals),
    net: dec(long - short, decimals),
    leverageBps: equity > 0n ? Number((gross * BPS) / equity) : null,
  };
}

// ---------------------------------------------------------------------------
// Equity curve and drawdown
// ---------------------------------------------------------------------------

/**
 * Cumulative equity from a starting figure and dated P&L events, oldest first.
 * The start is stamped just before the first event so a first-trade loss is a
 * drawdown from the start rather than the start of the curve.
 */
export function equityCurve(
  start: Decimal,
  events: ReadonlyArray<{ at: number; pnl: Decimal }>,
): EquityPoint[] {
  if (events.length === 0) return [];
  const ordered = events
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  const decimals = widest([start, ...ordered.map((e) => e.pnl)]);
  let running = atomsAt(start, decimals);
  const points: EquityPoint[] = [{ at: ordered[0]!.at - 1, equity: dec(running, decimals) }];
  for (const e of ordered) {
    running += atomsAt(e.pnl, decimals);
    points.push({ at: e.at, equity: dec(running, decimals) });
  }
  return points;
}

/**
 * Largest peak-to-trough fall, as a share of the peak in bps (half up), and the
 * fall the curve is in right now. Points are read in time order. A peak at or
 * below zero has no meaningful ratio and is skipped.
 */
export function maxDrawdown(points: readonly EquityPoint[]): DrawdownStats {
  if (points.length < 2) return { status: 'empty' };
  const ordered = points.map((p, i) => ({ p, i })).sort((a, b) => a.p.at - b.p.at || a.i - b.i);
  const decimals = widest(ordered.map((o) => o.p.equity));

  let peak = atomsAt(ordered[0]!.p.equity, decimals);
  let peakAt = ordered[0]!.p.at;
  let bestBps = 0;
  let bestPeak = peak;
  let bestPeakAt = peakAt;
  let bestTrough = peak;
  let bestTroughAt = peakAt;
  let currentBps = 0;

  for (const { p } of ordered) {
    const eq = atomsAt(p.equity, decimals);
    if (eq > peak) {
      peak = eq;
      peakAt = p.at;
    }
    const bps = peak > 0n ? Math.min(10_000, ratioBps(peak - eq, peak)) : 0;
    if (bps > bestBps) {
      bestBps = bps;
      bestPeak = peak;
      bestPeakAt = peakAt;
      bestTrough = eq;
      bestTroughAt = p.at;
    }
    currentBps = bps;
  }

  return {
    status: 'ok',
    points: ordered.length,
    maxDrawdownBps: bestBps,
    currentDrawdownBps: currentBps,
    peak: dec(bestPeak, decimals),
    trough: dec(bestTrough, decimals),
    peakAt: bestPeakAt,
    troughAt: bestTroughAt,
  };
}

// ---------------------------------------------------------------------------
// Cooling-off
// ---------------------------------------------------------------------------

/**
 * How far through the current hold a pending loosening is. Only the hold in
 * force is known: past holds are not stored, so no lifetime total is claimed.
 */
export function coolingOffTime(input: {
  status: 'draft' | 'pinned' | 'cooling_off';
  cooldownEndsAt?: number | undefined;
  now: number;
  holdSeconds?: number | undefined;
}): CoolingOffTime {
  const holdMs = (input.holdSeconds ?? COOLING_OFF_SECONDS) * 1000;
  if (input.status !== 'cooling_off' || input.cooldownEndsAt === undefined) {
    return { active: false, holdMs, elapsedMs: 0, remainingMs: 0, progressBps: 0 };
  }
  const remainingMs = Math.max(0, Math.min(holdMs, input.cooldownEndsAt - input.now));
  const elapsedMs = holdMs - remainingMs;
  return {
    active: remainingMs > 0,
    holdMs,
    elapsedMs,
    remainingMs,
    progressBps: holdMs > 0 ? Math.floor((elapsedMs * 10_000) / holdMs) : 0,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ReportInput {
  now: number;
  strategy: {
    id: string;
    status: 'draft' | 'pinned' | 'cooling_off';
    specHash: string;
    asset: string;
    cooldownEndsAt?: number | undefined;
  };
  trades: readonly AnalyticsTrade[];
  /** Candles per asset, keyed by `normalizeAsset`. */
  series: Readonly<Record<string, AssetCandles>>;
  /** True when a price read hit its ceiling. */
  truncated?: boolean | undefined;
  account: { collateral: Decimal; debt?: Decimal | undefined } | null;
  positions: readonly MarginPosition[];
  marks: Readonly<Record<string, Decimal>>;
}

export function buildReport(input: ReportInput): AnalyticsReport {
  const { trades } = input;
  const refused = trades.filter((t) => t.status === 'refused');
  const executed = trades.filter((t) => t.status === 'executed');

  const refusedOutcomes: Record<string, ModelledOutcome> = {};
  for (const t of refused) refusedOutcomes[t.id] = modelTrade(t, input.series);

  // Executed trades are played forward the same way, to their own stop or the
  // latest close. That is a model, not a settled fill, and is labelled so.
  const executedRuns = executed
    .map((t) => ({ t, o: modelTrade(t, input.series) }))
    .filter((r): r is { t: AnalyticsTrade; o: Exclude<ModelledOutcome, { status: 'pending' }> } =>
      r.o.status !== 'pending',
    );

  const startEquity =
    executed
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .find((t) => t.equity !== undefined)?.equity ??
    input.account?.collateral ??
    null;

  const curve = startEquity
    ? equityCurve(
        startEquity,
        executedRuns.map(({ o }) => ({ at: o.at * 1000, pnl: o.pnl })),
      )
    : [];

  const pnlDecimals = widest(executedRuns.map((r) => r.o.pnl), 2);

  return {
    asOf: input.now,
    strategyId: input.strategy.id,
    specHash: input.strategy.specHash,
    asset: input.strategy.asset,
    adherence: summariseAdherence(trades),
    avoided: summariseAvoided(refused.map((t) => refusedOutcomes[t.id]!)),
    byPredicate: refusalsByPredicate(refused, refusedOutcomes),
    risk: input.account
      ? assessRisk({
          collateral: input.account.collateral,
          debt: input.account.debt,
          positions: input.positions,
          marks: input.marks,
        })
      : { status: 'none' },
    drawdown: maxDrawdown(curve),
    equityCurve: curve,
    coolingOff: coolingOffTime({
      status: input.strategy.status,
      cooldownEndsAt: input.strategy.cooldownEndsAt,
      now: input.now,
    }),
    pnl: {
      total: dec(sumAt(executedRuns.map((r) => r.o.pnl), pnlDecimals), pnlDecimals),
      trades: executedRuns.length,
    },
    truncated: input.truncated === true,
  };
}
