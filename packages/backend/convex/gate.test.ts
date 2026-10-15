import { describe, expect, it } from "vitest";
import { stringToHex } from "viem";
import { PYTH_FEEDS, RULE_04, stated, toPredicateDefinitions, type PythPrice, type StrategySpec } from "@kanon/spec";
import { padAddress, padUint } from "./chainLogic";
import { LEASE_WAIT_MS, judgeOnChain, readReplay, type Clock, type JudgeInput, type SignerLease } from "./gate";
import { GAS_PROBE_MARGIN, GATE_TOPICS, MAX_GAS_PROBES, type GateTarget } from "./gateLogic";
import type { GateCall, GatePort, GateReceipt, PreviewAnswer, PriceSource } from "./gatePort";

/**
 * One judgment on the gate, against a chain held in memory. The fake gate
 * answers `previewOnChain` as the contract does: `StaleSeries` while the
 * bucket the chain is in is unrecorded, and a refusal with 0 when it is given
 * less gas than its evaluation needs (the try/catch). Its transaction lands in
 * the bucket of the moment it is sent. Nothing here reaches a network.
 */

const GWEI = 10n ** 9n;
const MON = 10n ** 18n;
const GATE = "0x388f55962954c5083d885543af22b1b6ee640ec0" as const;
const SERIES = "0x74c4b8710fb83dcc18c1a5ae2e35a63dc005257a" as const;
const MOCK = "0x7b0564b87edd57d7bb70550b1fba3384964862ce" as const;
const SIGNER = "0xe0072e39d6fb592bafb3c6783710c1b24ec601b4" as const;
const BTC_ID = PYTH_FEEDS["BTC/USD"]!;
const SPEC_HASH = "0x09867ee4" + "00".repeat(28);

/** 40 seconds into a 15-minute bucket. */
const T = 1_792_075_500n + 40n;
const BUCKET = T / 900n;

const spec: StrategySpec = {
  ...RULE_04,
  predicates: [{ kind: "break_of_structure", id: "p1", direction: "long", swingLookbackCandles: stated(20), timeframe: stated("15m") }],
};
const target: GateTarget = {
  chainId: 10143,
  gate: GATE,
  series: SERIES,
  feed: "BTC/USD",
  chainStrategyId: 0n,
  isLong: true,
  predicates: toPredicateDefinitions(spec),
};

const BOS = stringToHex("bos_bullish", { size: 32 });
const word = (n: bigint) => "0x" + (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, "0");

function chain() {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const state = {
    blockTime: T,
    recorded: new Set<bigint>([BUCKET]),
    lastSample: T - 30n,
    cadence: 60n,
    balance: 3n * MON,
    gasPrice: 102n * GWEI,
    estimates: { setPrice: 45_000n, recordSample: 202_000n, evaluateOnChain: 288_752n } as Record<string, bigint>,
    /** What the gate's evaluation needs; under it, the try/catch makes a refusal with 0. */
    gasNeeded: 250_000n,
    /** The verdict while the bucket is recorded: refused at 8,136,070.98 with the window not whole, 0. */
    truth: { kind: "result", allSatisfied: false, failingSymbol: BOS, decidingValue: 0n } as PreviewAnswer,
    /** What the event says, when it should say something else than the preview did. */
    eventOverride: undefined as PreviewAnswer | undefined,
    receiptStatus: "success" as "success" | "reverted",
    receiptLost: false,
    effectiveGasPrice: 102n * GWEI,
    mock: undefined as PythPrice | undefined,
    sends: [] as Array<{ fn: string; gas: bigint; bucket: bigint }>,
    receipts: new Map<string, GateReceipt>(),
    source: { price: 6_841_234_000_000n, conf: 5_123_456n, expo: -8, publishTime: T - 20n } as PythPrice,
    sourceNow: T,
    leaseFree: true,
    acquires: 0,
    released: [] as bigint[],
  };
  const bucketNow = () => state.blockTime / 900n;

  const clock: Clock = {
    now: () => Number(state.blockTime) * 1000,
    async sleep(ms) {
      sleeps.push(ms);
      state.blockTime += BigInt(Math.ceil(ms / 1000));
    },
  };

  const lease: SignerLease = {
    async acquire() {
      state.acquires += 1;
      return { ok: state.leaseFree, leaseUntil: 0 };
    },
    async release(spent) {
      state.released.push(spent);
    },
  };

  const source: PriceSource = {
    async read() {
      return { price: { ...state.source, publishTime: state.source.publishTime }, sourceNowSeconds: state.sourceNow };
    },
  };

  /** What the gate answers now, under `gas` when given. */
  const answer = (gas?: bigint): PreviewAnswer => {
    if (!state.recorded.has(bucketNow())) return { kind: "revert", error: "StaleSeries", args: [bucketNow()] };
    if (gas !== undefined && gas < state.gasNeeded && state.truth.kind === "result") {
      // Out of gas inside the try/catch: a refusal of the first predicate, with 0 (or -1 where the truth is already 0).
      return { kind: "result", allSatisfied: false, failingSymbol: BOS, decidingValue: state.truth.decidingValue === 0n ? -1n : 0n };
    }
    return state.truth;
  };

  let made = 0;
  const port: GatePort = {
    signer: SIGNER,
    async blockTime() {
      return state.blockTime;
    },
    async getCandle(_series, bucket) {
      calls.push(`getCandle ${bucket - BUCKET}`);
      const recorded = state.recorded.has(bucket);
      return { open: 1n, high: 1n, low: 1n, close: 1n, sampleCount: recorded ? 1 : 0, recorded };
    },
    async seriesFeedId() {
      return BTC_ID;
    },
    async lastSampleTimestamp() {
      return state.lastSample;
    },
    async cadenceSeconds() {
      return state.cadence;
    },
    async balance() {
      calls.push("balance");
      return state.balance;
    },
    async gasPrice() {
      calls.push("gasPrice");
      return state.gasPrice;
    },
    async estimateGas(call: GateCall) {
      calls.push(`estimate ${call.functionName}`);
      return state.estimates[call.functionName]!;
    },
    async send(call, opts) {
      calls.push(`send ${call.functionName}`);
      state.sends.push({ fn: call.functionName, gas: opts.gas, bucket: bucketNow() });
      made += 1;
      const hash = `0x${made.toString(16).padStart(64, "0")}` as `0x${string}`;
      const logs: GateReceipt["logs"] = [];
      if (call.functionName === "setPrice") {
        const [, price, conf, expo, publishTime] = call.args as [string, bigint, bigint, number, bigint];
        state.mock = { price, conf, expo, publishTime };
      }
      if (call.functionName === "recordSample") {
        state.recorded.add(state.mock!.publishTime / 900n);
        state.lastSample = state.blockTime;
      }
      let status = state.receiptStatus;
      if (call.functionName === "evaluateOnChain") {
        const said = state.eventOverride ?? answer(opts.gas - GAS_PROBE_MARGIN);
        if (said.kind === "revert") status = "reverted";
        else if (said.allSatisfied) logs.push({ address: GATE, topics: [GATE_TOPICS.proposed, padUint(0n), SPEC_HASH, padAddress(SIGNER)], data: "0x" });
        else
          logs.push({
            address: GATE,
            topics: [GATE_TOPICS.refused, padUint(0n), SPEC_HASH, padAddress(SIGNER)],
            data: "0x" + said.failingSymbol.slice(2) + word(said.decidingValue).slice(2),
          });
      } else status = "success";
      state.receipts.set(hash, { status, gasUsed: opts.gas, effectiveGasPrice: state.effectiveGasPrice, blockNumber: 48_000_000n + BigInt(made), logs });
      state.blockTime += 1n;
      return hash;
    },
    async waitForReceipt(hash) {
      calls.push("receipt");
      if (state.receiptLost) throw new Error("timed out");
      return state.receipts.get(hash)!;
    },
    async blockTimeAt() {
      calls.push("blockTimeAt");
      return state.blockTime;
    },
    async previewOnChain(_gate, _q, gas) {
      calls.push(gas === undefined ? "preview" : `preview@${gas}`);
      return answer(gas);
    },
    async readCandles(_series, from, to, blockNumber) {
      calls.push(`readCandles${blockNumber === undefined ? "" : "@block"}`);
      const candles = [];
      for (let b = from; b <= to; b++) candles.push({ bucket: b, open: 1n, high: 1n, low: 1n, close: 1n, sampleCount: 1, recorded: state.recorded.has(b) });
      return { priceExpo: -8, candles };
    },
  };

  const input = (over: Partial<JudgeInput> = {}): JudgeInput => ({
    port,
    source,
    target,
    mockPyth: MOCK,
    limits: {
      minBalanceWei: MON / 5n,
      warnBalanceWei: MON,
      maxFeePerGasWei: 250n * GWEI,
      dailySpendWei: 4n * MON,
      keeperReserveWei: (5n * MON) / 2n,
      keeperMaxGas: 400_000n,
      gateMaxGas: 2_000_000n,
      maxSourceAgeSeconds: 7_200n,
    },
    spentTodayWei: 0n,
    lease,
    clock,
    ...over,
  });
  /** The calls that matter for order: no candle reads. */
  const steps = () => calls.filter((c) => !c.startsWith("getCandle"));
  return { state, calls, steps, sleeps, port, input };
}

describe("a judgment on the gate", () => {
  it("asks in order: fresh bucket, preview, probe, send, receipt, and reads the verdict off the event", async () => {
    const c = chain();
    const out = await judgeOnChain(c.input());
    const limit = (288_752n * 110n + 99n) / 100n;
    expect(c.steps()).toEqual([
      "preview",
      "balance",
      "gasPrice",
      "estimate evaluateOnChain",
      `preview@${limit - GAS_PROBE_MARGIN}`,
      "send evaluateOnChain",
      "receipt",
      "blockTimeAt",
    ]);
    expect(out).toMatchObject({
      ok: true,
      verdict: "refused",
      symbol: "bos_bullish",
      decidingValue: 0n,
      gasLimit: limit,
      costWei: limit * 102n * GWEI,
      bucketIndex: Number(BUCKET),
      signer: SIGNER,
      specHash: SPEC_HASH,
      previewDiffers: false,
    });
    // One lease, released with what it spent.
    expect(c.state.released).toEqual([limit * 102n * GWEI]);
  });

  it("never evaluates a bucket the series has not recorded: it samples it first, under the same lease", async () => {
    const c = chain();
    c.state.recorded = new Set([BUCKET - 1n]);
    c.state.lastSample = T - 300n;
    const out = await judgeOnChain(c.input());
    expect(out).toMatchObject({ ok: true });
    expect(c.state.sends.map((s) => s.fn)).toEqual(["setPrice", "recordSample", "evaluateOnChain"]);
    // The evaluation landed in the bucket that was just recorded.
    expect(c.state.sends[2]!.bucket).toBe(BUCKET);
    expect(c.steps().indexOf("send recordSample")).toBeLessThan(c.steps().indexOf("preview"));
    expect(c.state.acquires).toBeGreaterThanOrEqual(1);
    expect(c.state.released).toHaveLength(1);
    expect(c.state.released[0]).toBe(c.state.sends.reduce((sum, s) => sum + s.gas * 102n * GWEI, 0n));
  });

  it("waits out the end of a bucket and judges the next one", async () => {
    const c = chain();
    c.state.blockTime = (BUCKET + 1n) * 900n - 5n;
    c.state.lastSample = c.state.blockTime - 120n;
    const out = await judgeOnChain(c.input());
    expect(c.sleeps[0]).toBe(7_000);
    expect(out).toMatchObject({ ok: true, bucketIndex: Number(BUCKET + 1n) });
    expect(c.state.sends.map((s) => s.fn)).toEqual(["setPrice", "recordSample", "evaluateOnChain"]);
    expect(c.state.sends.every((s) => s.bucket === BUCKET + 1n)).toBe(true);
  });

  it("waits out the series' cadence when it sampled late in the bucket before", async () => {
    const c = chain();
    c.state.recorded = new Set([BUCKET - 1n]);
    // Sampled 5 s before this bucket began, 45 s ago: the 60 s cadence lets it record again in 15 s.
    c.state.lastSample = BUCKET * 900n - 5n;
    const out = await judgeOnChain(c.input());
    expect(out).toMatchObject({ ok: true });
    expect(c.sleeps).toEqual([16_000]);
    expect(c.state.sends.map((s) => s.fn)).toEqual(["setPrice", "recordSample", "evaluateOnChain"]);
  });

  it("sends nothing when the preview reverts", async () => {
    const c = chain();
    c.state.truth = { kind: "revert", error: "CommitmentMismatch", args: [] };
    expect(await judgeOnChain(c.input())).toMatchObject({ ok: false, reason: "commitment_mismatch", retryable: false });
    expect(c.state.sends).toEqual([]);
    expect(c.state.released).toEqual([0n]);
  });

  it("grows the gas limit until the preview under it says what the truth says", async () => {
    const c = chain();
    const first = (288_752n * 110n + 99n) / 100n;
    const second = (first * 3n + 1n) / 2n;
    c.state.gasNeeded = second - GAS_PROBE_MARGIN;
    const out = await judgeOnChain(c.input());
    expect(c.steps().filter((s) => s.startsWith("preview@"))).toEqual([
      `preview@${first - GAS_PROBE_MARGIN}`,
      `preview@${second - GAS_PROBE_MARGIN}`,
    ]);
    expect(out).toMatchObject({ ok: true, gasLimit: second, decidingValue: 0n });
    expect(c.state.sends.at(-1)!.gas).toBe(second);
  });

  it("gives up as gas_cap after four probes, or at the cap, and sends nothing", async () => {
    const c = chain();
    c.state.gasNeeded = 1_900_000n;
    expect(await judgeOnChain(c.input())).toMatchObject({ ok: false, reason: "gas_cap" });
    expect(c.steps().filter((s) => s.startsWith("preview@"))).toHaveLength(MAX_GAS_PROBES);
    expect(c.state.sends).toEqual([]);

    const capped = chain();
    capped.state.gasNeeded = 400_000n;
    expect(await judgeOnChain(capped.input({ limits: { ...capped.input().limits, gateMaxGas: 350_000n } }))).toMatchObject({ ok: false, reason: "gas_cap" });
    expect(capped.state.sends).toEqual([]);
  });

  it("says busy when the signer stays held for half a minute, and sends nothing", async () => {
    const c = chain();
    c.state.leaseFree = false;
    expect(await judgeOnChain(c.input())).toMatchObject({ ok: false, reason: "busy", retryable: true });
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(LEASE_WAIT_MS);
    expect(c.state.sends).toEqual([]);
    expect(c.state.released).toEqual([]);
  });

  it("sends nothing past the daily cap, below the minimum balance, or over the fee cap", async () => {
    const capped = chain();
    expect(await judgeOnChain(capped.input({ spentTodayWei: 4n * MON }))).toMatchObject({ ok: false, reason: "daily_cap" });
    const poor = chain();
    poor.state.balance = MON / 10n;
    expect(await judgeOnChain(poor.input())).toMatchObject({ ok: false, reason: "signer_unfunded" });
    const dear = chain();
    dear.state.gasPrice = 300n * GWEI;
    expect(await judgeOnChain(dear.input())).toMatchObject({ ok: false, reason: "fee_too_high" });
    for (const c of [capped, poor, dear]) expect(c.state.sends).toEqual([]);
  });

  it("stops the gate at the cap less the keeper's reserve, and still samples a bucket inside it", async () => {
    // 1.6 MON spent: over the gate's 1.5 (4 less 2.5), well under the keeper's 4.
    const c = chain();
    c.state.recorded = new Set([BUCKET - 1n]);
    c.state.lastSample = T - 300n;
    const out = await judgeOnChain(c.input({ spentTodayWei: (16n * MON) / 10n }));
    expect(out).toMatchObject({ ok: false, reason: "daily_cap" });
    expect(c.state.sends.map((s) => s.fn)).toEqual(["setPrice", "recordSample"]);
  });

  it("says the source is stale, and sends nothing, when the mainnet price is too old to mirror", async () => {
    const c = chain();
    c.state.recorded = new Set();
    c.state.lastSample = T - 600n;
    c.state.source = { ...c.state.source, publishTime: T - 10_000n };
    expect(await judgeOnChain(c.input())).toMatchObject({ ok: false, reason: "source_stale" });
    expect(c.state.sends).toEqual([]);
  });

  it("books a reverted transaction's cost and claims no verdict from it", async () => {
    const c = chain();
    c.state.receiptStatus = "reverted";
    const out = await judgeOnChain(c.input());
    expect(out).toMatchObject({ ok: false, reason: "reverted", txHash: `0x${"1".padStart(64, "0")}` });
    expect(c.state.released[0]).toBeGreaterThan(0n);
  });

  it("books the most an unconfirmed transaction can cost, and keeps its hash", async () => {
    const c = chain();
    c.state.receiptLost = true;
    const out = await judgeOnChain(c.input());
    const limit = (288_752n * 110n + 99n) / 100n;
    expect(out).toMatchObject({ ok: false, reason: "unconfirmed", retryable: false });
    expect(c.state.released).toEqual([limit * 250n * GWEI]);
  });

  it("records the event's verdict when it differs from the preview, and says it differed", async () => {
    const c = chain();
    c.state.eventOverride = { kind: "result", allSatisfied: true, failingSymbol: `0x${"00".repeat(32)}`, decidingValue: 0n };
    expect(await judgeOnChain(c.input())).toMatchObject({ ok: true, verdict: "proposed", previewDiffers: true });
  });

  it("asks nothing without a signer", async () => {
    const c = chain();
    const port = { ...c.port, signer: undefined };
    expect(await judgeOnChain(c.input({ port }))).toMatchObject({ ok: false, reason: "signer_not_configured" });
    expect(c.state.acquires).toBe(0);
  });
});

describe("the replay read", () => {
  it("reads the gate's window at the verdict's block, then the latest, then gives up", async () => {
    const c = chain();
    const replay = await readReplay(c.port, spec, target, { bucketIndex: Number(BUCKET), blockNumber: 48_000_001n });
    expect(c.calls.filter((x) => x.startsWith("readCandles"))).toEqual(["readCandles@block"]);
    expect(replay?.outcomes[0]).toMatchObject({ status: "could_not_evaluate", needed: 21, recorded: 1 });

    const flaky = chain();
    let failures = 1;
    const port: GatePort = {
      ...flaky.port,
      readCandles: async (...args) => {
        if (failures-- > 0) throw new Error("missing trie node");
        return flaky.port.readCandles(args[0], args[1], args[2]);
      },
    };
    expect(await readReplay(port, spec, target, { bucketIndex: Number(BUCKET), blockNumber: 1n })).not.toBeNull();
    const dead: GatePort = { ...flaky.port, readCandles: async () => Promise.reject(new Error("down")) };
    expect(await readReplay(dead, spec, target, { bucketIndex: Number(BUCKET), blockNumber: 1n })).toBeNull();
  });
});
