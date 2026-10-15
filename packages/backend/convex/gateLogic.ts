import {
  TIMEFRAME_SECONDS,
  dec,
  evaluatePredicate,
  predicateSymbol,
  predicatesCommitment,
  toPredicateDefinitions,
  type Candle,
  type Decimal,
  type Predicate,
  type PredicateDefinition,
  type Series,
  type StrategySpec,
} from "@kanon/spec";
import { contractEvent, padAddress, padUint, type RpcReceipt } from "./chainLogic";
import type { GateReceipt, PreviewAnswer } from "./gatePort";
import { BUCKET_SECONDS, gasLimitFor } from "./keeperLogic";
import type { PredicateOutcome, Scan } from "./proposerLogic";
import type { GateEnv } from "./serverEnv";

/**
 * The gate's pure half. Every judgment, a button press or autopilot's, pass or
 * refusal, is a real `RefusalGate.evaluateOnChain` transaction signed by
 * Kanon's key (`gate.ts` sends it). This file decides everything around that
 * transaction that can be decided without a network: whether a rule can be
 * asked at all, what a revert means, how much gas to give it, what its receipt
 * says, and how its verdict is explained from the chain's own candles.
 *
 * The verdict is the chain's. Nothing here, and nothing in `proposer.ts`,
 * overrides it with the off-chain arithmetic: that is recorded beside it as
 * `offchainVerdict`, so a disagreement is visible rather than resolved.
 *
 * No clock and no I/O: callers pass the block time.
 */

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Both keeper series bucket by 15 minutes; the gate judges nothing else. */
export const GATE_BUCKET_SECONDS = Number(BUCKET_SECONDS);

/**
 * A judgment asked with fewer seconds than this left in the bucket waits for
 * the next one. `evaluateOnChain` judges the bucket of the block it lands in,
 * which must already be recorded: a transaction sent at 14:59:55 can land at
 * 15:00:01 and revert `StaleSeries`, gas spent for nothing.
 */
export const BOUNDARY_GUARD_SECONDS = 12;
/** How far into the next bucket such a judgment waits, so it is not read on the boundary itself. */
export const BOUNDARY_MARGIN_SECONDS = 2;

/** The bucket a unix time falls in, as `CanonicalSeries.bucketIndexOf` computes it. */
export const bucketOf = (unixSeconds: number | bigint): number => Number(BigInt(unixSeconds) / BUCKET_SECONDS);

/** Seconds to wait before asking the gate, given the chain's clock: zero unless the bucket is about to end. */
export function boundaryWaitSeconds(blockTime: number | bigint): number {
  const into = Number(BigInt(blockTime) % BUCKET_SECONDS);
  const left = GATE_BUCKET_SECONDS - into;
  return left < BOUNDARY_GUARD_SECONDS ? left + BOUNDARY_MARGIN_SECONDS : 0;
}

// ---------------------------------------------------------------------------
// Whether a rule can be asked
// ---------------------------------------------------------------------------

/** The fields of a `strategies` row the gate is asked from. */
export interface JudgeableStrategy {
  pinVerified?: boolean;
  chainId?: number;
  registryAddress?: string;
  chainStrategyId?: string;
  predicatesCommitment?: string;
  seriesAddress?: string;
}

/** Everything one `evaluateOnChain` is sent with, and where. */
export interface GateTarget {
  chainId: number;
  gate: `0x${string}`;
  series: `0x${string}`;
  /** The keeper feed the series samples, e.g. `BTC/USD`. */
  feed: string;
  chainStrategyId: bigint;
  isLong: boolean;
  predicates: PredicateDefinition[];
}

export type Eligibility = { ok: true; target: GateTarget } | { ok: false; message: string };

export const NOT_ELIGIBLE = {
  timeframe: (tf: string) =>
    `The on-chain gate judges rules written on 15-minute candles, and this one is written on ${tf} candles, so it cannot be asked.`,
  unverified: "This rule's pin was recorded before pins were checked on-chain, so the gate cannot be asked about it. Pin it again.",
  noRegistryId: "This rule has no registry entry, so the gate has nothing to judge it by.",
  foreignChain: "This rule is pinned on another chain or registry than the gate on this deployment, so the gate cannot judge it.",
  series: "The price series this rule is pinned to is not one Kanon keeps sampled, so the gate cannot judge it.",
  commitment: "This rule's predicates do not match the commitment pinned for it, so the gate would not judge them.",
} as const;

const lower = (s: string | undefined) => (s ?? "").toLowerCase();

/**
 * Whether the gate on this deployment can judge a rule, and if so exactly what
 * it is sent: the registry id, the side and the committed predicates, encoded
 * by `@kanon/spec` exactly as they were pinned. Nothing is sent for a rule
 * that fails any of these, so a check that could only revert costs nothing.
 */
export function gateEligibility(
  strategy: JudgeableStrategy,
  spec: StrategySpec,
  env: Pick<GateEnv, "chainId" | "registryAddress" | "gateAddress" | "series">,
): Eligibility {
  const off = spec.predicates.find((p) => TIMEFRAME_SECONDS[p.timeframe.value] !== GATE_BUCKET_SECONDS);
  if (spec.series.bucketSeconds !== GATE_BUCKET_SECONDS || off) {
    return { ok: false, message: NOT_ELIGIBLE.timeframe(off?.timeframe.value ?? `${spec.series.bucketSeconds}s`) };
  }
  if (strategy.pinVerified !== true) return { ok: false, message: NOT_ELIGIBLE.unverified };
  if (!strategy.chainStrategyId || !/^\d{1,78}$/.test(strategy.chainStrategyId)) {
    return { ok: false, message: NOT_ELIGIBLE.noRegistryId };
  }
  if (strategy.chainId !== env.chainId || lower(strategy.registryAddress) !== lower(env.registryAddress)) {
    return { ok: false, message: NOT_ELIGIBLE.foreignChain };
  }
  const entry = Object.entries(env.series).find(([, address]) => lower(address) === lower(strategy.seriesAddress));
  if (!entry || !strategy.seriesAddress) return { ok: false, message: NOT_ELIGIBLE.series };

  let predicates: PredicateDefinition[];
  try {
    predicates = toPredicateDefinitions(spec);
    if (lower(predicatesCommitment(spec)) !== lower(strategy.predicatesCommitment)) {
      return { ok: false, message: NOT_ELIGIBLE.commitment };
    }
  } catch {
    return { ok: false, message: NOT_ELIGIBLE.commitment };
  }
  return {
    ok: true,
    target: {
      chainId: env.chainId,
      gate: env.gateAddress,
      series: entry[1] as `0x${string}`,
      feed: entry[0],
      chainStrategyId: BigInt(strategy.chainStrategyId),
      isLong: spec.direction === "long",
      predicates,
    },
  };
}

// ---------------------------------------------------------------------------
// Why nothing was sent
// ---------------------------------------------------------------------------

/**
 * Every way a judgment ends without a verdict. None of them is a refusal and
 * none is written as one: the rule was not judged, and the sentence says why.
 */
export type GateUnavailableReason =
  | "signer_not_configured"
  | "signer_unfunded"
  | "fee_too_high"
  | "daily_cap"
  | "busy"
  | "not_eligible"
  | "source_stale"
  | "series_not_fresh"
  | "stale_series"
  | "commitment_mismatch"
  | "timeframe_mismatch"
  | "unknown_strategy"
  | "malformed_rule"
  | "gate_reverted"
  | "gas_cap"
  | "reverted"
  | "unreadable"
  | "unconfirmed";

export const GATE_MESSAGES = {
  signer_not_configured:
    "Kanon's on-chain signer is not set up on this deployment, so the gate cannot be asked. Nothing was sent.",
  signer_off: "Kanon's on-chain signer is switched off on this deployment, so the gate cannot be asked. Nothing was sent.",
  signer_unfunded:
    "Kanon's signer is below its minimum balance, so the gate cannot be asked until it is topped up. Nothing was sent.",
  fee_too_high: "Gas on Monad is above Kanon's fee cap right now, so the gate was not asked. Nothing was sent.",
  daily_cap:
    "Today's on-chain budget for gate checks is spent, so the gate is not asked again until midnight UTC. Nothing was sent. The price keeper keeps its own share and goes on sampling.",
  busy: "Kanon's signer is busy with another transaction. Nothing was sent; ask again in a moment.",
  series_not_fresh: "The on-chain price series could not be brought up to this 15-minute bucket, so the gate was not asked. Nothing was sent.",
  source_stale: "The mainnet price the on-chain series mirrors is too old to record, so the gate was not asked. Nothing was sent.",
  gas_cap: "Judging this rule on-chain needs more gas than Kanon's limit for one judgment, so it was not sent.",
  reverted: (hash: string) => `The gate transaction ${hash} reverted, so it carries no verdict.`,
  unreadable: (hash: string) => `The gate transaction ${hash} was confirmed, and no verdict could be read from it.`,
  unconfirmed: (hash: string) => `The gate transaction ${hash} was sent and not confirmed in time, so its verdict is not recorded here.`,
} as const;

/** What a revert of `previewOnChain` means, as a reason, a sentence, and whether asking again later can help. */
export interface GateRevert {
  reason: GateUnavailableReason;
  message: string;
  retryable: boolean;
}

const MALFORMED: Record<string, string> = {
  NoPredicates: "it pins no predicates",
  InvalidPredicate: "a break of structure in it has no lookback",
  MixedDirections: "its predicates mix long and short setups",
  InconsistentSweepDirection: "a liquidity sweep in it points the other way from its reference",
};

/** `previewOnChain` reverted with the gate's error `name`. Nothing is sent after one. */
export function gateRevert(name: string): GateRevert {
  switch (name) {
    case "StaleSeries":
      return {
        reason: "stale_series",
        message: "The on-chain price series has not recorded this 15-minute bucket yet, so the gate cannot judge it now. Nothing was sent.",
        retryable: true,
      };
    case "CommitmentMismatch":
      return {
        reason: "commitment_mismatch",
        message: "The predicates sent do not match the commitment the registry holds for this rule, so the gate would not judge them. Nothing was sent.",
        retryable: false,
      };
    case "TimeframeMismatch":
      return {
        reason: "timeframe_mismatch",
        message: "This rule's timeframe is not the bucket of the series it is pinned to, so the gate would not judge it. Nothing was sent.",
        retryable: false,
      };
    case "UnknownStrategy":
      return {
        reason: "unknown_strategy",
        message: "The registry holds no strategy under this rule's id, so the gate has nothing to judge. Nothing was sent.",
        retryable: false,
      };
  }
  const why = MALFORMED[name];
  if (why) {
    return { reason: "malformed_rule", message: `The gate cannot judge this rule as pinned: ${why}. Nothing was sent.`, retryable: false };
  }
  return {
    reason: "gate_reverted",
    message: `The gate would not judge this rule right now (${name || "no reason given"}). Nothing was sent.`,
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------

/**
 * How much less than the limit the probe runs `previewOnChain` with. It covers
 * what `evaluateOnChain` does beyond the preview: reading the active spec hash
 * and emitting the event.
 */
export const GAS_PROBE_MARGIN = 30_000n;
/** How many limits are probed before a judgment is given up as `gas_cap`. */
export const MAX_GAS_PROBES = 4;

/** The first limit: the estimate plus a tenth, as the keeper pads its own, or null over the cap. */
export const firstGateGasLimit = (estimate: bigint, maxGas: bigint): bigint | null => gasLimitFor(estimate, maxGas);

/** The limit after a probe that came back different: half again, never past the cap. Null at the cap. */
export function nextGateGasLimit(limit: bigint, maxGas: bigint): bigint | null {
  if (limit >= maxGas) return null;
  const next = (limit * 3n + 1n) / 2n;
  return next > maxGas ? maxGas : next;
}

/** The gas the probe gives `previewOnChain` for a limit. */
export const probeGas = (limit: bigint): bigint => (limit > GAS_PROBE_MARGIN ? limit - GAS_PROBE_MARGIN : 0n);

/**
 * Whether a probe answered what the unbounded preview answered. Monad bills
 * the limit, so the limit is kept tight; but the gate's try/catch turns an
 * evaluation that runs out of gas into a refusal with `decidingValue` 0. A
 * limit is only used once the preview under it says exactly what the truth
 * says, so a tight limit can never manufacture a refusal.
 */
export function samePreview(a: PreviewAnswer, b: PreviewAnswer): boolean {
  if (a.kind !== "result" || b.kind !== "result") return false;
  return (
    a.allSatisfied === b.allSatisfied &&
    a.failingSymbol.toLowerCase() === b.failingSymbol.toLowerCase() &&
    a.decidingValue === b.decidingValue
  );
}

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

/** `topic0` of the gate's two events. `gateLogic.test.ts` recomputes both with viem. */
export const GATE_TOPICS = {
  /** `TradeProposed(uint256,bytes32,address)`: strategy id, spec hash and proposer, all indexed. */
  proposed: "0xe08423b5aec904a021d0b4b7700639b72a42c836626504c92aa426113b17da39",
  /** `TradeRefused(uint256,bytes32,address,bytes32,int256)`: the same three, then the symbol and the deciding value. */
  refused: "0xf5a8f5c05c260bedfb9c80213e24185e2f202397cd9adaa424a75791537fb425",
} as const;

export type GateEvent =
  | { ok: true; verdict: "proposed"; specHash: string }
  | { ok: true; verdict: "refused"; specHash: string; symbol: string; symbolRaw: string; decidingValue: bigint }
  | { ok: false; reason: string };

const TWO_255 = 1n << 255n;
const TWO_256 = 1n << 256n;

/** A 32-byte word as a signed int256: two's complement, as Solidity writes a negative `decidingValue`. */
export function int256(word: string): bigint {
  const n = BigInt(word);
  return n >= TWO_255 ? n - TWO_256 : n;
}

/**
 * A bytes32 that carries a short ASCII label, right-padded with zeros, as the
 * gate emits a predicate symbol. Anything not printable ASCII is returned as
 * hex, never guessed at: the indexer's `decodeBytes32Text`, line for line.
 */
export function bytes32Text(hex: string): string {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) return hex;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 2) bytes.push(parseInt(body.slice(i, i + 2), 16));
  while (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes.pop();
  if (bytes.length === 0) return "";
  if (!bytes.every((b) => b >= 0x20 && b <= 0x7e)) return hex;
  return String.fromCharCode(...bytes);
}

/** A port's receipt in the node's own shape, which `chainLogic.ts` reads. */
export const toRpcReceipt = (r: GateReceipt): RpcReceipt => ({
  status: r.status === "success" ? "0x1" : "0x0",
  to: r.to ?? null,
  logs: (r.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
});

/**
 * The verdict a gate transaction carries: the one `TradeProposed` or
 * `TradeRefused` the gate itself emitted for this strategy, proposed by
 * Kanon's signer. A log from any other address, for another strategy or from
 * another proposer is not this judgment's, and both events at once, or
 * neither, is no verdict.
 */
export function decodeGateReceipt(input: {
  receipt: RpcReceipt | null;
  gateAddress: string;
  chainStrategyId: bigint;
  signer: string;
}): GateEvent {
  const topics = [padUint(input.chainStrategyId), null, padAddress(input.signer)];
  const common = { receipt: input.receipt, address: input.gateAddress, topics, malformed: "The gate's log is malformed." };
  const proposed = contractEvent({ ...common, topic0: GATE_TOPICS.proposed, words: 0, missing: "none" });
  const refused = contractEvent({ ...common, topic0: GATE_TOPICS.refused, words: 2, missing: "none" });
  if (proposed.ok && refused.ok) return { ok: false, reason: "The transaction carries both a pass and a refusal." };
  if (proposed.ok) return { ok: true, verdict: "proposed", specHash: proposed.topics[2]! };
  if (refused.ok) {
    const [symbolRaw, value] = refused.words as [string, string];
    return {
      ok: true,
      verdict: "refused",
      specHash: refused.topics[2]!,
      symbol: bytes32Text(symbolRaw),
      symbolRaw,
      decidingValue: int256(value),
    };
  }
  for (const ev of [proposed, refused]) {
    if (!ev.ok && ev.reason !== "none") return ev;
  }
  return { ok: false, reason: "No verdict from the gate for this rule was found in that transaction." };
}

/** Whether the event says what the preview said a moment before. A difference is recorded; the event decides. */
export function eventMatchesPreview(event: Extract<GateEvent, { ok: true }>, preview: PreviewAnswer): boolean {
  if (preview.kind !== "result") return false;
  if (event.verdict === "proposed") return preview.allSatisfied;
  return (
    !preview.allSatisfied &&
    preview.failingSymbol.toLowerCase() === event.symbolRaw.toLowerCase() &&
    preview.decidingValue === event.decidingValue
  );
}

// ---------------------------------------------------------------------------
// The replay: the verdict explained from the chain's own candles
// ---------------------------------------------------------------------------

const DAY_SECONDS = 86_400;
const LOOKBACK_SECONDS = { "15m": 900, "1h": 3_600, "4h": 14_400, "1D": 86_400, "1W": 604_800 } as const;

/**
 * The first bucket a predicate is evaluated from on-chain: a port of
 * `PredicateEngine.windowStart`, rule for rule. The window always ends at the
 * bucket being judged, and only that bucket decides.
 *
 *   break of structure, lookback N    latest - N (N+1 buckets)
 *   fair value gap                    latest - 2 (one three-candle triple)
 *   sweep of a swing extreme          latest - lookback / bucket
 *   sweep of the previous day/session the first bucket of the previous UTC day
 *
 * Every start clamps to bucket 0.
 */
export function gateWindowStart(p: Predicate, latestBucket: number, bucketSeconds: number): number {
  let back: number;
  if (p.kind === "break_of_structure") back = p.swingLookbackCandles.value;
  else if (p.kind === "fair_value_gap") back = 2;
  else if (p.referenceExtreme.value === "swing_low" || p.referenceExtreme.value === "swing_high") {
    back = Math.floor(LOOKBACK_SECONDS[p.lookback.value] / bucketSeconds);
  } else {
    const latestTs = latestBucket * bucketSeconds;
    const dayStart = latestTs - (latestTs % DAY_SECONDS);
    if (dayStart < DAY_SECONDS) return 0;
    return Math.floor((dayStart - DAY_SECONDS) / bucketSeconds);
  }
  return latestBucket > back ? latestBucket - back : 0;
}

/** The buckets one read must cover to replay every predicate of a spec at `latestBucket`. */
export function replayWindow(spec: StrategySpec, latestBucket: number): { from: number; to: number } {
  const bucketSeconds = spec.series.bucketSeconds;
  const from = Math.min(...spec.predicates.map((p) => gateWindowStart(p, latestBucket, bucketSeconds)));
  return { from, to: latestBucket };
}

/** One bucket of a series as the chain returned it, prices at the series' `priceExpo`. */
export interface ChainCandle {
  bucket: number | bigint;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  recorded: boolean;
}

interface ReplayBase {
  predicateId: string;
  kind: Predicate["kind"];
  symbol: string;
}
export type ReplayOutcome =
  | (ReplayBase & { status: "decided"; satisfied: boolean; decidingValue: Decimal; referenceValue: Decimal; at: number })
  /** The window does not hold what the predicate needs, so the gate refused it with `decidingValue` 0. */
  | (ReplayBase & { status: "could_not_evaluate"; needed: number; recorded: number; span: number; message: string });

export interface ChainReplay {
  bucketIndex: number;
  priceExpo: number;
  /** The first bucket read. */
  windowFrom: number;
  outcomes: ReplayOutcome[];
}

/** How many recorded candles a predicate's on-chain window must hold before it can be decided at all. */
function candlesNeeded(p: Predicate): number {
  if (p.kind === "break_of_structure") return p.swingLookbackCandles.value + 1;
  if (p.kind === "fair_value_gap") return 3;
  return 2;
}

function unevaluableMessage(p: Predicate, needed: number, recorded: number, span: number): string {
  const symbol = predicateSymbol(p);
  if (p.kind === "liquidity_sweep") {
    return `Could not evaluate ${symbol}: it needs earlier recorded samples to measure its reference from, and the series has ${recorded} of the ${span} buckets in its window.`;
  }
  return `Could not evaluate ${symbol}: it needs ${needed} consecutive 15m samples, and the series has ${recorded} of the last ${span}.`;
}

/**
 * The gate's verdict explained: `evaluatePredicate` from `@kanon/spec`, run
 * over the very candles the gate read (its window, recorded buckets only, at
 * the series' own scale), with only the judged bucket allowed to decide. That
 * is what `PredicateEngine` does on-chain, so a decided outcome here names the
 * number the chain compared, and the bar it had to clear.
 *
 * The chain's word still decides: a replay is shown as the explanation only
 * where it reproduces the event's own `decidingValue` (`rowFromJudgment`).
 */
export function explainFromChain(
  spec: StrategySpec,
  window: { bucketIndex: number; priceExpo: number; candles: readonly ChainCandle[] },
): ChainReplay {
  const bucketSeconds = spec.series.bucketSeconds;
  const decimals = -window.priceExpo;
  const latestTs = window.bucketIndex * bucketSeconds;
  const atScale = (atoms: bigint): Decimal => dec(atoms, decimals);
  const { from } = replayWindow(spec, window.bucketIndex);

  const outcomes = spec.predicates.map((p): ReplayOutcome => {
    const start = gateWindowStart(p, window.bucketIndex, bucketSeconds);
    const span = window.bucketIndex - start + 1;
    const candles: Candle[] = window.candles
      .filter((c) => c.recorded && Number(c.bucket) >= start && Number(c.bucket) <= window.bucketIndex)
      .sort((a, b) => Number(a.bucket) - Number(b.bucket))
      .map((c) => ({
        bucketIndex: Number(c.bucket),
        timestamp: Number(c.bucket) * bucketSeconds,
        open: atScale(c.open),
        high: atScale(c.high),
        low: atScale(c.low),
        close: atScale(c.close),
        synthetic: false,
      }));
    const base = { predicateId: p.id, kind: p.kind, symbol: predicateSymbol(p) };
    const needed = candlesNeeded(p);
    const series: Series = { asset: spec.series.asset, bucketSeconds, candles };
    try {
      if (candles.length < needed) throw new Error("short");
      const r = evaluatePredicate(series, p, { scanFrom: latestTs });
      if (r.at !== latestTs) throw new Error("not decided on the judged bucket");
      return { ...base, status: "decided", satisfied: r.satisfied, decidingValue: r.decidingValue, referenceValue: r.referenceValue, at: r.at };
    } catch {
      return {
        ...base,
        status: "could_not_evaluate",
        needed,
        recorded: candles.length,
        span,
        message: unevaluableMessage(p, needed, candles.length, span),
      };
    }
  });
  return { bucketIndex: window.bucketIndex, priceExpo: window.priceExpo, windowFrom: from, outcomes };
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** A gate transaction that carried a verdict (`judgeOnChain`). */
export interface GateVerdict {
  verdict: "proposed" | "refused";
  txHash: `0x${string}`;
  blockNumber: bigint;
  blockTime: bigint;
  bucketIndex: number;
  signer: string;
  gasLimit: bigint;
  costWei: bigint;
  /** The spec hash the gate read from the registry, as the event's topic. */
  specHash: string;
  /** Present on a refusal. */
  symbol?: string;
  decidingValue?: bigint;
  previewDiffers: boolean;
}

/** What the off-chain arithmetic said a moment before: the setup's entry, stop and size come from it. */
export interface OffchainJudgment {
  verdict: "proposed" | "refused";
  setup: {
    direction: "long" | "short";
    asset: string;
    entry: Decimal;
    stop: Decimal;
    size: Decimal;
    equity: Decimal;
    equitySource: "account" | "paper";
    riskBps: number;
  };
  results: PredicateOutcome[];
  scan: Scan;
}

/** The `gate` object of a `trades` row (`schema.ts`). Integers past 2^53 are base-10 strings. */
export interface GateRecord {
  chainId: number;
  gate: string;
  series: string;
  chainStrategyId: string;
  txHash: string;
  blockNumber: number;
  blockTime: number;
  bucketIndex: number;
  signer: string;
  gasLimit: string;
  costWei: string;
  priceExpo?: number;
  verdict: "proposed" | "refused";
  specHash: string;
  symbol?: string;
  decidingValue?: string;
  offchainVerdict: "proposed" | "refused";
  previewDiffers?: boolean;
  couldNotEvaluate?: { predicateId: string; needed: number; recorded: number };
}

/** The symbols the gate refuses with that name no predicate. */
export const GATE_SYMBOLS = { sideMismatch: "SIDE_MISMATCH", retired: "RETIRED" } as const;

/** Every field `trades:recordEvaluation` writes for one judgment, but `autopilot` and `undoExpiresAt`. */
export interface JudgedRow<StrategyId extends string = string> {
  strategyId: StrategyId;
  direction: "long" | "short";
  asset: string;
  entry: Decimal;
  size: Decimal;
  stop: Decimal;
  status: "proposed" | "refused";
  satisfiedPredicateIds: string[];
  failedPredicateId?: string;
  failedSymbol?: string;
  failingValue?: Decimal;
  requiredValue?: Decimal;
  evidenceRefs: string[];
  results: PredicateOutcome[];
  resultsSource: "chain" | "offchain";
  specHash: string;
  scan: Scan;
  equity: Decimal;
  equitySource: "account" | "paper";
  riskBps: number;
  feed: string;
  gate: GateRecord;
}

/** The evidence pointer for a transaction: what the refusal and trade screens link to. */
export const txRef = (chainId: number, hash: string): string => `monad:${chainId}/tx/${hash}`;

const outcomeRow = (o: Extract<ReplayOutcome, { status: "decided" }>): PredicateOutcome => ({
  predicateId: o.predicateId,
  kind: o.kind,
  symbol: o.symbol,
  satisfied: o.satisfied,
  decidingValue: o.decidingValue,
  referenceValue: o.referenceValue,
  at: o.at,
});

/**
 * The `trades` row for a gate transaction. The status is the chain's verdict.
 * The entry, stop and size are the off-chain setup's (the gate judges a rule,
 * not a price to trade at). The predicate outcomes are the replay over the
 * chain's candles when there is one, and the off-chain ones otherwise, and
 * `resultsSource` says which.
 *
 * A refusal names the predicate the event names. The number that failed and
 * the bar it missed are shown only when the replay reproduces the event's
 * `decidingValue` exactly; a predicate the window could not hold is stated as
 * that (`couldNotEvaluate`), never as a failing value of 0.
 */
export function rowFromJudgment<StrategyId extends string>(input: {
  strategy: { _id: StrategyId; specHash: string };
  spec: StrategySpec;
  target: GateTarget;
  offchain: OffchainJudgment;
  judgment: GateVerdict;
  replay: ChainReplay | null;
}): JudgedRow<StrategyId> {
  const { spec, target, offchain, judgment, replay } = input;
  const bucketSeconds = spec.series.bucketSeconds;
  const decided = (replay?.outcomes ?? []).filter((o): o is Extract<ReplayOutcome, { status: "decided" }> => o.status === "decided");
  const results = replay ? decided.map(outcomeRow) : offchain.results;
  const outcomeOf = (id: string) => replay?.outcomes.find((o) => o.predicateId === id);

  const gate: GateRecord = {
    chainId: target.chainId,
    gate: target.gate,
    series: target.series,
    chainStrategyId: target.chainStrategyId.toString(),
    txHash: judgment.txHash,
    blockNumber: Number(judgment.blockNumber),
    blockTime: Number(judgment.blockTime),
    bucketIndex: judgment.bucketIndex,
    signer: judgment.signer,
    gasLimit: judgment.gasLimit.toString(),
    costWei: judgment.costWei.toString(),
    ...(replay ? { priceExpo: replay.priceExpo } : {}),
    verdict: judgment.verdict,
    specHash: judgment.specHash,
    ...(judgment.symbol !== undefined ? { symbol: judgment.symbol } : {}),
    ...(judgment.decidingValue !== undefined ? { decidingValue: judgment.decidingValue.toString() } : {}),
    offchainVerdict: offchain.verdict,
    ...(judgment.previewDiffers ? { previewDiffers: true } : {}),
  };

  const row: JudgedRow<StrategyId> = {
    strategyId: input.strategy._id,
    direction: offchain.setup.direction,
    asset: offchain.setup.asset,
    entry: offchain.setup.entry,
    size: offchain.setup.size,
    stop: offchain.setup.stop,
    status: judgment.verdict,
    satisfiedPredicateIds:
      judgment.verdict === "proposed"
        ? spec.predicates.map((p) => p.id)
        : results.filter((r) => r.satisfied).map((r) => r.predicateId),
    evidenceRefs: [
      txRef(target.chainId, judgment.txHash),
      ...results.map((r) => `${spec.series.feed}#${bucketSeconds}s@${r.at}`),
    ],
    results,
    resultsSource: replay ? "chain" : "offchain",
    specHash: input.strategy.specHash,
    scan: replay
      ? { from: replay.windowFrom * bucketSeconds, to: replay.bucketIndex * bucketSeconds, asOf: offchain.scan.asOf }
      : offchain.scan,
    equity: offchain.setup.equity,
    equitySource: offchain.setup.equitySource,
    riskBps: offchain.setup.riskBps,
    feed: spec.series.feed,
    gate,
  };
  if (judgment.verdict === "proposed") return row;

  const symbol = judgment.symbol ?? "";
  const value = judgment.decidingValue ?? 0n;
  row.failedSymbol = symbol;
  if (symbol === GATE_SYMBOLS.sideMismatch || symbol === GATE_SYMBOLS.retired) return row;

  const named = spec.predicates.filter((p) => predicateSymbol(p) === symbol);
  const failed =
    named.find((p) => {
      const o = outcomeOf(p.id);
      return o !== undefined && !(o.status === "decided" && o.satisfied);
    }) ?? named[0];
  if (!failed) return row;
  row.failedPredicateId = failed.id;

  const o = outcomeOf(failed.id);
  if (o?.status === "decided" && BigInt(o.decidingValue.atoms) === value) {
    row.failingValue = o.decidingValue;
    row.requiredValue = o.referenceValue;
    return row;
  }
  if (o?.status === "could_not_evaluate" && value === 0n) {
    gate.couldNotEvaluate = { predicateId: failed.id, needed: o.needed, recorded: o.recorded };
    return row;
  }
  // The replay is missing or says something else: the event's own number, at the scale it was compared at.
  if (failed.kind === "fair_value_gap") row.failingValue = dec(value, 0);
  else if (replay && value !== 0n) row.failingValue = dec(value, -replay.priceExpo);
  return row;
}
