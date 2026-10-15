import { makeFunctionReference } from "convex/server";
import type { ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { StrategySpec } from "@kanon/spec";
import {
  createPythSource,
  createViemGatePort,
  evaluateOnChainCall,
  type CandleWindow,
  type GatePort,
  type GateQuestion,
  type PreviewAnswer,
  type PriceSource,
} from "./gatePort";
import {
  GATE_MESSAGES,
  MAX_GAS_PROBES,
  boundaryWaitSeconds,
  bucketOf,
  decodeGateReceipt,
  eventMatchesPreview,
  explainFromChain,
  firstGateGasLimit,
  gateRevert,
  nextGateGasLimit,
  probeGas,
  replayWindow,
  samePreview,
  toRpcReceipt,
  type ChainReplay,
  type GateTarget,
  type GateUnavailableReason,
  type GateVerdict,
} from "./gateLogic";
import {
  BUCKET_SECONDS,
  formatMon,
  isNonceError,
  runKeeperTick,
  gateDailySpendWei,
  sendGuard,
  sentence,
  type PauseReason,
  type SpendLimits,
} from "./keeperLogic";
import { describeEnvProblem, parseGateEnv, parseKeeperSwitch, parseSignerEnv, type Env, type GateEnv } from "./serverEnv";

/**
 * Asking the gate: one `RefusalGate.evaluateOnChain` transaction, signed by
 * Kanon's key, per judgment. `judgeOnChain` is the whole of it, in this order:
 *
 *   1. Boundary guard. With fewer than 12 s left in the bucket, wait for the
 *      next: the transaction must land in the bucket that was made fresh.
 *   2. `ensureSeriesFresh`: the bucket the chain is in now must be recorded,
 *      or the gate reverts `StaleSeries`. If it is not, the keeper's own pass
 *      samples it, under the same lease.
 *   3. `previewOnChain`, unbounded: the truth. A revert means no transaction.
 *   4. The gas probe: the preview again at the limit less a margin, which must
 *      say exactly what the truth said. Otherwise the limit grows, for at most
 *      four probes, and then the judgment is given up as `gas_cap`. Monad bills
 *      the limit, so it is kept tight; the gate's try/catch turns an
 *      evaluation that runs out of gas into a refusal, so a tight limit is only
 *      used once it is shown not to change the answer.
 *   5. Send. 6. Wait for the receipt. 7. Read the verdict from the gate's own
 *      event. 8. Note whether it differs from the preview.
 *
 * Everything is spent under the signer's lease (`keeperData.ts`), so the
 * keeper and a judgment never race for the nonce, and every wei is added to
 * the day's count that caps the signer, keeper and gate together. Nothing here
 * decides a verdict: the event does.
 *
 * The functions take a `GatePort`, so `gate.test.ts` runs them against a chain
 * held in memory. `gateSetup` and `convexLease` at the bottom are the Convex
 * side: the real port from the deployment's env, and the lease as mutations.
 */

const keeperStateRef = makeFunctionReference<"query", Record<string, never>, Doc<"keeper"> | null>("keeperData:state");
const acquireRef = makeFunctionReference<"mutation", { holder: string }, { ok: boolean; leaseUntil: number }>(
  "keeperData:acquire",
);
const releaseRef = makeFunctionReference<"mutation", { holder: string; spentWei: string }, null>("keeperData:release");

/** How long a judgment waits for the signer before it says `busy`. */
export const LEASE_WAIT_MS = 30_000;
const LEASE_POLL_MS = 2_000;
/** The longest a judgment waits for the series' cadence to let it record the new bucket. */
export const MAX_CADENCE_WAIT_SECONDS = 65;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The signer's lease, as `keeperData:acquire` and `keeperData:release` hold it. */
export interface SignerLease {
  acquire(): Promise<{ ok: boolean; leaseUntil: number }>;
  release(spentWei: bigint): Promise<void>;
}

/** What has been spent under one lease: every wei the chain can bill, a lost receipt included. */
export interface Books {
  spent: bigint;
}

type Log = (level: "info" | "warn" | "error", line: string) => void;

export type Unavailable = {
  ok: false;
  reason: GateUnavailableReason | "send_failed";
  message: string;
  /** Whether asking again a minute later can give another answer. */
  retryable: boolean;
  /** A transaction that was sent and carries no verdict: the evidence of what was spent. */
  txHash?: `0x${string}`;
};

const PAUSED: Record<Extract<PauseReason, "signer_unfunded" | "fee_too_high" | "daily_cap">, Unavailable> = {
  signer_unfunded: { ok: false, reason: "signer_unfunded", message: GATE_MESSAGES.signer_unfunded, retryable: false },
  fee_too_high: { ok: false, reason: "fee_too_high", message: GATE_MESSAGES.fee_too_high, retryable: true },
  daily_cap: { ok: false, reason: "daily_cap", message: GATE_MESSAGES.daily_cap, retryable: false },
};

const paused = (reason: PauseReason): Unavailable =>
  reason === "signer_unfunded" || reason === "fee_too_high" || reason === "daily_cap"
    ? PAUSED[reason]
    : { ok: false, reason: "signer_not_configured", message: GATE_MESSAGES.signer_not_configured, retryable: false };

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

/**
 * Runs `fn` holding the signer. Waits up to `LEASE_WAIT_MS` for whoever holds
 * it now (most often a keeper tick a few seconds into its samples), then gives
 * up. The lease is released, with what `fn` spent, however `fn` ends.
 */
export async function withSignerLease<T>(
  lease: SignerLease,
  clock: Clock,
  fn: (books: Books, renew: () => Promise<boolean>) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const deadline = clock.now() + LEASE_WAIT_MS;
  for (;;) {
    if ((await lease.acquire()).ok) break;
    const left = deadline - clock.now();
    if (left <= 0) return { ok: false };
    await clock.sleep(Math.min(LEASE_POLL_MS, left));
  }
  const books: Books = { spent: 0n };
  try {
    return { ok: true, value: await fn(books, async () => (await lease.acquire()).ok) };
  } finally {
    await lease.release(books.spent);
  }
}

// ---------------------------------------------------------------------------
// A fresh bucket
// ---------------------------------------------------------------------------

export type KeeperLimits = SpendLimits & { keeperMaxGas: bigint; gateMaxGas: bigint; maxSourceAgeSeconds: bigint };

export interface FreshInput {
  port: GatePort;
  source: PriceSource;
  feed: string;
  series: `0x${string}`;
  mockPyth: `0x${string}`;
  limits: KeeperLimits;
  /** Spent today before this lease was taken. */
  spentTodayWei: bigint;
  books: Books;
  clock: Clock;
  log?: Log;
  secrets?: readonly string[];
}

/**
 * Makes sure the series has recorded the bucket the chain is in now. If it has
 * not, the keeper's own pass (`runKeeperTick`) samples it, with its own guards,
 * and what it spends is booked under this lease. A series that sampled less
 * than its cadence ago (late in the bucket before) cannot record yet: that is
 * waited out once, if it is a minute or so.
 */
export async function ensureSeriesFresh(input: FreshInput): Promise<{ ok: true; bucket: bigint } | Unavailable> {
  const { port, feed, series, books, clock } = input;
  for (let round = 0; round < 3; round++) {
    const now = await port.blockTime();
    const bucket = now / BUCKET_SECONDS;
    if ((await port.getCandle(series, bucket)).recorded) return { ok: true, bucket };
    if (round === 2) break;

    const report = await runKeeperTick({
      port,
      source: input.source,
      feeds: [feed],
      series: { [feed]: series },
      mockPyth: input.mockPyth,
      limits: { ...input.limits, maxGas: input.limits.keeperMaxGas },
      spentTodayWei: input.spentTodayWei + books.spent,
      // The lease is already held: the keeper's pass runs inside it, and books what it spent here.
      lease: {
        acquire: async () => true,
        release: async (spent) => {
          books.spent += spent;
        },
      },
      ...(input.log ? { log: input.log } : {}),
      ...(input.secrets ? { secrets: input.secrets } : {}),
    });
    if (report.paused) return paused(report.paused);
    if (report.sourceRefused?.includes(feed)) {
      return { ok: false, reason: "source_stale", message: GATE_MESSAGES.source_stale, retryable: true };
    }
    if (report.errors.length > 0) {
      return { ok: false, reason: "series_not_fresh", message: GATE_MESSAGES.series_not_fresh, retryable: true };
    }
    if (report.sampled.some((s) => s.feed === feed && report.bucket !== null && s.bucket >= report.bucket)) continue;

    // Nothing sampled and nothing wrong: the series' cadence has not run since its last sample.
    const [last, cadence, t] = await Promise.all([port.lastSampleTimestamp(series), port.cadenceSeconds(series), port.blockTime()]);
    const wait = Number(last + cadence - t);
    if (wait > MAX_CADENCE_WAIT_SECONDS) break;
    if (wait >= 0) await clock.sleep((wait + 1) * 1000);
  }
  return { ok: false, reason: "series_not_fresh", message: GATE_MESSAGES.series_not_fresh, retryable: true };
}

// ---------------------------------------------------------------------------
// The judgment
// ---------------------------------------------------------------------------

export interface JudgeInput {
  port: GatePort;
  source: PriceSource;
  target: GateTarget;
  mockPyth: `0x${string}`;
  limits: KeeperLimits;
  /** Spent today before this judgment (`keeperLogic.spentToday` of the keeper row). */
  spentTodayWei: bigint;
  lease: SignerLease;
  clock: Clock;
  log?: Log;
  /** Blanked from every error sentence. */
  secrets?: readonly string[];
}

export type Judgment = ({ ok: true; preview: PreviewAnswer } & GateVerdict) | Unavailable;

/** One judgment on the gate, in the order the module comment gives. Never a verdict without a transaction. */
export async function judgeOnChain(input: JudgeInput): Promise<Judgment> {
  const { port, target, limits, clock } = input;
  const log: Log = input.log ?? (() => undefined);
  const secrets = input.secrets ?? [];
  const signer = port.signer;
  if (!signer) return { ok: false, reason: "signer_not_configured", message: GATE_MESSAGES.signer_not_configured, retryable: false };

  // The gate spends inside the cap less the keeper's reserve; sampling (step 2) keeps the whole cap.
  const gateLimits = { ...limits, dailySpendWei: gateDailySpendWei(limits) };
  const question: GateQuestion = { strategyId: target.chainStrategyId, isLong: target.isLong, predicates: target.predicates };
  const call = evaluateOnChainCall(target.gate, question);

  const held = await withSignerLease(input.lease, clock, async (books, renew): Promise<Judgment> => {
    for (let round = 0; ; round++) {
      // 1. Not on the boundary.
      const wait = boundaryWaitSeconds(await port.blockTime());
      if (wait > 0) {
        await clock.sleep(wait * 1000);
        await renew();
      }

      // 2. The bucket the transaction will land in is recorded.
      const fresh = await ensureSeriesFresh({
        port,
        source: input.source,
        feed: target.feed,
        series: target.series,
        mockPyth: input.mockPyth,
        limits,
        spentTodayWei: input.spentTodayWei,
        books,
        clock,
        log,
        secrets,
      });
      if (!fresh.ok) return fresh;
      await renew();

      // 3. The truth, with no gas limit to bend it.
      const truth = await port.previewOnChain(target.gate, question);
      if (truth.kind === "revert") return { ok: false, ...gateRevert(truth.error) };

      const [balance, gasPrice] = await Promise.all([port.balance(), port.gasPrice()]);
      const now = { balanceWei: balance, gasPriceWei: gasPrice, spentTodayWei: input.spentTodayWei + books.spent };
      const before = sendGuard(gateLimits, now);
      if (before) return paused(before);

      // 4. A limit that gives the same answer.
      let estimate: bigint;
      try {
        estimate = await port.estimateGas(call);
      } catch (e) {
        return {
          ok: false,
          reason: "gate_reverted",
          message: `The gate could not be asked for a gas estimate (${sentence(e, secrets)}). Nothing was sent.`,
          retryable: true,
        };
      }
      let limit = firstGateGasLimit(estimate, limits.gateMaxGas);
      let fits = false;
      for (let probe = 1; limit !== null; probe++) {
        if (samePreview(await port.previewOnChain(target.gate, question, probeGas(limit)), truth)) {
          fits = true;
          break;
        }
        log("warn", `gate: strategy ${target.chainStrategyId} answers differently under ${limit} gas; raising the limit`);
        if (probe >= MAX_GAS_PROBES) break;
        limit = nextGateGasLimit(limit, limits.gateMaxGas);
      }
      if (!fits || limit === null) return { ok: false, reason: "gas_cap", message: GATE_MESSAGES.gas_cap, retryable: false };

      // Still well inside the bucket: the probes take a few seconds. Otherwise start over in the next one, once.
      if (round === 0 && boundaryWaitSeconds(await port.blockTime()) > 0) continue;

      const stop = sendGuard(gateLimits, now, limit);
      if (stop) return paused(stop);

      // 5. Send. A nonce error is tried once more: the port fetches the nonce afresh.
      let hash: `0x${string}` | undefined;
      for (let attempt = 1; hash === undefined; attempt++) {
        try {
          hash = await port.send(call, { gas: limit, maxFeePerGas: limits.maxFeePerGasWei });
        } catch (e) {
          if (attempt === 1 && isNonceError(e)) continue;
          return {
            ok: false,
            reason: "send_failed",
            message: `The gate transaction could not be sent (${sentence(e, secrets)}). Nothing was spent.`,
            retryable: true,
          };
        }
      }

      // 6. The receipt. Unconfirmed is not unspent: the most it can cost is counted.
      let receipt;
      try {
        receipt = await port.waitForReceipt(hash);
      } catch {
        books.spent += limit * limits.maxFeePerGasWei;
        return { ok: false, reason: "unconfirmed", message: GATE_MESSAGES.unconfirmed(hash), retryable: false, txHash: hash };
      }
      // Monad bills the limit: gasUsed equals gas on its receipts.
      const costWei = limit * receipt.effectiveGasPrice;
      books.spent += costWei;
      log("info", `gate: strategy ${target.chainStrategyId} ${hash} cost ${formatMon(costWei, 6)} MON at ${limit} gas`);
      if (receipt.status !== "success") {
        return { ok: false, reason: "reverted", message: GATE_MESSAGES.reverted(hash), retryable: true, txHash: hash };
      }

      // 7. The gate's own word.
      const event = decodeGateReceipt({
        receipt: toRpcReceipt(receipt),
        gateAddress: target.gate,
        chainStrategyId: target.chainStrategyId,
        signer,
      });
      if (!event.ok) return { ok: false, reason: "unreadable", message: GATE_MESSAGES.unreadable(hash), retryable: false, txHash: hash };
      const blockTime = await port.blockTimeAt(receipt.blockNumber).catch(() => port.blockTime());

      // 8. The preview is kept beside the verdict, and a difference is said, never resolved.
      return {
        ok: true,
        verdict: event.verdict,
        txHash: hash,
        blockNumber: receipt.blockNumber,
        blockTime,
        bucketIndex: bucketOf(blockTime),
        signer,
        gasLimit: limit,
        costWei,
        specHash: event.specHash,
        ...(event.verdict === "refused" ? { symbol: event.symbol, decidingValue: event.decidingValue } : {}),
        previewDiffers: !eventMatchesPreview(event, truth),
        preview: truth,
      };
    }
  });
  if (!held.ok) return { ok: false, reason: "busy", message: GATE_MESSAGES.busy, retryable: true };
  return held.value;
}

/**
 * The verdict's explanation: the gate's window read in one multicall at the
 * block the verdict was mined in (the latest block if the node no longer
 * serves that one), and replayed (`explainFromChain`). Null when the window
 * cannot be read at all; the row then says its outcomes are off-chain.
 */
export async function readReplay(
  port: GatePort,
  spec: StrategySpec,
  target: Pick<GateTarget, "series">,
  judgment: Pick<GateVerdict, "bucketIndex" | "blockNumber">,
): Promise<ChainReplay | null> {
  const { from, to } = replayWindow(spec, judgment.bucketIndex);
  let window: CandleWindow;
  try {
    window = await port.readCandles(target.series, BigInt(from), BigInt(to), judgment.blockNumber);
  } catch {
    try {
      window = await port.readCandles(target.series, BigInt(from), BigInt(to));
    } catch {
      return null;
    }
  }
  return explainFromChain(spec, { bucketIndex: judgment.bucketIndex, priceExpo: window.priceExpo, candles: window.candles });
}

// ---------------------------------------------------------------------------
// The Convex side
// ---------------------------------------------------------------------------

export type GateSetup =
  | {
      ok: true;
      env: GateEnv;
      port: GatePort;
      source: PriceSource;
      limits: KeeperLimits;
      secrets: string[];
    }
  | Unavailable;

/**
 * The real port and limits from the deployment's env. The gate signs with the
 * keeper's key and under the keeper's switch: with `KEEPER_ENABLED` off, or a
 * variable missing, nothing is asked and nothing is spent.
 */
export function gateSetup(env: Env): GateSetup {
  const on = parseKeeperSwitch(env);
  const signer = parseSignerEnv(env);
  const gate = parseGateEnv(env);
  if (!on.ok || !signer.ok || !gate.ok) {
    const invalid = [...(on.ok ? [] : on.invalid), ...(signer.ok ? [] : signer.invalid), ...(gate.ok ? [] : gate.invalid)];
    console.error(describeEnvProblem("gate", invalid));
    return { ok: false, reason: "signer_not_configured", message: GATE_MESSAGES.signer_not_configured, retryable: false };
  }
  if (!on.value) return { ok: false, reason: "signer_not_configured", message: GATE_MESSAGES.signer_off, retryable: false };
  const { privateKey, ...spend } = signer.value;
  return {
    ok: true,
    env: gate.value,
    port: createViemGatePort(gate.value, privateKey),
    source: createPythSource(gate.value.sourceRpcUrl),
    limits: {
      ...spend,
      keeperMaxGas: gate.value.keeperMaxGas,
      gateMaxGas: gate.value.gateMaxGas,
      maxSourceAgeSeconds: gate.value.maxSourceAgeSeconds,
    },
    secrets: [privateKey, gate.value.rpcUrl, gate.value.sourceRpcUrl],
  };
}

/** The lease as the keeper's own mutations hold it, under a holder name of this judgment's. */
export function convexLease(ctx: Pick<ActionCtx, "runMutation">, holder: string): SignerLease {
  return {
    acquire: async () => await ctx.runMutation(acquireRef, { holder }),
    release: async (spentWei) => {
      await ctx.runMutation(releaseRef, { holder, spentWei: spentWei.toString() });
    },
  };
}

/** The keeper row, for what the signer has spent today. */
export async function keeperRow(ctx: Pick<ActionCtx, "runQuery">): Promise<Doc<"keeper"> | null> {
  return await ctx.runQuery(keeperStateRef, {});
}
