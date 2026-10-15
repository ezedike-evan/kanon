import { describe, expect, it } from "vitest";
import { stringToHex, toEventSelector } from "viem";
import {
  RULE_04,
  dec,
  predicatesCommitment,
  stated,
  toPredicateDefinitions,
  type StrategySpec,
} from "@kanon/spec";
import { padAddress, padUint, type RpcLog, type RpcReceipt } from "./chainLogic";
import {
  BOUNDARY_GUARD_SECONDS,
  GAS_PROBE_MARGIN,
  GATE_TOPICS,
  NOT_ELIGIBLE,
  boundaryWaitSeconds,
  bucketOf,
  bytes32Text,
  decodeGateReceipt,
  eventMatchesPreview,
  explainFromChain,
  firstGateGasLimit,
  gateEligibility,
  gateRevert,
  gateWindowStart,
  int256,
  nextGateGasLimit,
  probeGas,
  replayWindow,
  rowFromJudgment,
  samePreview,
  type ChainCandle,
  type GateTarget,
  type GateVerdict,
  type OffchainJudgment,
} from "./gateLogic";
import { gateAbi } from "./gatePort";

/**
 * The gate's pure half: whether a rule can be asked, what a revert means, the
 * gas probe's arithmetic, reading a verdict off a receipt, and the replay that
 * explains it. Events are built here word by word, as the gate ABI-encodes
 * them, so a change to an event's shape fails the topic check first.
 */

const GATE = "0x388f55962954c5083d885543af22b1b6ee640ec0" as const;
const ELSEWHERE = "0x00000000000000000000000000000000000000bb";
const SIGNER = "0xe0072e39d6fb592bafb3c6783710c1b24ec601b4";
const OTHER = "0x6dbc945f04ed92c244ff9b7758706528a3d7e488";
const SERIES = "0x74c4b8710fb83dcc18c1a5ae2e35a63dc005257a" as const;
const REGISTRY = "0xdb91f547b59a3326f3db8e8f510e8dbbf4e50852";
const SPEC_HASH = "0x09867ee4" + "00".repeat(28);

const word = (n: bigint): string => "0x" + (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, "0");
const symbolWord = (s: string) => stringToHex(s, { size: 32 });
const data = (...words: string[]) => "0x" + words.map((w) => w.slice(2)).join("");

const proposedLog = (o: { address?: string; id?: bigint; proposer?: string } = {}): RpcLog => ({
  address: o.address ?? GATE,
  topics: [GATE_TOPICS.proposed, padUint(o.id ?? 0n), SPEC_HASH, padAddress(o.proposer ?? SIGNER)],
  data: "0x",
});
const refusedLog = (o: { address?: string; id?: bigint; symbol?: string; value?: bigint; proposer?: string } = {}): RpcLog => ({
  address: o.address ?? GATE,
  topics: [GATE_TOPICS.refused, padUint(o.id ?? 0n), SPEC_HASH, padAddress(o.proposer ?? SIGNER)],
  data: data(symbolWord(o.symbol ?? "bos_bullish"), word(o.value ?? 0n)),
});
const receipt = (logs: RpcLog[], over: Partial<RpcReceipt> = {}): RpcReceipt => ({ status: "0x1", to: GATE, logs, ...over });
const decode = (r: RpcReceipt | null, id = 0n) => decodeGateReceipt({ receipt: r, gateAddress: GATE, chainStrategyId: id, signer: SIGNER });

/** Strategy 0 as it is pinned: a break of structure over 20 candles on 15m, long. */
const bos = (lookback: number): StrategySpec => ({
  ...RULE_04,
  predicates: [{ kind: "break_of_structure", id: "p1", direction: "long", swingLookbackCandles: stated(lookback), timeframe: stated("15m") }],
});

describe("the gate's events", () => {
  it("are pinned to the topics the contract emits", () => {
    expect(GATE_TOPICS.proposed).toBe(toEventSelector("TradeProposed(uint256,bytes32,address)"));
    expect(GATE_TOPICS.refused).toBe(toEventSelector("TradeRefused(uint256,bytes32,address,bytes32,int256)"));
    // And to the ABI the port sends with.
    const events = gateAbi.filter((x) => x.type === "event");
    expect(events.map((e) => toEventSelector(e))).toEqual([GATE_TOPICS.proposed, GATE_TOPICS.refused]);
  });

  it("read a pass off the gate's own log", () => {
    expect(decode(receipt([proposedLog()]))).toEqual({ ok: true, verdict: "proposed", specHash: SPEC_HASH });
  });

  it("read a refusal with its symbol and its number, a negative one included", () => {
    expect(decode(receipt([refusedLog({ value: 8_136_070_983_417n })]))).toMatchObject({
      ok: true,
      verdict: "refused",
      symbol: "bos_bullish",
      decidingValue: 8_136_070_983_417n,
    });
    // Two's complement: Solidity writes -42 as 2^256 - 42.
    expect(decode(receipt([refusedLog({ symbol: "fvg_present", value: -42n })]))).toMatchObject({ symbol: "fvg_present", decidingValue: -42n });
    expect(int256(word(-1n))).toBe(-1n);
    expect(int256(word((1n << 255n) - 1n))).toBe((1n << 255n) - 1n);
    expect(int256(word(-(1n << 255n)))).toBe(-(1n << 255n));
  });

  it("read the gate's own refusals that name no predicate", () => {
    // The rule authorizes longs only: SIDE_MISMATCH with 1.
    expect(decode(receipt([refusedLog({ symbol: "SIDE_MISMATCH", value: 1n })]))).toMatchObject({ symbol: "SIDE_MISMATCH", decidingValue: 1n });
    expect(decode(receipt([refusedLog({ symbol: "RETIRED", value: 0n })]))).toMatchObject({ symbol: "RETIRED", decidingValue: 0n });
  });

  it("decode a symbol as text only when it is printable, as the indexer does", () => {
    expect(bytes32Text(symbolWord("sweep_prev_day_low"))).toBe("sweep_prev_day_low");
    expect(bytes32Text("0x" + "00".repeat(32))).toBe("");
    const binary = "0x01" + "00".repeat(31);
    expect(bytes32Text(binary)).toBe(binary);
  });

  it("are not taken from another address, another strategy or another proposer", () => {
    const none = { ok: false, reason: "No verdict from the gate for this rule was found in that transaction." };
    expect(decode(receipt([refusedLog({ address: ELSEWHERE })]))).toEqual(none);
    expect(decode(receipt([proposedLog({ address: ELSEWHERE })]))).toEqual(none);
    expect(decode(receipt([refusedLog({ id: 1n })]))).toEqual(none);
    expect(decode(receipt([proposedLog({ proposer: OTHER })]))).toEqual(none);
    // The gate's own log among others is found.
    expect(decode(receipt([proposedLog({ address: ELSEWHERE }), refusedLog({ value: 7n })]))).toMatchObject({ verdict: "refused", decidingValue: 7n });
  });

  it("are no verdict when the transaction failed, is missing, carries both, or is malformed", () => {
    expect(decode(null)).toEqual({ ok: false, reason: "The transaction is not confirmed yet." });
    expect(decode(receipt([refusedLog()], { status: "0x0" }))).toEqual({ ok: false, reason: "The transaction did not succeed." });
    expect(decode(receipt([proposedLog(), refusedLog()]))).toMatchObject({ ok: false });
    expect(decode(receipt([refusedLog(), refusedLog()]))).toMatchObject({ ok: false });
    expect(decode(receipt([{ ...refusedLog(), data: "0x1234" }]))).toEqual({ ok: false, reason: "The gate's log is malformed." });
  });

  it("are compared with the preview: the event decides, a difference is noted", () => {
    const refused = { ok: true as const, verdict: "refused" as const, specHash: SPEC_HASH, symbol: "bos_bullish", symbolRaw: symbolWord("bos_bullish"), decidingValue: 5n };
    const said = { kind: "result" as const, allSatisfied: false, failingSymbol: symbolWord("bos_bullish"), decidingValue: 5n };
    expect(eventMatchesPreview(refused, said)).toBe(true);
    expect(eventMatchesPreview(refused, { ...said, decidingValue: 6n })).toBe(false);
    expect(eventMatchesPreview({ ok: true, verdict: "proposed", specHash: SPEC_HASH }, said)).toBe(false);
    expect(eventMatchesPreview({ ok: true, verdict: "proposed", specHash: SPEC_HASH }, { ...said, allSatisfied: true })).toBe(true);
  });
});

describe("when the gate is asked", () => {
  it("waits out the end of a bucket, into the next one", () => {
    const start = 1_792_075_500n;
    expect(Number(start % 900n)).toBe(0);
    expect(boundaryWaitSeconds(start)).toBe(0);
    expect(boundaryWaitSeconds(start + 900n - BigInt(BOUNDARY_GUARD_SECONDS))).toBe(0);
    // 11 s left: wait them, and two more.
    expect(boundaryWaitSeconds(start + 889n)).toBe(13);
    expect(boundaryWaitSeconds(start + 899n)).toBe(3);
    expect(bucketOf(start + 899n)).toBe(Number(start / 900n));
  });
});

describe("whether a rule can be asked", () => {
  const env = { chainId: 10143, registryAddress: REGISTRY, gateAddress: GATE, series: { "BTC/USD": SERIES } };
  const spec = bos(20);
  const pinned = {
    pinVerified: true,
    chainId: 10143,
    registryAddress: REGISTRY.toUpperCase().replace("0X", "0x"),
    chainStrategyId: "0",
    predicatesCommitment: predicatesCommitment(spec),
    seriesAddress: SERIES.toUpperCase().replace("0X", "0x"),
  };

  it("asks strategy 0 with exactly what was pinned", () => {
    const out = gateEligibility(pinned, spec, env);
    expect(out).toEqual({
      ok: true,
      target: {
        chainId: 10143,
        gate: GATE,
        series: SERIES,
        feed: "BTC/USD",
        chainStrategyId: 0n,
        isLong: true,
        predicates: toPredicateDefinitions(spec),
      },
    });
    // The commitment the live registry holds for strategy 0.
    expect(predicatesCommitment(spec)).toBe("0x8edb6e5b3794b467f2d6b2e896f896971e32086e3cfa301766b3c39bada3fbdb");
  });

  it("asks nothing for a rule the gate cannot judge, and says why", () => {
    const hourly: StrategySpec = {
      ...spec,
      series: { ...spec.series, bucketSeconds: 3600 },
      predicates: spec.predicates.map((p) => ({ ...p, timeframe: stated("1h" as const) })),
    };
    expect(gateEligibility(pinned, hourly, env)).toEqual({ ok: false, message: NOT_ELIGIBLE.timeframe("1h") });
    expect(gateEligibility({ ...pinned, pinVerified: undefined }, spec, env)).toEqual({ ok: false, message: NOT_ELIGIBLE.unverified });
    expect(gateEligibility({ ...pinned, chainStrategyId: undefined }, spec, env)).toEqual({ ok: false, message: NOT_ELIGIBLE.noRegistryId });
    expect(gateEligibility({ ...pinned, chainId: 1 }, spec, env)).toEqual({ ok: false, message: NOT_ELIGIBLE.foreignChain });
    expect(gateEligibility({ ...pinned, registryAddress: ELSEWHERE }, spec, env)).toEqual({ ok: false, message: NOT_ELIGIBLE.foreignChain });
    expect(gateEligibility({ ...pinned, seriesAddress: ELSEWHERE }, spec, env)).toEqual({ ok: false, message: NOT_ELIGIBLE.series });
    expect(gateEligibility(pinned, bos(21), env)).toEqual({ ok: false, message: NOT_ELIGIBLE.commitment });
  });
});

describe("a revert of the preview", () => {
  it("is a reason and a sentence, and sends nothing", () => {
    expect(gateRevert("StaleSeries")).toMatchObject({ reason: "stale_series", retryable: true });
    expect(gateRevert("CommitmentMismatch")).toMatchObject({ reason: "commitment_mismatch", retryable: false });
    expect(gateRevert("TimeframeMismatch")).toMatchObject({ reason: "timeframe_mismatch", retryable: false });
    expect(gateRevert("UnknownStrategy")).toMatchObject({ reason: "unknown_strategy", retryable: false });
    expect(gateRevert("MixedDirections").message).toMatch(/mix long and short/);
    expect(gateRevert("Whatever")).toMatchObject({ reason: "gate_reverted", retryable: false });
    for (const name of ["StaleSeries", "CommitmentMismatch", "TimeframeMismatch", "UnknownStrategy", "NoPredicates", "Whatever"]) {
      expect(gateRevert(name).message).toMatch(/Nothing was sent\.$/);
    }
  });
});

describe("the gas probe's arithmetic", () => {
  it("starts at the estimate plus a tenth, grows by half, and stops at the cap", () => {
    expect(firstGateGasLimit(288_752n, 2_000_000n)).toBe(317_628n);
    expect(firstGateGasLimit(2_000_001n, 2_000_000n)).toBeNull();
    expect(nextGateGasLimit(317_628n, 2_000_000n)).toBe(476_442n);
    expect(nextGateGasLimit(1_800_000n, 2_000_000n)).toBe(2_000_000n);
    expect(nextGateGasLimit(2_000_000n, 2_000_000n)).toBeNull();
    expect(probeGas(317_628n)).toBe(317_628n - GAS_PROBE_MARGIN);
    expect(probeGas(10_000n)).toBe(0n);
  });

  it("takes a limit only when the preview under it says exactly what the truth says", () => {
    const truth = { kind: "result" as const, allSatisfied: false, failingSymbol: symbolWord("bos_bullish"), decidingValue: 8_136_070_983_417n };
    expect(samePreview(truth, { ...truth })).toBe(true);
    // Out of gas inside the gate's try/catch: a refusal with 0. Not the truth.
    expect(samePreview({ ...truth, decidingValue: 0n }, truth)).toBe(false);
    expect(samePreview({ kind: "revert", error: "OutOfGas", args: [] }, truth)).toBe(false);
  });
});

describe("the window the gate reads", () => {
  const latest = 1_991_195;
  it("is PredicateEngine.windowStart, rule for rule", () => {
    expect(gateWindowStart(bos(20).predicates[0]!, latest, 900)).toBe(latest - 20);
    const [, fvg, sweep] = RULE_04.predicates;
    expect(gateWindowStart(fvg!, latest, 900)).toBe(latest - 2);
    // The previous UTC day's first bucket.
    const dayStart = latest * 900 - ((latest * 900) % 86_400);
    expect(gateWindowStart(sweep!, latest, 900)).toBe((dayStart - 86_400) / 900);
    const swing = { ...sweep!, referenceExtreme: stated("swing_low" as const), lookback: stated("4h" as const) } as typeof sweep;
    expect(gateWindowStart(swing!, latest, 900)).toBe(latest - 16);
    // Clamped to bucket 0.
    expect(gateWindowStart(bos(20).predicates[0]!, 5, 900)).toBe(0);
    expect(gateWindowStart(sweep!, 50, 900)).toBe(0);
    expect(replayWindow(RULE_04, latest)).toEqual({ from: (dayStart - 86_400) / 900, to: latest });
  });
});

/** Recorded candles at expo -8, one per bucket in [from, to], with `skip` left unrecorded. */
function tape(from: number, to: number, f: (b: number) => { high: number; low: number; close: number }, skip: number[] = []): ChainCandle[] {
  const out: ChainCandle[] = [];
  for (let b = from; b <= to; b++) {
    const { high, low, close } = f(b);
    const scale = (n: number) => BigInt(Math.round(n * 100)) * 1_000_000n;
    out.push({ bucket: b, open: scale(close), high: scale(high), low: scale(low), close: scale(close), recorded: !skip.includes(b) });
  }
  return out;
}
const atExpo = (n: number) => dec(BigInt(Math.round(n * 100)) * 1_000_000n, 8);

describe("the replay over the chain's own candles", () => {
  const latest = 1_991_195;
  const flat = (closeAtLatest: number) => (b: number) =>
    b === latest ? { high: closeAtLatest, low: closeAtLatest, close: closeAtLatest } : { high: 101, low: 99, close: 100 };

  it("decides a break of structure on the judged bucket alone, as the gate does", () => {
    const passed = explainFromChain(bos(3), { bucketIndex: latest, priceExpo: -8, candles: tape(latest - 3, latest, flat(105)) });
    expect(passed.outcomes).toEqual([
      { predicateId: "p1", kind: "break_of_structure", symbol: "bos_bullish", status: "decided", satisfied: true, decidingValue: atExpo(105), referenceValue: atExpo(101), at: latest * 900 },
    ]);
    // A close equal to the swing high has not broken it.
    const equal = explainFromChain(bos(3), { bucketIndex: latest, priceExpo: -8, candles: tape(latest - 3, latest, flat(101)) });
    expect(equal.outcomes[0]).toMatchObject({ status: "decided", satisfied: false, decidingValue: atExpo(101), referenceValue: atExpo(101) });
    // Candles outside the window are not the gate's: a higher high before it does not count.
    const wider = tape(latest - 6, latest, (b) => (b === latest - 6 ? { high: 200, low: 99, close: 100 } : flat(105)(b)));
    expect(explainFromChain(bos(3), { bucketIndex: latest, priceExpo: -8, candles: wider }).outcomes[0]).toMatchObject({ satisfied: true });
  });

  it("says a predicate could not be evaluated when its window is not whole, and what it needs", () => {
    // Strategy 0 on a series sampled for three buckets: BOS 20 needs 21 in a row.
    const young = explainFromChain(bos(20), { bucketIndex: latest, priceExpo: -8, candles: tape(latest - 20, latest, flat(105), Array.from({ length: 18 }, (_, i) => latest - 20 + i)) });
    expect(young.outcomes[0]).toMatchObject({ status: "could_not_evaluate", needed: 21, recorded: 3, span: 21 });
    expect((young.outcomes[0] as { message: string }).message).toBe(
      "Could not evaluate bos_bullish: it needs 21 consecutive 15m samples, and the series has 3 of the last 21.",
    );
    // One missed bucket in the middle is enough: a gap is never bridged.
    const gap = explainFromChain(bos(3), { bucketIndex: latest, priceExpo: -8, candles: tape(latest - 3, latest, flat(105), [latest - 2]) });
    expect(gap.outcomes[0]).toMatchObject({ status: "could_not_evaluate", needed: 4, recorded: 3 });
  });

  it("measures a fair value gap and a sweep over the gate's window", () => {
    const spec: StrategySpec = { ...RULE_04, predicates: [RULE_04.predicates[1]!] };
    // c1 high 100, c3 low 100.20: a 20 bps gap, over the 15 bps the rule asks.
    const candles = tape(latest - 2, latest, (b) =>
      b === latest - 2 ? { high: 100, low: 99, close: 99.5 } : b === latest ? { high: 101, low: 100.2, close: 100.5 } : { high: 100.4, low: 99.8, close: 100 },
    );
    expect(explainFromChain(spec, { bucketIndex: latest, priceExpo: -8, candles }).outcomes[0]).toMatchObject({
      status: "decided",
      satisfied: true,
      decidingValue: dec("20", 0),
      referenceValue: dec("15", 0),
    });

    const sweepSpec: StrategySpec = { ...RULE_04, predicates: [RULE_04.predicates[2]!] };
    const { from } = replayWindow(sweepSpec, latest);
    // Yesterday's low is 99; the judged bucket wicks to 98.50 and closes back at 99.50.
    const swept = tape(from, latest, (b) => (b === latest ? { high: 100, low: 98.5, close: 99.5 } : { high: 101, low: 99, close: 100 }));
    expect(explainFromChain(sweepSpec, { bucketIndex: latest, priceExpo: -8, candles: swept }).outcomes[0]).toMatchObject({
      status: "decided",
      satisfied: true,
      decidingValue: atExpo(98.5),
      referenceValue: atExpo(99),
    });
  });
});

describe("the row a gate transaction is written as", () => {
  const spec = bos(3);
  const latest = 1_991_195;
  const target: GateTarget = {
    chainId: 10143,
    gate: GATE,
    series: SERIES,
    feed: "BTC/USD",
    chainStrategyId: 0n,
    isLong: true,
    predicates: toPredicateDefinitions(spec),
  };
  const offchain: OffchainJudgment = {
    verdict: "proposed",
    setup: {
      direction: "long",
      asset: "BTC/USD",
      entry: dec("8136070", 2),
      stop: dec("8095390", 2),
      size: dec("123", 4),
      equity: dec("2500000", 2),
      equitySource: "paper",
      riskBps: 50,
    },
    results: [{ predicateId: "p1", kind: "break_of_structure", symbol: "bos_bullish", satisfied: true, decidingValue: dec("8136070", 2), referenceValue: dec("8100000", 2), at: (latest - 1) * 900 }],
    scan: { from: (latest - 4) * 900, to: (latest - 1) * 900, asOf: (latest - 1) * 900 + 30 },
  };
  const verdict = (over: Partial<GateVerdict> = {}): GateVerdict => ({
    verdict: "refused",
    txHash: `0x${"ab".repeat(32)}`,
    blockNumber: 48_000_000n,
    blockTime: BigInt(latest * 900 + 40),
    bucketIndex: latest,
    signer: SIGNER,
    gasLimit: 317_628n,
    costWei: 317_628n * 102_000_000_000n,
    specHash: SPEC_HASH,
    symbol: "bos_bullish",
    decidingValue: 10_100_000_000n,
    previewDiffers: false,
    ...over,
  });
  const strategy = { _id: "strategies:1", specHash: "0xspec" };
  const replayOf = (close: number, skip: number[] = []) =>
    explainFromChain(spec, {
      bucketIndex: latest,
      priceExpo: -8,
      candles: tape(latest - 3, latest, (b) => (b === latest ? { high: close, low: close, close } : { high: 101, low: 99, close: 100 }), skip),
    });

  it("is a refusal by the chain with the number it compared and the bar it missed, when the replay reproduces it", () => {
    const row = rowFromJudgment({ strategy, spec, target, offchain, judgment: verdict(), replay: replayOf(101) });
    expect(row).toMatchObject({
      strategyId: "strategies:1",
      status: "refused",
      // The setup is the off-chain one; the verdict is the chain's, and the off-chain one is kept beside it.
      entry: offchain.setup.entry,
      failedPredicateId: "p1",
      failedSymbol: "bos_bullish",
      failingValue: atExpo(101),
      requiredValue: atExpo(101),
      satisfiedPredicateIds: [],
      resultsSource: "chain",
      evidenceRefs: [`monad:10143/tx/0x${"ab".repeat(32)}`, `${spec.series.feed}#900s@${latest * 900}`],
      gate: {
        chainId: 10143,
        gate: GATE,
        series: SERIES,
        chainStrategyId: "0",
        blockNumber: 48_000_000,
        bucketIndex: latest,
        gasLimit: "317628",
        priceExpo: -8,
        verdict: "refused",
        symbol: "bos_bullish",
        decidingValue: "10100000000",
        offchainVerdict: "proposed",
      },
    });
    expect("previewDiffers" in row.gate).toBe(false);
  });

  it("shows no bar when the replay does not reproduce the chain's number", () => {
    const row = rowFromJudgment({ strategy, spec, target, offchain, judgment: verdict({ decidingValue: 10_050_000_000n }), replay: replayOf(101) });
    expect(row.failingValue).toEqual(atExpo(100.5));
    expect(row.requiredValue).toBeUndefined();
  });

  it("says could not evaluate, never a failing value of 0, when the window is not whole", () => {
    const row = rowFromJudgment({ strategy, spec, target, offchain, judgment: verdict({ decidingValue: 0n }), replay: replayOf(101, [latest - 2]) });
    expect(row.failedPredicateId).toBe("p1");
    expect(row.failingValue).toBeUndefined();
    expect(row.requiredValue).toBeUndefined();
    expect(row.gate.couldNotEvaluate).toEqual({ predicateId: "p1", needed: 4, recorded: 3 });
    expect(row.results).toEqual([]);
  });

  it("names no predicate for the gate's own refusals", () => {
    const side = rowFromJudgment({ strategy, spec, target, offchain, judgment: verdict({ symbol: "SIDE_MISMATCH", decidingValue: 1n }), replay: replayOf(105) });
    expect(side).toMatchObject({ status: "refused", failedSymbol: "SIDE_MISMATCH", gate: { symbol: "SIDE_MISMATCH", decidingValue: "1" } });
    expect(side.failedPredicateId).toBeUndefined();
    expect(side.failingValue).toBeUndefined();
    const retired = rowFromJudgment({ strategy, spec, target, offchain, judgment: verdict({ symbol: "RETIRED", decidingValue: 0n }), replay: null });
    expect(retired).toMatchObject({ failedSymbol: "RETIRED" });
    expect(retired.failedPredicateId).toBeUndefined();
  });

  it("is a pass by the chain with every predicate satisfied, and says when the preview differed", () => {
    const row = rowFromJudgment({
      strategy,
      spec,
      target,
      offchain: { ...offchain, verdict: "refused" },
      judgment: verdict({ verdict: "proposed", symbol: undefined, decidingValue: undefined, previewDiffers: true }),
      replay: replayOf(105),
    });
    expect(row).toMatchObject({ status: "proposed", satisfiedPredicateIds: ["p1"], gate: { verdict: "proposed", offchainVerdict: "refused", previewDiffers: true } });
    expect(row.failedSymbol).toBeUndefined();
    expect(row.scan).toEqual({ from: (latest - 3) * 900, to: latest * 900, asOf: offchain.scan.asOf });
  });

  it("keeps the off-chain outcomes, and says so, when the window could not be read", () => {
    const row = rowFromJudgment({ strategy, spec, target, offchain, judgment: verdict({ verdict: "proposed", symbol: undefined, decidingValue: undefined }), replay: null });
    expect(row.resultsSource).toBe("offchain");
    expect(row.results).toEqual(offchain.results);
    expect(row.scan).toEqual(offchain.scan);
    expect("priceExpo" in row.gate).toBe(false);
  });
});
