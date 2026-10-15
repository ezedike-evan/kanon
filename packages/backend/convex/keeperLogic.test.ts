import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toFunctionSignature, type AbiFunction } from "viem";
import { PYTH_FEEDS, type PythPrice } from "@kanon/spec";
import { seriesAbi, type GateCall, type GatePort, type PriceSource } from "./gatePort";
import {
  LEASE_TTL_MS,
  feedOfSeriesIn,
  feedsInUse,
  formatMon,
  gasLimitFor,
  holdsLease,
  keeperView,
  leaseDecision,
  runKeeperTick,
  sendGuard,
  sentence,
  spentToday,
  tickNote,
  utcDayStart,
  withSpend,
  type KeeperRow,
  type KeeperTickInput,
} from "./keeperLogic";

/**
 * The keeper's order of calls and its guards, against a chain held in memory.
 * The fake series records a sample into the bucket of the mock's publish time,
 * exactly as `CanonicalSeries.recordSample` does, and refuses to before its
 * cadence has run; nothing here reaches a network.
 */

const GWEI = 10n ** 9n;
const MON = 10n ** 18n;
const BTC_SERIES = "0x74c4b8710fb83dcc18c1a5ae2e35a63dc005257a" as const;
const ETH_SERIES = "0x8d2d1b9dafa8f68eccfec9fdebbe04268b4ffbf3" as const;
const MOCK = "0x7b0564b87edd57d7bb70550b1fba3384964862ce" as const;
const SIGNER = "0xE0072e39D6Fb592BafB3c6783710C1b24EC601b4" as const;
const BTC_ID = PYTH_FEEDS["BTC/USD"]!;
const ETH_ID = PYTH_FEEDS["ETH/USD"]!;

/** 30 seconds into a 15-minute bucket. */
const T = 1_800_000_000n + 30n;
const BUCKET = T / 900n;

const SOURCE: PythPrice = { price: 6_841_234_000_000n, conf: 5_123_456n, expo: -8, publishTime: 1_799_999_900n };

function chain() {
  const calls: string[] = [];
  const sends: Array<{ call: GateCall; gas: bigint; maxFeePerGas: bigint }> = [];
  const state = {
    blockTime: T,
    recorded: new Map<string, Set<bigint>>([
      [BTC_SERIES, new Set()],
      [ETH_SERIES, new Set()],
    ]),
    feedIdOf: { [BTC_SERIES]: BTC_ID, [ETH_SERIES]: ETH_ID } as Record<string, `0x${string}`>,
    lastSample: new Map<string, bigint>(),
    cadence: 60n,
    balance: 3n * MON,
    gasPrice: 102n * GWEI,
    estimates: { setPrice: 45_000n, recordSample: 202_000n } as Record<string, bigint>,
    effectiveGasPrice: 102n * GWEI,
    receiptStatus: "success" as "success" | "reverted",
    /** How many of the next sends answer with a nonce error. */
    nonceErrors: 0,
    /** A recordSample that is mined and records nothing: a broken series. */
    recordsNothing: false,
    mock: new Map<string, PythPrice>(),
    source: SOURCE,
    sourceNow: 1_800_000_000n,
    lease: true,
    leaseLog: [] as string[],
  };
  const name = (series: string) => (series === BTC_SERIES ? "BTC" : series === ETH_SERIES ? "ETH" : series);
  let made = 0;

  const port: GatePort = {
    signer: SIGNER,
    async blockTime() {
      calls.push("blockTime");
      return state.blockTime;
    },
    async getCandle(series, bucket) {
      calls.push(`getCandle ${name(series)} ${bucket}`);
      const recorded = state.recorded.get(series)?.has(bucket) ?? false;
      return { open: 1n, high: 1n, low: 1n, close: 1n, sampleCount: recorded ? 1 : 0, recorded };
    },
    async seriesFeedId(series) {
      calls.push(`feedId ${name(series)}`);
      return state.feedIdOf[series]!;
    },
    async lastSampleTimestamp(series) {
      return state.lastSample.get(series) ?? 0n;
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
    async estimateGas(call) {
      calls.push(`estimate ${call.functionName}`);
      return state.estimates[call.functionName]!;
    },
    async send(call, opts) {
      if (state.nonceErrors > 0) {
        state.nonceErrors -= 1;
        calls.push(`send ${call.functionName} (nonce error)`);
        // viem's own shape: a readable summary, and the node's words in a cause.
        throw Object.assign(new Error("Nonce provided for the transaction is lower than the current nonce of the account."), {
          cause: { details: "nonce too low" },
        });
      }
      calls.push(`send ${call.functionName}`);
      sends.push({ call, gas: opts.gas, maxFeePerGas: opts.maxFeePerGas });
      if (call.functionName === "setPrice") {
        const [id, price, conf, expo, publishTime] = call.args as [string, bigint, bigint, number, bigint];
        state.mock.set(id, { price, conf, expo, publishTime });
      }
      if (call.functionName === "recordSample" && !state.recordsNothing) {
        const p = state.mock.get(state.feedIdOf[call.address]!);
        if (!p) throw new Error("MockPyth: price not set");
        state.recorded.get(call.address)!.add(p.publishTime / 900n);
        state.lastSample.set(call.address, state.blockTime);
      }
      made += 1;
      return `0x${made.toString(16).padStart(64, "0")}`;
    },
    async waitForReceipt() {
      calls.push("receipt");
      return { status: state.receiptStatus, gasUsed: 0n, effectiveGasPrice: state.effectiveGasPrice, blockNumber: 1n };
    },
  };

  const source: PriceSource = {
    async read(feedId) {
      calls.push(`source ${feedId === BTC_ID ? "BTC" : "ETH"}`);
      return { price: state.source, sourceNowSeconds: state.sourceNow };
    },
  };

  const logs: string[] = [];
  const input = (over: Partial<KeeperTickInput> = {}): KeeperTickInput => ({
    port,
    source,
    feeds: ["BTC/USD"],
    series: { "BTC/USD": BTC_SERIES, "ETH/USD": ETH_SERIES },
    mockPyth: MOCK,
    limits: {
      minBalanceWei: MON / 5n,
      warnBalanceWei: MON,
      maxFeePerGasWei: 250n * GWEI,
      dailySpendWei: 4n * MON,
      maxGas: 400_000n,
      maxSourceAgeSeconds: 7_200n,
    },
    spentTodayWei: 0n,
    lease: {
      async acquire() {
        calls.push("acquire");
        return state.lease;
      },
      async release(spent) {
        calls.push(`release ${spent}`);
      },
    },
    log: (_level, line) => logs.push(line),
    ...over,
  });
  return { calls, sends, state, input, logs };
}

const sendsOf = (calls: string[]) => calls.filter((c) => c.startsWith("send"));

describe("a tick", () => {
  it("samples an unsampled feed in order: setPrice, then recordSample, then reads the candle again", async () => {
    const c = chain();
    const report = await runKeeperTick(c.input());

    expect(c.calls).toEqual([
      "blockTime",
      `getCandle BTC ${BUCKET}`,
      "balance",
      "gasPrice",
      "acquire",
      "feedId BTC",
      "blockTime",
      "source BTC",
      "estimate setPrice",
      "send setPrice",
      "receipt",
      "estimate recordSample",
      "send recordSample",
      "receipt",
      `getCandle BTC ${BUCKET}`,
      `release ${(49_500n + 222_200n) * 102n * GWEI}`,
    ]);
    // The mainnet price, stamped with the testnet block time so it lands in this bucket.
    expect(c.sends[0]!.call).toMatchObject({ address: MOCK, functionName: "setPrice", args: [BTC_ID, SOURCE.price, SOURCE.conf, -8, T] });
    expect(c.sends[1]!.call).toMatchObject({ address: BTC_SERIES, functionName: "recordSample" });
    // Explicit gas: the estimate plus a tenth. The bid is capped at the fee cap.
    expect(c.sends.map((s) => s.gas)).toEqual([49_500n, 222_200n]);
    expect(c.sends.every((s) => s.maxFeePerGas === 250n * GWEI)).toBe(true);
    expect(report).toMatchObject({
      bucket: Number(BUCKET),
      sampled: [{ feed: "BTC/USD", bucket: Number(BUCKET) }],
      paused: null,
      busy: false,
      errors: [],
      balanceWei: 3n * MON,
    });
    // Monad bills the limit: the spend is limit times the price paid, from the receipts.
    expect(report.spentWei).toBe((49_500n + 222_200n) * 102n * GWEI);
  });

  it("leaves a feed already sampled in this bucket alone, and takes nothing for it", async () => {
    const c = chain();
    c.state.recorded.get(BTC_SERIES)!.add(BUCKET);
    const report = await runKeeperTick(c.input());
    expect(c.calls).toEqual(["blockTime", `getCandle BTC ${BUCKET}`]);
    expect(report.sampled).toEqual([{ feed: "BTC/USD", bucket: Number(BUCKET) }]);
    expect(report.spentWei).toBe(0n);
  });

  it("samples only the feed that needs it", async () => {
    const c = chain();
    c.state.recorded.get(BTC_SERIES)!.add(BUCKET);
    const report = await runKeeperTick(c.input({ feeds: ["BTC/USD", "ETH/USD"] }));
    expect(c.sends.map((s) => s.call.address)).toEqual([MOCK, ETH_SERIES]);
    expect(c.sends[0]!.call.args?.[0]).toBe(ETH_ID);
    expect(report.sampled).toEqual([
      { feed: "BTC/USD", bucket: Number(BUCKET) },
      { feed: "ETH/USD", bucket: Number(BUCKET) },
    ]);
  });

  it("does not touch a pair nobody uses", async () => {
    const c = chain();
    await runKeeperTick(c.input({ feeds: ["BTC/USD"] }));
    expect(c.calls.some((call) => call.includes("ETH"))).toBe(false);
  });

  it("sends nothing from an unfunded signer, and asks for a top-up by name", async () => {
    const c = chain();
    c.state.balance = MON / 10n;
    const report = await runKeeperTick(c.input({ spentTodayWei: MON / 2n }));
    expect(sendsOf(c.calls)).toEqual([]);
    expect(c.calls).not.toContain("acquire");
    expect(report.paused).toBe("signer_unfunded");
    expect(c.logs).toContain(`keeper: signer ${SIGNER} has 0.1000 MON, spent 0.5000 in 24h; top up`);
  });

  it("sends nothing while gas is above the fee cap", async () => {
    const c = chain();
    c.state.gasPrice = 251n * GWEI;
    const report = await runKeeperTick(c.input());
    expect(sendsOf(c.calls)).toEqual([]);
    expect(c.calls).not.toContain("acquire");
    expect(report.paused).toBe("fee_too_high");
  });

  it("sends nothing once the day's cap is spent, and says so in the top-up line", async () => {
    const c = chain();
    const report = await runKeeperTick(c.input({ spentTodayWei: 4n * MON }));
    expect(sendsOf(c.calls)).toEqual([]);
    expect(report.paused).toBe("daily_cap");
    expect(c.logs).toContain(`keeper: signer ${SIGNER} has 3.0000 MON, spent 4.0000 in 24h; top up`);
  });

  it("does not send a transaction that could carry the day past its cap at the highest price it bids", async () => {
    const c = chain();
    // 49,500 gas at 250 gwei is 0.012375 MON; with 3.99 spent it would pass 4.
    const report = await runKeeperTick(c.input({ spentTodayWei: 3_990_000_000_000_000_000n }));
    expect(c.calls).toContain("estimate setPrice");
    expect(sendsOf(c.calls)).toEqual([]);
    expect(report.paused).toBe("daily_cap");
    expect(c.calls.at(-1)).toBe("release 0");
  });

  it("warns below the warning balance and still sends above the minimum", async () => {
    const c = chain();
    c.state.balance = MON / 2n;
    const report = await runKeeperTick(c.input());
    expect(report.paused).toBeNull();
    expect(sendsOf(c.calls)).toHaveLength(2);
    expect(c.logs[0]).toBe(`keeper: signer ${SIGNER} has 0.5000 MON, spent 0.0000 in 24h; top up`);
  });

  it("retries a nonce error once, with the nonce fetched again", async () => {
    const c = chain();
    c.state.nonceErrors = 1;
    const report = await runKeeperTick(c.input());
    expect(sendsOf(c.calls)).toEqual(["send setPrice (nonce error)", "send setPrice", "send recordSample"]);
    expect(c.calls.filter((call) => call === "estimate setPrice")).toHaveLength(2);
    expect(report.sampled).toEqual([{ feed: "BTC/USD", bucket: Number(BUCKET) }]);
  });

  it("retries a nonce error only once, then gives the feed up for this tick and lets go of the signer", async () => {
    const c = chain();
    c.state.nonceErrors = 2;
    const report = await runKeeperTick(c.input());
    expect(sendsOf(c.calls)).toEqual(["send setPrice (nonce error)", "send setPrice (nonce error)"]);
    expect(report.sampled).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/^BTC\/USD: Nonce provided/);
    expect(c.calls.at(-1)).toBe("release 0");
  });

  it("waits out the series' cadence rather than set a price it cannot record yet", async () => {
    const c = chain();
    c.state.lastSample.set(BTC_SERIES, T - 59n);
    const report = await runKeeperTick(c.input());
    expect(sendsOf(c.calls)).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.sampled).toEqual([]);
  });

  it("does not mirror a stale mainnet price", async () => {
    const c = chain();
    c.state.sourceNow = SOURCE.publishTime + 7_201n;
    const report = await runKeeperTick(c.input());
    expect(sendsOf(c.calls)).toEqual([]);
    expect(report.errors).toEqual(["BTC/USD: the mainnet price is 7201s old, past the keeper's limit, so it was not mirrored"]);
  });

  it("refuses a series address set against the wrong pair", async () => {
    const c = chain();
    const report = await runKeeperTick(c.input({ series: { "BTC/USD": ETH_SERIES } }));
    expect(sendsOf(c.calls)).toEqual([]);
    expect(report.errors).toEqual(["BTC/USD: the series configured for BTC/USD samples another feed"]);
  });

  it("does not send what would need more gas than the keeper's limit", async () => {
    const c = chain();
    c.state.estimates.recordSample = 400_001n;
    const report = await runKeeperTick(c.input());
    expect(sendsOf(c.calls)).toEqual(["send setPrice"]);
    expect(report.errors[0]).toMatch(/recordSample needs 400001 gas/);
  });

  it("caps the padded limit at the keeper's limit", async () => {
    const c = chain();
    c.state.estimates.recordSample = 380_000n;
    await runKeeperTick(c.input());
    expect(c.sends.map((s) => s.gas)).toEqual([49_500n, 400_000n]);
  });

  it("does nothing while another holds the signer", async () => {
    const c = chain();
    c.state.lease = false;
    const report = await runKeeperTick(c.input());
    expect(report.busy).toBe(true);
    expect(sendsOf(c.calls)).toEqual([]);
    expect(c.calls).not.toContainEqual(expect.stringMatching(/^release/));
  });

  it("counts a reverted transaction's gas, and records nothing for it", async () => {
    const c = chain();
    c.state.receiptStatus = "reverted";
    const report = await runKeeperTick(c.input());
    expect(sendsOf(c.calls)).toEqual(["send setPrice"]);
    expect(report.spentWei).toBe(49_500n * 102n * GWEI);
    expect(report.errors[0]).toMatch(/^BTC\/USD: setPrice 0x0+1 reverted$/);
  });

  it("requires the candle recorded after recordSample, not just a mined transaction", async () => {
    const c = chain();
    c.state.recordsNothing = true;
    const report = await runKeeperTick(c.input());
    expect(report.sampled).toEqual([]);
    expect(report.errors[0]).toMatch(/still not recorded/);
  });

  it("names a pair with no series configured, and samples the rest", async () => {
    const c = chain();
    const report = await runKeeperTick(c.input({ feeds: ["ETH/USD", "BTC/USD"], series: { "BTC/USD": BTC_SERIES } }));
    expect(report.errors).toEqual(["ETH/USD: no series is configured for it on this deployment."]);
    expect(report.sampled).toEqual([{ feed: "BTC/USD", bucket: Number(BUCKET) }]);
  });
});

describe("the lease", () => {
  const NOW = 1_800_000_000_000;

  it("is free when nobody holds it, or the holder's time ran out", () => {
    expect(leaseDecision(null, "a", NOW)).toEqual({ ok: true, leaseUntil: NOW + LEASE_TTL_MS });
    expect(leaseDecision({ leaseHolder: "b", leaseUntil: NOW }, "a", NOW)).toEqual({ ok: true, leaseUntil: NOW + 120_000 });
  });
  it("is refused while someone else holds it", () => {
    expect(leaseDecision({ leaseHolder: "b", leaseUntil: NOW + 1 }, "a", NOW)).toEqual({ ok: false, leaseUntil: NOW + 1 });
  });
  it("is renewed by its own holder", () => {
    expect(leaseDecision({ leaseHolder: "a", leaseUntil: NOW + 1 }, "a", NOW)).toEqual({ ok: true, leaseUntil: NOW + 120_000 });
  });
  it("is let go of only by its holder", () => {
    expect(holdsLease({ leaseHolder: "a" }, "a")).toBe(true);
    expect(holdsLease({ leaseHolder: "a" }, "b")).toBe(false);
    expect(holdsLease(null, "a")).toBe(false);
  });
});

describe("spend", () => {
  const DAY = 86_400_000;
  const noon = 20_000 * DAY + DAY / 2;

  it("counts from midnight UTC, and an earlier day counts as nothing", () => {
    expect(utcDayStart(noon)).toBe(20_000 * DAY);
    expect(spentToday({ spentWeiDay: "5", dayStart: 20_000 * DAY }, noon)).toBe(5n);
    expect(spentToday({ spentWeiDay: "5", dayStart: 19_999 * DAY }, noon)).toBe(0n);
    expect(spentToday(null, noon)).toBe(0n);
  });
  it("adds to today's count, rolling an old day over first", () => {
    expect(withSpend({ spentWeiDay: "5", dayStart: 20_000 * DAY }, noon, 3n)).toEqual({ spentWeiDay: "8", dayStart: 20_000 * DAY });
    expect(withSpend({ spentWeiDay: "5", dayStart: 19_999 * DAY }, noon, 3n)).toEqual({ spentWeiDay: "3", dayStart: 20_000 * DAY });
  });
  it("pads gas by a tenth, rounds up, and caps it", () => {
    expect(gasLimitFor(45_000n, 400_000n)).toBe(49_500n);
    expect(gasLimitFor(202_001n, 400_000n)).toBe(222_202n);
    expect(gasLimitFor(1n, 400_000n)).toBe(2n);
    expect(gasLimitFor(390_000n, 400_000n)).toBe(400_000n);
    expect(gasLimitFor(400_001n, 400_000n)).toBeNull();
  });
  it("guards in a fixed order: funds, then fee, then the day", () => {
    const limits = { minBalanceWei: 10n, maxFeePerGasWei: 100n, dailySpendWei: 1_000n };
    expect(sendGuard(limits, { balanceWei: 9n, gasPriceWei: 101n, spentTodayWei: 1_000n })).toBe("signer_unfunded");
    expect(sendGuard(limits, { balanceWei: 10n, gasPriceWei: 101n, spentTodayWei: 1_000n })).toBe("fee_too_high");
    expect(sendGuard(limits, { balanceWei: 10n, gasPriceWei: 100n, spentTodayWei: 1_000n })).toBe("daily_cap");
    expect(sendGuard(limits, { balanceWei: 10n, gasPriceWei: 100n, spentTodayWei: 0n })).toBeNull();
    expect(sendGuard(limits, { balanceWei: 10n, gasPriceWei: 100n, spentTodayWei: 0n }, 10n)).toBeNull();
    expect(sendGuard(limits, { balanceWei: 10n, gasPriceWei: 100n, spentTodayWei: 1n }, 10n)).toBe("daily_cap");
  });
  it("writes MON cut, not rounded", () => {
    expect(formatMon(3_789_999_999_999_999_999n)).toBe("3.7899");
    expect(formatMon(0n)).toBe("0.0000");
    expect(formatMon(27_745_000_000_000_000n, 6)).toBe("0.027745");
  });
});

describe("feeds in use", () => {
  const feedOf = feedOfSeriesIn({ "BTC/USD": BTC_SERIES, "ETH/USD": ETH_SERIES });
  const rule = (owner: string, at: number, over: Record<string, unknown> = {}) => ({
    ownerUserId: owner,
    _creationTime: at,
    status: "pinned",
    pinVerified: true,
    seriesAddress: BTC_SERIES,
    ...over,
  });

  it("counts each owner's active rule: their newest pinned or cooling-off one", () => {
    expect(feedsInUse([rule("a", 1), rule("a", 2, { seriesAddress: ETH_SERIES })], feedOf)).toEqual(["ETH/USD"]);
    expect(feedsInUse([rule("a", 1), rule("b", 2, { status: "cooling_off", seriesAddress: ETH_SERIES })], feedOf)).toEqual([
      "BTC/USD",
      "ETH/USD",
    ]);
  });
  it("ignores drafts, unchecked pins and series the deployment does not name", () => {
    expect(feedsInUse([rule("a", 1), rule("a", 2, { status: "draft", seriesAddress: ETH_SERIES })], feedOf)).toEqual(["BTC/USD"]);
    expect(feedsInUse([rule("a", 1, { pinVerified: undefined })], feedOf)).toEqual([]);
    expect(feedsInUse([rule("a", 1, { seriesAddress: `0x${"11".repeat(20)}` })], feedOf)).toEqual([]);
    expect(feedsInUse([rule("a", 1, { seriesAddress: BTC_SERIES.toUpperCase().replace("0X", "0x") })], feedOf)).toEqual(["BTC/USD"]);
  });
  it("lets a newer pin replace an older one even when the newer one is not checked", () => {
    expect(feedsInUse([rule("a", 1), rule("a", 2, { pinVerified: undefined, seriesAddress: ETH_SERIES })], feedOf)).toEqual([]);
  });
});

describe("what a tick writes", () => {
  const row: KeeperRow = {
    feeds: ["BTC/USD"],
    sampled: [{ feed: "BTC/USD", bucket: 10 }],
    spentWeiDay: "0",
    dayStart: 0,
    signer: SIGNER,
    balanceWei: "100",
  };
  const quiet = { bucket: 10, sampled: [{ feed: "BTC/USD", bucket: 10 }], sent: [], spentWei: 0n, paused: null, busy: false, errors: [] };

  it("writes nothing when nothing changed", () => {
    expect(tickNote(row, quiet, SIGNER)).toBeNull();
  });
  it("writes a new bucket, a pause, a new error or a moved balance", () => {
    expect(tickNote(row, { ...quiet, sampled: [{ feed: "BTC/USD", bucket: 11 }] }, SIGNER)).toMatchObject({
      sampled: [{ feed: "BTC/USD", bucket: 11 }],
    });
    expect(tickNote(row, { ...quiet, paused: "daily_cap" }, SIGNER)).toMatchObject({ paused: "daily_cap" });
    expect(tickNote(row, { ...quiet, errors: ["x"] }, SIGNER)).toMatchObject({ error: "x" });
    expect(tickNote({ ...row, lastError: "x" }, { ...quiet, errors: ["x"] }, SIGNER)).toBeNull();
    expect(tickNote(row, { ...quiet, balanceWei: 300n, spentWei: 100n }, SIGNER)).toMatchObject({ balanceWei: "200" });
  });
  it("forgets a pair no longer in use", () => {
    const note = tickNote({ ...row, sampled: [...row.sampled, { feed: "ETH/USD", bucket: 3 }] }, quiet, SIGNER);
    expect(note?.sampled).toEqual([{ feed: "BTC/USD", bucket: 10 }]);
  });
});

describe("words a client may read", () => {
  const KEY = "0x" + "5c".repeat(32);

  it("drops RPC URLs and blanks the key from an error", () => {
    const e = { shortMessage: `HTTP request failed. URL: https://rpc.example/${KEY.slice(2)} key ${KEY}\nmore` };
    const line = sentence(e, [KEY]);
    expect(line).not.toContain("rpc.example");
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("\n");
  });

  it("shows status with no key and no URL in it", () => {
    const env = {
      KEEPER_ENABLED: "on",
      KEEPER_PRIVATE_KEY: KEY,
      STRATEGY_REGISTRY_ADDRESS: `0x${"aa".repeat(20)}`,
      STRATEGY_REGISTRY_RPC_URL: "https://testnet.example/secret",
      STRATEGY_REGISTRY_CHAIN_ID: "10143",
      MONAD_RPC_URL: "https://mainnet.example/secret",
      REFUSAL_GATE_ADDRESS: `0x${"bb".repeat(20)}`,
      MOCK_PYTH_ADDRESS: MOCK,
      SERIES_BTCUSD_ADDRESS: BTC_SERIES,
    };
    const view = keeperView({ feeds: ["BTC/USD"], sampled: [], spentWeiDay: "7", dayStart: utcDayStart(Date.now()) }, env, Date.now());
    const text = JSON.stringify(view);
    expect(text).not.toContain(KEY.slice(2, 20));
    expect(text).not.toContain("secret");
    expect(view).toMatchObject({
      enabled: true,
      paused: null,
      spentToday: { atoms: "7", decimals: 18 },
      dailyCap: { atoms: (4n * MON).toString(), decimals: 18 },
      feeds: ["BTC/USD"],
    });
  });

  it("says off when switched off, and not configured when on without what it needs", () => {
    expect(keeperView(null, {}, 0)).toMatchObject({ enabled: false, paused: "off" });
    expect(keeperView(null, { KEEPER_ENABLED: "on" }, 0)).toMatchObject({ paused: "not_configured" });
  });
});

describe("the series ABI", () => {
  it("matches what packages/contracts compiled", () => {
    const compiled = JSON.parse(
      readFileSync(resolve(__dirname, "../../contracts/abi/CanonicalSeries.json"), "utf8"),
    ) as AbiFunction[];
    const signatures = new Set(compiled.filter((f) => f.type === "function").map((f) => toFunctionSignature(f)));
    for (const f of seriesAbi) expect(signatures, f.name).toContain(toFunctionSignature(f));
  });
});
