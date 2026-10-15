import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import { stringToHex } from "viem";
import {
  PYTH_FEEDS,
  RULE_04,
  parseDecimal,
  predicatesCommitment,
  specHash,
  stated,
  type Candle,
  type Series,
  type StrategySpec,
} from "@kanon/spec";
import * as autopilotData from "./autopilotData";
import { HANDOFF_EXPIRY_MS, HANDOFF_MESSAGES, HANDOFF_WINDOW_MS } from "./autopilotLogic";
import { padAddress, padUint } from "./chainLogic";
import crons from "./crons";
import { GATE_TOPICS } from "./gateLogic";
import type { GatePort, GateReceipt, PriceSource } from "./gatePort";
import http from "./http";
import { tick } from "./keeper";
import * as keeperData from "./keeperData";
import { runProposer } from "./proposer";
import * as proposerData from "./proposerData";
import * as rateLimit from "./rateLimit";
import { applyVerifiedPin, setAutopilot } from "./strategies";
import * as timedData from "./timedData";
import * as trades from "./trades";
import * as venueData from "./venueData";
import { ORDER_LOCK_MS, RECORDER_HEADER } from "./venueLogic";

/**
 * Autopilot's handlers, run as they are against a database held in memory,
 * from the keeper tick that hands it each bucket to the gateway that opens a
 * pass.
 *
 * Nothing here is deployed, nothing reaches a venue and nothing reaches a
 * chain. Each registered function's own handler is called with a stand-in
 * `ctx`: the database below, a token's identity, and `runQuery` /
 * `runMutation` that find the real handler by the name it is referenced by.
 * Two things are not real: Convex's price series, which a test supplies for
 * the off-chain setup, and the chain, a gate held in memory that the real port
 * factory is swapped for. Its verdict is the close of the bucket it judges:
 * above the three before it passes, at or below refuses.
 *
 * Functions here are referenced by name, as strings, which no type check reads.
 * Every name autopilot and the routes use is resolved below against the
 * modules themselves, so one that names nothing fails a test.
 */

const fake = vi.hoisted(() => ({ port: null as unknown, source: null as unknown }));
vi.mock("./gatePort", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gatePort")>();
  return { ...actual, createViemGatePort: () => fake.port, createPythSource: () => fake.source };
});

// ---------------------------------------------------------------------------
// The stand-in database: tables of rows, read by equality on indexed fields.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { _id: string; _creationTime: number };

function memoryDb() {
  const tables = new Map<string, Row[]>();
  let made = 0;
  const all = (): Row[] => [...tables.values()].flat();
  const rows = (table: string): Row[] => tables.get(table) ?? [];

  return {
    rows,
    async get(id: string): Promise<Row | null> {
      return all().find((row) => row._id === id) ?? null;
    },
    async insert(table: string, doc: Record<string, unknown>): Promise<string> {
      made += 1;
      const row: Row = { ...doc, _id: `${table}:${made}`, _creationTime: made };
      tables.set(table, [...rows(table), row]);
      return row._id;
    },
    async patch(id: string, fields: Record<string, unknown>): Promise<void> {
      const row = all().find((r) => r._id === id);
      if (!row) throw new Error(`no row ${id}`);
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete row[key];
        else row[key] = value;
      }
    },
    query(table: string) {
      let found = [...rows(table)];
      let newestFirst = false;
      const reader = {
        withIndex(_name: string, range: (q: { eq(field: string, value: unknown): unknown }) => unknown) {
          const wanted: Array<[string, unknown]> = [];
          const q = {
            eq(field: string, value: unknown) {
              wanted.push([field, value]);
              return q;
            },
          };
          range(q);
          found = found.filter((row) => wanted.every(([field, value]) => row[field] === value));
          return reader;
        },
        order(direction: "asc" | "desc") {
          newestFirst = direction === "desc";
          return reader;
        },
        async take(n: number): Promise<Row[]> {
          return (newestFirst ? [...found].reverse() : found).slice(0, n);
        },
        async first(): Promise<Row | null> {
          return (await reader.take(1))[0] ?? null;
        },
      };
      return reader;
    },
  };
}

// ---------------------------------------------------------------------------
// The stand-in chain: one series, always sampled, and the gate over it.
// ---------------------------------------------------------------------------

const GWEI = 10n ** 9n;
const MON = 10n ** 18n;
const GATE = "0x388f55962954c5083d885543af22b1b6ee640ec0";
const REGISTRY = "0xdb91f547b59a3326f3db8e8f510e8dbbf4e50852";
const SERIES = "0x74c4b8710fb83dcc18c1a5ae2e35a63dc005257a";
const SIGNER = "0xe0072e39d6fb592bafb3c6783710c1b24ec601b4" as const;
const BOS_SYMBOL = stringToHex("bos_bullish", { size: 32 });

/** A price at the series' scale, expo -8. */
const onChain = (v: string) => BigInt(parseDecimal(v, 8).atoms);

function fakeChain(nowMs: () => number) {
  const state = {
    /** The judged bucket's one sample. The three before it top at 101. */
    close: "100.50",
    sends: [] as Array<{ fn: string; bucket: bigint }>,
    receipts: new Map<string, GateReceipt>(),
  };
  const blockTime = () => BigInt(Math.floor(nowMs() / 1000));
  const latest = () => blockTime() / 900n;
  const passes = () => onChain(state.close) > onChain("101");
  const port: GatePort = {
    signer: SIGNER,
    blockTime: async () => blockTime(),
    getCandle: async () => ({ open: 1n, high: 1n, low: 1n, close: 1n, sampleCount: 1, recorded: true }),
    seriesFeedId: async () => PYTH_FEEDS["BTC/USD"]!,
    lastSampleTimestamp: async () => blockTime() - 30n,
    cadenceSeconds: async () => 60n,
    balance: async () => 3n * MON,
    gasPrice: async () => 102n * GWEI,
    estimateGas: async () => 288_752n,
    async send(call, opts) {
      state.sends.push({ fn: call.functionName, bucket: latest() });
      const hash = `0x${state.sends.length.toString(16).padStart(64, "0")}` as `0x${string}`;
      const topics = [padUint(0n), "0x" + "09".repeat(32), padAddress(SIGNER)];
      const logs = passes()
        ? [{ address: GATE, topics: [GATE_TOPICS.proposed, ...topics], data: "0x" }]
        : [{ address: GATE, topics: [GATE_TOPICS.refused, ...topics], data: BOS_SYMBOL + onChain(state.close).toString(16).padStart(64, "0") }];
      state.receipts.set(hash, { status: "success", gasUsed: opts.gas, effectiveGasPrice: 102n * GWEI, blockNumber: 48_000_000n, logs });
      return hash;
    },
    waitForReceipt: async (hash) => state.receipts.get(hash)!,
    blockTimeAt: async () => blockTime(),
    previewOnChain: async () =>
      passes()
        ? { kind: "result", allSatisfied: true, failingSymbol: `0x${"00".repeat(32)}`, decidingValue: 0n }
        : { kind: "result", allSatisfied: false, failingSymbol: BOS_SYMBOL, decidingValue: onChain(state.close) },
    async readCandles(_series, from, to) {
      const candles = [];
      for (let b = from; b <= to; b++) {
        const last = b === latest();
        const c = last ? onChain(state.close) : onChain("100");
        candles.push({ bucket: b, open: c, high: last ? c : onChain("101"), low: last ? c : onChain("99"), close: c, sampleCount: 1, recorded: true });
      }
      return { priceExpo: -8, candles };
    },
  };
  const source: PriceSource = {
    read: async () => ({ price: { price: 1n, conf: 0n, expo: -8, publishTime: blockTime() }, sourceNowSeconds: blockTime() }),
  };
  return { state, port, source, gateSends: () => state.sends.filter((s) => s.fn === "evaluateOnChain") };
}

// ---------------------------------------------------------------------------
// The stand-in ctx
// ---------------------------------------------------------------------------

type Handler = (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
const handlerOf = (fn: unknown): Handler => (fn as { _handler: Handler })._handler;

const ALICE = "did:privy:alice";
const BOB = "did:privy:bob";

const T0 = 1_800_000_000 - (1_800_000_000 % 900); // a 15m boundary
const at = (i: number) => T0 + i * 900;
const px = (v: string) => parseDecimal(v, 2);
const atExpo = (v: string) => parseDecimal(v, 8);

/** RULE_04 cut down to one predicate: a 15m close above the high of the three candles before it. */
const bosSpec: StrategySpec = {
  ...RULE_04,
  predicates: [
    { kind: "break_of_structure", id: "p1", direction: "long", swingLookbackCandles: stated(3), timeframe: stated("15m") },
  ],
};

function candle(ts: number, close: string, high: string): Candle {
  return { bucketIndex: ts / 900, timestamp: ts, open: px("100"), high: px(high), low: px("99"), close: px(close), synthetic: false };
}

/** Four flat candles topping at 101, then the candle at `at(last)` closing at `close`: 105 breaks, 100.50 does not. */
function seriesEnding(last: number, close: string): Series & { truncated: boolean } {
  return {
    asset: "BTC/USD",
    bucketSeconds: 900,
    truncated: false,
    candles: [
      candle(at(last - 4), "100", "101"),
      candle(at(last - 3), "100", "101"),
      candle(at(last - 2), "100", "101"),
      candle(at(last - 1), "100", "101"),
      candle(at(last), close, "106"),
    ],
  };
}

const PASS = "105";
const FAIL = "100.50";

type SeriesAnswer = (Series & { truncated: boolean }) | Error;

const ENV = {
  KEEPER_ENABLED: "on",
  // Never a real key: the port it would sign with is the stand-in above.
  KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  REFUSAL_GATE_ADDRESS: GATE,
  MOCK_PYTH_ADDRESS: "0x7b0564b87edd57d7bb70550b1fba3384964862ce",
  STRATEGY_REGISTRY_ADDRESS: REGISTRY,
  STRATEGY_REGISTRY_RPC_URL: "https://testnet-rpc.example",
  STRATEGY_REGISTRY_CHAIN_ID: "10143",
  SERIES_BTCUSD_ADDRESS: SERIES,
};

function world() {
  const db = memoryDb();
  const state = {
    /** Unix milliseconds: what `Date.now()` reads inside a handler, and what the chain's clock reads. */
    now: at(5) * 1000 + 30_000,
    /** Whose token the next public call carries. Null is nobody. */
    subject: ALICE as string | null,
    /** What `series:getSeries` answers, or an error for it to throw: one answer for every asset, or one per asset. */
    series: seriesEnding(4, FAIL) as SeriesAnswer | ((asset: string) => SeriesAnswer),
    seriesReads: 0,
    snapshotReads: 0,
    scheduled: [] as unknown[],
  };
  const chain = fakeChain(() => state.now);
  fake.port = chain.port;
  fake.source = chain.source;

  const named: Record<string, Handler> = {
    "series:getSeries": async (_ctx, args) => {
      state.seriesReads += 1;
      const answer = typeof state.series === "function" ? state.series(String(args.asset)) : state.series;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  // `module:export`, exactly as Convex names a function: a reference that is misspelt finds nothing.
  for (const [module, exports] of Object.entries({ autopilotData, keeperData, proposerData, rateLimit, timedData, trades, venueData })) {
    for (const [name, fn] of Object.entries(exports)) {
      if (typeof fn === "function" && "_handler" in fn) named[`${module}:${name}`] = handlerOf(fn);
    }
  }
  const snapshot = named["autopilotData:snapshot"]!;
  named["autopilotData:snapshot"] = async (c, a) => {
    state.snapshotReads += 1;
    return await snapshot(c, a);
  };
  const run = (ref: FunctionReference<"query" | "mutation">, args: Record<string, unknown>): Promise<unknown> => {
    const name = getFunctionName(ref);
    const handler = named[name];
    if (!handler) throw new Error(`no handler stands in for ${name}`);
    return handler(ctx, args);
  };
  const ctx = {
    db,
    auth: { getUserIdentity: async () => (state.subject ? { subject: state.subject } : null) },
    scheduler: { runAfter: async (...call: unknown[]) => void state.scheduled.push(call) },
    runQuery: run,
    runMutation: run,
  };
  const call = <T = unknown>(fn: unknown, args: Record<string, unknown> = {}): Promise<T> => handlerOf(fn)(ctx, args) as Promise<T>;
  return { db, state, chain, ctx, call };
}

type World = ReturnType<typeof world>;

/** Strategy 0's shape: pinned and read from the chain, on this deployment's registry and the keeper's BTC series. */
const PINNED = {
  status: "pinned",
  pinVerified: true,
  chainId: 10143,
  registryAddress: REGISTRY,
  chainStrategyId: "0",
  predicatesCommitment: predicatesCommitment(bosSpec),
  seriesAddress: SERIES,
};

async function seed(w: World, over: Record<string, unknown> = {}) {
  const alice = await w.db.insert("users", { privyId: ALICE, name: "Alice", username: "alice", experience: "some" });
  const bob = await w.db.insert("users", { privyId: BOB, name: "Bob", username: "bob", experience: "some" });
  const strategyId = await w.db.insert("strategies", {
    ownerUserId: alice,
    spec: bosSpec,
    specHash: "0xspec",
    ...PINNED,
    autopilot: false,
    ...over,
  });
  // The keeper keeps the BTC series sampled for a pinned rule (`recomputeKeeperFeeds`).
  if (w.db.rows("keeper").length === 0) {
    await w.db.insert("keeper", { feeds: ["BTC/USD"], sampled: [], spentWeiDay: "0", dayStart: at(0) * 1000 - ((at(0) * 1000) % 86_400_000) });
  }
  return { alice, bob, strategyId };
}

type TickOutcome = { status: string; autopilot?: Record<string, unknown> & { clean: boolean } };

/** The keeper tick at `seconds` into the bucket `at(bucket)`. */
async function tickAt(w: World, bucket: number, seconds = 30): Promise<TickOutcome> {
  w.state.now = (at(bucket) + seconds) * 1000;
  return (await w.call(tick)) as TickOutcome;
}

/**
 * The tick half a minute into the bucket after the candle `at(closed)`, when the
 * chain's sample, and Convex's last closed candle, close at `close`.
 */
async function sweepAfter(w: World, closed: number, close: string) {
  w.state.series = seriesEnding(closed, close);
  w.chain.state.close = close;
  return (await tickAt(w, closed + 1)).autopilot ?? {};
}

const proposalsOf = (w: World) => w.db.rows("trades").filter((row) => row.handoff !== undefined);
const open = (proposalId: string, over: Record<string, unknown> = {}) => ({
  proposalId,
  network: "testnet",
  asset: "BTC/USD",
  action: "open",
  side: "long",
  notionalUsd: 50,
  leverage: 5,
  ...over,
});
const opened = (proposalId: string, openedAt: number) => ({
  proposalId,
  network: "testnet",
  asset: "BTC/USD",
  direction: "up",
  stakeUsd: 10,
  leverage: 5,
  seconds: 900,
  openedAt,
  expiresAt: openedAt + 900_000,
  size: { atoms: "60", decimals: 5 },
  entryPrice: { atoms: "828471", decimals: 1 },
});

let w: World;
beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  w = world();
  vi.spyOn(Date, "now").mockImplementation(() => w.state.now);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("turning autopilot on and off", () => {
  it("is turned on by a strategy's owner, for a pinned rule or one whose loosening is cooling off", async () => {
    for (const status of ["pinned", "cooling_off"]) {
      w = world();
      const { strategyId } = await seed(w, { status });
      expect(await w.call(setAutopilot, { strategyId, on: true })).toEqual({ autopilot: true });
      expect((await w.db.get(strategyId))?.autopilot).toBe(true);
    }
  });

  it("is not turned on for a draft: a rule nothing enforces is judged by nothing", async () => {
    const { strategyId } = await seed(w, { status: "draft", spec: undefined, pendingSpec: bosSpec });
    await expect(w.call(setAutopilot, { strategyId, on: true })).rejects.toThrow(/pin this one first/);
    expect((await w.db.get(strategyId))?.autopilot).toBe(false);
    // Off is always allowed, and is already so.
    expect(await w.call(setAutopilot, { strategyId, on: false })).toEqual({ autopilot: false });
  });

  it("is nobody else's to turn on, and nobody's without a sign-in", async () => {
    const { strategyId } = await seed(w);
    w.state.subject = BOB;
    await expect(w.call(setAutopilot, { strategyId, on: true })).rejects.toMatchObject({ data: { code: "not_found" } });
    w.state.subject = null;
    await expect(w.call(setAutopilot, { strategyId, on: true })).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    expect((await w.db.get(strategyId))?.autopilot).toBe(false);
  });

  it("remembers the bucket it is turned on in, and keeps its place when asked for what it already is", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(3) });
    await w.call(setAutopilot, { strategyId, on: true });
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(3));
    await w.call(setAutopilot, { strategyId, on: false });
    expect("autopilotBucket" in ((await w.db.get(strategyId)) ?? {})).toBe(false);
    // Seven minutes into the bucket at(5): that bucket, whose sample is from before, is not judged.
    w.state.now = (at(5) + 420) * 1000;
    await w.call(setAutopilot, { strategyId, on: true });
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(5));
  });

  it("is refused, with a sentence, for a rule the gate cannot judge", async () => {
    const minute: StrategySpec = {
      ...bosSpec,
      series: { ...bosSpec.series, bucketSeconds: 60 },
      predicates: bosSpec.predicates.map((p) => ({ ...p, timeframe: stated("1m" as const) })),
    };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ spec: minute, predicatesCommitment: predicatesCommitment(minute) }, /15-minute candles, and this one is written on 1m/],
      [{ chainId: 143 }, /another chain or registry/],
      [{ seriesAddress: `0x${"33".repeat(20)}` }, /not one Kanon keeps sampled/],
      [{ predicatesCommitment: `0x${"44".repeat(32)}` }, /do not match the commitment/],
    ];
    // And on a deployment whose signer is switched off, nothing would judge it.
    {
      w = world();
      const { strategyId } = await seed(w);
      vi.stubEnv("KEEPER_ENABLED", "off");
      await expect(w.call(setAutopilot, { strategyId, on: true })).rejects.toMatchObject({ data: { code: "not_eligible", message: expect.stringMatching(/switched off/) } });
      vi.stubEnv("KEEPER_ENABLED", "on");
    }
    for (const [over, sentence] of cases) {
      w = world();
      const { strategyId } = await seed(w, over);
      await expect(w.call(setAutopilot, { strategyId, on: true })).rejects.toMatchObject({ data: { code: "not_eligible", message: expect.stringMatching(sentence) } });
      expect((await w.db.get(strategyId))?.autopilot).toBe(false);
    }
  });

  it("is turned off for the rule a newly pinned one replaces, and what that rule had waiting is withdrawn", async () => {
    const { alice, bob, strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(3) });
    const bobs = await w.db.insert("strategies", { ownerUserId: bob, spec: bosSpec, specHash: "0xbob", status: "pinned", autopilot: true });
    const waiting = await w.db.insert("trades", {
      strategyId,
      origin: "autopilot",
      handoff: "pending",
      status: "proposed",
      createdAt: w.state.now,
    });
    const draft = await w.db.insert("strategies", { ownerUserId: alice, pendingSpec: bosSpec, status: "draft", autopilot: false });

    // The write a checked pin ends in (`strategiesChain.test.ts` covers the check itself).
    await w.call(applyVerifiedPin, {
      subject: ALICE,
      strategyId: draft,
      specHash: await specHash(bosSpec),
      predicatesCommitment: predicatesCommitment(bosSpec),
      series: `0x${"11".repeat(20)}`,
      bondAtoms: { atoms: "0", decimals: 18 },
      txHash: `0x${"ab".repeat(32)}`,
      chainId: 10143,
      registryAddress: `0x${"22".repeat(20)}`,
      chainStrategyId: "2",
    });

    const replaced = await w.db.get(strategyId);
    expect(replaced?.autopilot).toBe(false);
    expect("autopilotBucket" in (replaced ?? {})).toBe(false);
    expect(await w.db.get(waiting)).toMatchObject({ status: "undone", handoff: "not_opened", handoffReason: HANDOFF_MESSAGES.turnedOff });
    // The new rule is pinned with autopilot off: it is turned on by its owner, not inherited.
    expect(await w.db.get(draft)).toMatchObject({ status: "pinned", autopilot: false });
    // Somebody else's rule is not touched.
    expect((await w.db.get(bobs))?.autopilot).toBe(true);
  });
});

describe("autopilot on the keeper tick", () => {
  it("runs inside the keeper tick, every minute, and there is no separate autopilot sweep", () => {
    const jobs = (crons as unknown as { crons: Record<string, { name: string; schedule: Record<string, unknown> }> }).crons;
    expect(jobs["keeper tick"]).toMatchObject({ name: "keeper:tick", schedule: { type: "interval", minutes: 1 } });
    expect(jobs["sweep autopilot"]).toBeUndefined();
    expect(Object.values(jobs).map((job) => job.name)).not.toContain("autopilot:sweep");
    const registered = tick as unknown as { isAction?: boolean; isInternal?: boolean; isPublic?: boolean };
    expect([registered.isAction, registered.isInternal, registered.isPublic]).toEqual([true, true, undefined]);
  });

  it("judges nothing in the bucket autopilot was turned on in: that bucket's sample is from before", async () => {
    const { strategyId } = await seed(w);
    w.state.now = (at(5) + 60) * 1000;
    await w.call(setAutopilot, { strategyId, on: true });

    // A minute later, in the same bucket, the sample would pass. It is not judged.
    w.chain.state.close = PASS;
    w.state.series = seriesEnding(4, PASS);
    expect((await tickAt(w, 5, 120)).autopilot).toMatchObject({ proposed: 0, refused: 0, clean: true });
    expect(w.chain.gateSends()).toEqual([]);
    expect(w.db.rows("trades")).toEqual([]);
    expect(w.state.seriesReads).toBe(0);

    // The next bucket is.
    expect(await sweepAfter(w, 5, FAIL)).toMatchObject({ refused: 1 });
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(6));
  });

  it("judges each bucket once: two ticks in one bucket give one transaction and one row", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    expect(await sweepAfter(w, 5, FAIL)).toMatchObject({ refused: 1, clean: true });
    expect(w.state.snapshotReads).toBe(1);

    // Every minute after, through the bucket: nothing is read for autopilot and nothing is sent.
    for (let minute = 1; minute < 14; minute++) {
      expect((await tickAt(w, 6, 30 + minute * 60)).autopilot).toBeUndefined();
    }
    expect(w.state.snapshotReads).toBe(1);
    expect(w.chain.gateSends()).toHaveLength(1);
    expect(w.db.rows("trades")).toHaveLength(1);
    expect(w.db.rows("keeper")[0]?.judgedBucket).toBe(at(6) / 900);
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(6));
  });

  it("judges a bucket only in its first five minutes", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    w.chain.state.close = PASS;
    w.state.series = seriesEnding(5, PASS);
    expect((await tickAt(w, 6, 300)).autopilot).toBeUndefined();
    expect(w.chain.gateSends()).toEqual([]);
    expect((await tickAt(w, 6, 299)).autopilot).toMatchObject({ proposed: 1 });
  });

  it("sends the gate transaction in the bucket it judges, and records it as the row's evidence", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, FAIL);
    const [row] = w.db.rows("trades");
    expect(w.chain.gateSends()).toEqual([{ fn: "evaluateOnChain", bucket: BigInt(at(6) / 900) }]);
    expect(row).toMatchObject({
      origin: "autopilot",
      status: "refused",
      resultsSource: "chain",
      gate: { verdict: "refused", bucketIndex: at(6) / 900, txHash: `0x${"1".padStart(64, "0")}`, signer: SIGNER, offchainVerdict: "refused" },
    });
    expect((row?.evidenceRefs as string[])[0]).toBe(`monad:10143/tx/0x${"1".padStart(64, "0")}`);
  });

  it("judges nothing, on-chain or off, for a rule the gate cannot judge, even with autopilot on", async () => {
    // A row left `pinned` by a client's say-so, from before pins were checked, with autopilot already on.
    const { strategyId } = await seed(w, { pinVerified: undefined, autopilot: true, autopilotBucket: at(3) });
    expect(await sweepAfter(w, 4, PASS)).toMatchObject({ proposed: 0, refused: 0, legacy: 1, clean: true });
    expect(w.db.rows("trades")).toEqual([]);
    expect(w.chain.gateSends()).toEqual([]);
    expect(w.state.seriesReads).toBe(0);
    // And it cannot be turned back on once it is off.
    await w.call(setAutopilot, { strategyId, on: false });
    await expect(w.call(setAutopilot, { strategyId, on: true })).rejects.toThrow(/pin it again/);
  });

  it("records a refusal as a button press does, and marks it as autopilot's", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, FAIL);
    const [byAutopilot] = w.db.rows("trades");

    w.state.subject = ALICE;
    w.state.now += 60_000;
    expect(await w.call(runProposer, { strategyId })).toMatchObject({ status: "refused", txHash: `0x${"2".padStart(64, "0")}` });
    const byButton = w.db.rows("trades")[1];

    // The same verdict, the same numbers, the same explanation. Who asked, and the transaction, differ.
    const same = ["status", "failedPredicateId", "failedSymbol", "failingValue", "requiredValue", "results", "resultsSource", "entry", "stop", "size"];
    for (const field of same) expect(byAutopilot?.[field], field).toEqual(byButton?.[field]);
    expect(byButton).toMatchObject({
      status: "refused",
      failedPredicateId: "p1",
      failedSymbol: "bos_bullish",
      failingValue: atExpo(FAIL),
      requiredValue: atExpo("101"),
    });
    expect(byAutopilot?.origin).toBe("autopilot");
    expect("origin" in (byButton ?? {})).toBe(false);
    expect("handoff" in (byAutopilot ?? {})).toBe(false);
    expect((byAutopilot?.gate as { txHash: string }).txHash).not.toBe((byButton?.gate as { txHash: string }).txHash);
  });

  it("writes a proposal for the gateway when the gate passes: no undo window, no paper execution, its expiry scheduled", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    expect(await sweepAfter(w, 5, PASS)).toMatchObject({ proposed: 1 });
    const [row] = w.db.rows("trades");
    expect(row).toMatchObject({
      status: "proposed",
      origin: "autopilot",
      handoff: "pending",
      // The smallest stake on offer, held for the 15m candle the spec is written on.
      stakeUsd: 10,
      holdSeconds: 900,
      direction: "long",
      asset: "BTC/USD",
      entry: px(PASS),
      satisfiedPredicateIds: ["p1"],
      gate: { verdict: "proposed" },
    });
    expect("undoExpiresAt" in (row ?? {})).toBe(false);
    expect(w.state.scheduled).toHaveLength(1);
    const [delay, ref, args] = w.state.scheduled[0] as [number, FunctionReference<"mutation">, Record<string, unknown>];
    expect([delay, getFunctionName(ref), args]).toEqual([HANDOFF_EXPIRY_MS, "autopilotData:expireOne", { tradeId: row!._id }]);
  });

  it("leaves a button press exactly as it was: its undo window, its paper execution, no mark", async () => {
    const { strategyId } = await seed(w);
    w.state.now = at(6) * 1000 + 30_000;
    w.state.series = seriesEnding(5, PASS);
    w.chain.state.close = PASS;
    const out = (await w.call(runProposer, { strategyId })) as { status: string; tradeId: string };
    expect(out.status).toBe("proposed");
    const row = await w.db.get(out.tradeId);
    expect(row).toMatchObject({ status: "proposed", undoExpiresAt: w.state.now + 7_000, gate: { verdict: "proposed" } });
    for (const field of ["origin", "handoff", "stakeUsd", "holdSeconds"]) expect(field in (row ?? {})).toBe(false);
    expect(w.state.scheduled).toHaveLength(1);
    // And it does not move autopilot's own place.
    expect("autopilotBucket" in ((await w.db.get(strategyId)) ?? {})).toBe(false);
  });

  it("writes nothing and sends nothing when Convex's candles cannot price an entry, and tries the bucket again a minute later", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    // The newest candle is hours old: a setup is not priced from old prices.
    w.state.series = seriesEnding(1, PASS);
    w.chain.state.close = PASS;
    expect((await tickAt(w, 6)).autopilot).toMatchObject({ unavailable: 1, proposed: 0, refused: 0, clean: false });
    expect(w.db.rows("trades")).toEqual([]);
    expect(w.chain.gateSends()).toEqual([]);
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(4));

    // The series catches up a minute later: that bucket is judged then.
    w.state.series = seriesEnding(5, FAIL);
    w.chain.state.close = FAIL;
    expect((await tickAt(w, 6, 90)).autopilot).toMatchObject({ refused: 1, clean: true });
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(6));
  });

  it("keeps judging the rest when one strategy cannot be read", async () => {
    const { alice } = await seed(w, { autopilot: true, autopilotBucket: at(4), spec: { ...bosSpec, series: { ...bosSpec.series, asset: "ETH/USD" } } });
    const second = await w.db.insert("strategies", { ownerUserId: alice, spec: bosSpec, specHash: "0xother", ...PINNED, autopilot: true, autopilotBucket: at(4) });
    w.chain.state.close = FAIL;
    // The first strategy's read throws; the second's answers.
    w.state.series = (asset) => (asset === "ETH/USD" ? new Error("read failed") : seriesEnding(5, FAIL));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await tickAt(w, 6)).autopilot).toMatchObject({ failed: 1, refused: 1, clean: false });
    expect(w.db.rows("trades").map((row) => row.strategyId)).toEqual([second]);
  });

  it("leaves alone a strategy autopilot is off for, and one whose stored spec does not parse", async () => {
    const { alice } = await seed(w, { autopilot: false, autopilotBucket: at(1) });
    await w.db.insert("strategies", { ownerUserId: alice, spec: { not: "a spec" }, specHash: "0xbad", ...PINNED, autopilot: true, autopilotBucket: at(1) });
    expect(await sweepAfter(w, 5, PASS)).toMatchObject({ proposed: 0, notOpened: 0, refused: 0, armed: 0, unavailable: 0, failed: 0, legacy: 1, clean: true });
    expect(w.db.rows("trades")).toEqual([]);
  });
});

describe("claiming a bucket", () => {
  it("claims it once, before anything is sent, and gives it back only as it was", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    expect(await w.call(autopilotData.claim, { strategyId, bucket: at(5) })).toEqual({ ok: true, previous: at(4) });
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(5));
    // A second pass in the same bucket finds it claimed.
    expect(await w.call(autopilotData.claim, { strategyId, bucket: at(5) })).toEqual({ ok: false, why: "judged" });

    await w.call(autopilotData.unclaim, { strategyId, bucket: at(5), previous: at(4) });
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(4));

    // A claim autopilot was turned off and on again over is not given back.
    await w.call(autopilotData.claim, { strategyId, bucket: at(5) });
    await w.db.patch(strategyId, { autopilotBucket: at(7) });
    await w.call(autopilotData.unclaim, { strategyId, bucket: at(5), previous: at(4) });
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(7));
  });

  it("claims nothing for a rule autopilot is off for, and only remembers the bucket for one with none remembered", async () => {
    const { strategyId } = await seed(w);
    expect(await w.call(autopilotData.claim, { strategyId, bucket: at(5) })).toEqual({ ok: false, why: "off" });
    await w.db.patch(strategyId, { autopilot: true });
    expect(await w.call(autopilotData.claim, { strategyId, bucket: at(5) })).toEqual({ ok: false, why: "armed" });
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(5));
  });

  it("records every gate transaction: a pass after autopilot was turned off mid-judgment is a proposal not opened", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(5) });
    const row = {
      strategyId,
      direction: "long",
      asset: "BTC/USD",
      entry: px(PASS),
      size: px("1"),
      stop: px("104"),
      status: "proposed",
      satisfiedPredicateIds: ["p1"],
      evidenceRefs: [],
      results: [],
      specHash: "0xspec",
      scan: { from: 0, to: 0, asOf: 0 },
      equity: px("2500"),
      equitySource: "paper",
      riskBps: 50,
      feed: "pyth/btc-usd",
      autopilot: { bucket: at(5), stakeUsd: 10, holdSeconds: 900 },
    };
    // Turned off between the claim and the write.
    await w.db.patch(strategyId, { autopilot: false, autopilotBucket: undefined });
    expect(await w.call(trades.recordEvaluation, row)).toMatchObject({ handoff: "not_opened" });
    expect(w.db.rows("trades")[0]).toMatchObject({ status: "undone", handoff: "not_opened", handoffReason: HANDOFF_MESSAGES.turnedOff, origin: "autopilot" });
    // A refusal is recorded however autopilot stands.
    expect(await w.call(trades.recordEvaluation, { ...row, status: "refused", satisfiedPredicateIds: [] })).toMatchObject({ tradeId: expect.any(String) });
    expect(w.db.rows("trades")).toHaveLength(2);
    expect(w.state.scheduled).toEqual([]);
  });
});

describe("one autopilot trade per strategy at a time", () => {
  it("records a pass while the last proposal is waiting as not opened, and still records a refusal", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const [first] = proposalsOf(w);
    await w.call(autopilotData.begin, open(first!._id));
    // The next bucket opens while that order is still unanswered, and not yet given up on.
    w.state.now = at(7) * 1000 + 30_000;
    await w.db.patch(first!._id, { createdAt: w.state.now - HANDOFF_WINDOW_MS });

    expect(await sweepAfter(w, 6, PASS)).toMatchObject({ proposed: 0, notOpened: 1 });
    expect(proposalsOf(w).map((row) => [row.status, row.handoff, row.handoffReason])).toEqual([
      ["proposed", "pending", undefined],
      ["undone", "not_opened", HANDOFF_MESSAGES.stillOpen],
    ]);
    // The bucket counts as judged: it is not judged again when the trade has ended.
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(7));

    await w.db.patch(first!._id, { createdAt: at(8) * 1000 });
    expect(await sweepAfter(w, 7, FAIL)).toMatchObject({ refused: 1, notOpened: 0 });
    expect(w.db.rows("trades").map((row) => row.status)).toEqual(["proposed", "undone", "refused"]);
  });

  it("records a pass while its trade is running as not opened, and proposes again once that has closed", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const [first] = proposalsOf(w);
    await w.call(autopilotData.begin, open(first!._id));
    const started = (await w.call(autopilotData.start, opened(first!._id, w.state.now))) as { ok: true; tradeId: string };

    expect(await sweepAfter(w, 6, PASS)).toMatchObject({ proposed: 0, notOpened: 1 });
    expect(await sweepAfter(w, 7, FAIL)).toMatchObject({ refused: 1 });
    expect(proposalsOf(w).filter((row) => row.handoff === "pending" || row.handoff === "opened")).toHaveLength(1);

    // The gateway closes the trade when its time is up, as it closes any timed trade.
    await w.call(timedData.update, { tradeId: started.tradeId, status: "closed", endedBy: "time", closedAt: w.state.now });
    expect(await sweepAfter(w, 8, PASS)).toMatchObject({ proposed: 1, notOpened: 0 });
    expect(proposalsOf(w).map((row) => row.handoff)).toEqual(["opened", "not_opened", "pending"]);
  });

  it("proposes again after a proposal that was not opened", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const [first] = proposalsOf(w);
    await w.call(autopilotData.report, { proposalId: first!._id, outcome: "not_opened", reason: "The BTC market is closed." });
    expect(await sweepAfter(w, 6, PASS)).toMatchObject({ proposed: 1 });
    expect(proposalsOf(w).map((row) => row.handoff)).toEqual(["not_opened", "pending"]);
  });
});

describe("what the gateway is told is waiting", () => {
  it("lists a proposal with the trade it asks for: market, direction, the smallest stake and the hold", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const [row] = proposalsOf(w);
    expect(await w.call(autopilotData.pending, { nowMs: w.state.now })).toEqual([
      { proposalId: row!._id, asset: "BTC/USD", direction: "up", stakeUsd: 10, seconds: 900 },
    ]);
  });

  it("lists no refusal, no button press, nothing handed to the venue already, and nothing too old to open", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, FAIL);
    w.state.series = seriesEnding(5, PASS);
    w.chain.state.close = PASS;
    await w.call(runProposer, { strategyId });
    expect(await w.call(autopilotData.pending, { nowMs: w.state.now })).toEqual([]);

    await sweepAfter(w, 6, PASS);
    const [row] = proposalsOf(w);
    expect(await w.call(autopilotData.pending, { nowMs: w.state.now + HANDOFF_WINDOW_MS - 1 })).toHaveLength(1);
    expect(await w.call(autopilotData.pending, { nowMs: w.state.now + HANDOFF_WINDOW_MS })).toEqual([]);

    await w.call(autopilotData.begin, open(row!._id));
    expect(await w.call(autopilotData.pending, { nowMs: w.state.now })).toEqual([]);
  });
});

describe("the order lock for a proposal", () => {
  async function proposal() {
    const seeded = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    return { ...seeded, proposalId: proposalsOf(w)[0]!._id };
  }

  it("is taken for the proposal's owner, who is read from its strategy and never from the body", async () => {
    const { proposalId, alice } = await proposal();
    const begun = (await w.call(autopilotData.begin, open(proposalId))) as { ok: true; orderId: string };
    expect(begun.ok).toBe(true);
    expect(await w.db.get(begun.orderId)).toMatchObject({
      userId: alice,
      venue: "perpl",
      status: "submitting",
      network: "testnet",
      asset: "BTC/USD",
      action: "open",
      side: "long",
      notionalUsd: 50,
      leverage: 5,
    });
    // The proposal remembers its opening order: the evidence that it went to the venue.
    expect((await w.db.get(proposalId))?.openOrderId).toBe(begun.orderId);
  });

  it("refuses an id that is not a pending autopilot proposal", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(3) });
    const not = { ok: false, code: "not_pending" };

    // A refusal autopilot wrote, and a proposal somebody pressed a button for.
    await sweepAfter(w, 4, FAIL);
    await sweepAfter(w, 5, PASS);
    const refusal = w.db.rows("trades").find((row) => row.status === "refused");
    const proposalId = proposalsOf(w)[0]!._id;
    expect(await w.call(autopilotData.begin, open(refusal!._id))).toEqual(not);
    const pressed = (await w.call(runProposer, { strategyId })) as { tradeId: string };
    expect(await w.call(autopilotData.begin, open(pressed.tradeId))).toEqual(not);
    // A row of another table altogether.
    expect(await w.call(autopilotData.begin, open(strategyId))).toEqual(not);

    // The proposal itself, once it is finished.
    await w.call(autopilotData.report, { proposalId, outcome: "not_opened", reason: "The BTC market is closed." });
    expect(await w.call(autopilotData.begin, open(proposalId))).toEqual(not);
    expect(w.db.rows("venueOrders")).toEqual([]);
  });

  it("refuses another market, the other side, and a proposal too old to open", async () => {
    const { proposalId } = await proposal();
    const not = { ok: false, code: "not_pending" };
    expect(await w.call(autopilotData.begin, open(proposalId, { asset: "ETH/USD" }))).toEqual(not);
    expect(await w.call(autopilotData.begin, open(proposalId, { side: "short" }))).toEqual(not);
    expect(await w.call(autopilotData.begin, open(proposalId, { side: undefined }))).toEqual(not);
    w.state.now += HANDOFF_WINDOW_MS;
    expect(await w.call(autopilotData.begin, open(proposalId))).toEqual(not);
    expect(w.db.rows("venueOrders")).toEqual([]);
  });

  it("is given for the opening order once: a proposal is never sent to the venue twice", async () => {
    const { proposalId } = await proposal();
    expect(await w.call(autopilotData.begin, open(proposalId))).toMatchObject({ ok: true });
    // A second gateway process asking a moment later, or long after the first order's lock has
    // lapsed, is told to wait. It is given nothing to send and nothing to report.
    expect(await w.call(autopilotData.begin, open(proposalId))).toEqual({ ok: false, code: "busy" });
    w.state.now += ORDER_LOCK_MS;
    expect(await w.call(autopilotData.begin, open(proposalId))).toEqual({ ok: false, code: "busy" });
    expect(w.db.rows("venueOrders")).toHaveLength(1);
    expect((await w.db.get(proposalId))?.handoff).toBe("pending");
  });

  it("waits behind another order, and is still there to be asked for again", async () => {
    const { proposalId, bob } = await proposal();
    await w.db.insert("venueOrders", { userId: bob, venue: "perpl", network: "testnet", asset: "MON/USD", action: "open", status: "submitting", createdAt: w.state.now - 1_000 });
    expect(await w.call(autopilotData.begin, open(proposalId))).toEqual({ ok: false, code: "busy" });
    expect("openOrderId" in ((await w.db.get(proposalId)) ?? {})).toBe(false);
    expect(await w.call(autopilotData.pending, { nowMs: w.state.now })).toHaveLength(1);
  });

  it("lets the gateway take back a position it opened for the proposal, however late, and only on its market", async () => {
    const { proposalId, alice } = await proposal();
    const close = { proposalId, network: "testnet", asset: "BTC/USD", action: "close" };
    await w.call(autopilotData.begin, open(proposalId));
    await w.db.patch(w.db.rows("venueOrders")[0]!._id, { status: "filled" });
    w.state.now += HANDOFF_EXPIRY_MS;
    await w.call(autopilotData.expire);

    const begun = (await w.call(autopilotData.begin, close)) as { ok: true; orderId: string };
    expect(await w.db.get(begun.orderId)).toMatchObject({ userId: alice, action: "close", asset: "BTC/USD" });
    expect(await w.call(autopilotData.begin, { ...close, asset: "ETH/USD" })).toEqual({ ok: false, code: "not_pending" });
  });
});

describe("a trade that opened for a proposal", () => {
  async function begun() {
    const seeded = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const proposalId = proposalsOf(w)[0]!._id;
    await w.call(autopilotData.begin, open(proposalId));
    return { ...seeded, proposalId };
  }

  it("is written under the proposal's owner, marked as autopilot's and pointing at the proposal", async () => {
    const { proposalId, alice } = await begun();
    const started = (await w.call(autopilotData.start, opened(proposalId, w.state.now))) as { ok: true; tradeId: string };
    expect(started.ok).toBe(true);
    expect(await w.db.get(started.tradeId)).toMatchObject({
      userId: alice,
      venue: "perpl",
      status: "live",
      origin: "autopilot",
      proposalId,
      stakeUsd: 10,
      seconds: 900,
      direction: "up",
    });
    // And the proposal is finished in the same write.
    expect(await w.db.get(proposalId)).toMatchObject({
      status: "executed",
      handoff: "opened",
      timedTradeId: started.tradeId,
      executedAt: w.state.now,
      executionMode: "paper",
    });
  });

  it("is what the owner's own list shows, with the mark, and nobody else's", async () => {
    const { proposalId } = await begun();
    await w.call(autopilotData.start, opened(proposalId, w.state.now));
    w.state.subject = ALICE;
    expect(await w.call(timedData.listMine)).toMatchObject([{ origin: "autopilot", proposalId, status: "live" }]);
    w.state.subject = BOB;
    expect(await w.call(timedData.listMine)).toEqual([]);
  });

  it("is recovered by a restarted gateway and closed by its own id, like any other timed trade", async () => {
    const { proposalId } = await begun();
    const started = (await w.call(autopilotData.start, opened(proposalId, w.state.now))) as { ok: true; tradeId: string };
    expect(await w.call(timedData.running)).toMatchObject([{ id: started.tradeId, asset: "BTC/USD", stakeUsd: 10, seconds: 900 }]);
    // The closing order's lock is vouched for by the trade, as for a person's.
    await w.db.patch(w.db.rows("venueOrders")[0]!._id, { status: "filled" });
    expect(await w.call(timedData.beginClose, { tradeId: started.tradeId, network: "testnet", asset: "BTC/USD" })).toMatchObject({ ok: true });
    // And its owner may end it early: it is theirs.
    expect(await w.call(timedData.owns, { subject: ALICE, tradeId: started.tradeId })).toBe(true);
    expect(await w.call(timedData.owns, { subject: BOB, tradeId: started.tradeId })).toBe(false);
  });

  it("is not written for an id that is not a pending autopilot proposal, or a second time", async () => {
    const { proposalId, strategyId } = await begun();
    const not = { ok: false, code: "not_pending" };
    w.state.series = seriesEnding(5, PASS);
    const pressed = (await w.call(runProposer, { strategyId })) as { tradeId: string };
    expect(await w.call(autopilotData.start, opened(pressed.tradeId, w.state.now))).toEqual(not);

    expect(await w.call(autopilotData.start, opened(proposalId, w.state.now))).toMatchObject({ ok: true });
    expect(await w.call(autopilotData.start, opened(proposalId, w.state.now))).toEqual(not);
    expect(w.db.rows("timedTrades")).toHaveLength(1);
  });
});

describe("what became of a proposal", () => {
  async function proposal() {
    const seeded = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    return { ...seeded, proposalId: proposalsOf(w)[0]!._id };
  }

  it("is finished as not opened, with the venue's words, and is not offered again", async () => {
    const { proposalId } = await proposal();
    const reason = "BTC is in a timed trade on the shared account. It ends in about 40 seconds.";
    expect(await w.call(autopilotData.report, { proposalId, outcome: "not_opened", reason })).toEqual({ ok: true });
    expect(await w.db.get(proposalId)).toMatchObject({ status: "undone", handoff: "not_opened", handoffReason: reason });
    expect(await w.call(autopilotData.pending, { nowMs: w.state.now })).toEqual([]);
    expect(w.db.rows("timedTrades")).toEqual([]);
  });

  it("is said once: a second report, or one that contradicts what was written, changes nothing", async () => {
    const { proposalId } = await proposal();
    await w.call(autopilotData.begin, open(proposalId));
    const started = (await w.call(autopilotData.start, opened(proposalId, w.state.now))) as { ok: true; tradeId: string };
    const before = { ...(await w.db.get(proposalId)) };

    expect(await w.call(autopilotData.report, { proposalId, outcome: "opened", timedTradeId: started.tradeId })).toEqual({ ok: true });
    expect(await w.call(autopilotData.report, { proposalId, outcome: "not_opened", reason: "The trade opened but could not be recorded, so it was closed again." })).toEqual({ ok: true });
    expect(await w.db.get(proposalId)).toEqual(before);
  });

  it("cannot be called opened by a timed trade that was not opened for it", async () => {
    const { proposalId, bob } = await proposal();
    const someone = await w.db.insert("timedTrades", { userId: bob, venue: "perpl", status: "live" });
    expect(await w.call(autopilotData.report, { proposalId, outcome: "opened", timedTradeId: someone })).toEqual({ ok: false, code: "not_found" });
    expect(await w.call(autopilotData.report, { proposalId, outcome: "opened" })).toEqual({ ok: false, code: "not_found" });
    expect((await w.db.get(proposalId))?.handoff).toBe("pending");
  });

  it("is not a report about anything but an autopilot proposal", async () => {
    const { strategyId } = await proposal();
    w.state.series = seriesEnding(5, PASS);
    const pressed = (await w.call(runProposer, { strategyId })) as { tradeId: string };
    expect(await w.call(autopilotData.report, { proposalId: pressed.tradeId, outcome: "not_opened", reason: "x" })).toEqual({ ok: false, code: "not_found" });
    expect((await w.db.get(pressed.tradeId))?.status).toBe("proposed");
  });

  it("is finished when its scheduled expiry runs and the gateway never picked it up, and says nothing was sent", async () => {
    const { proposalId } = await proposal();
    w.state.now += HANDOFF_EXPIRY_MS - 1;
    expect(await w.call(autopilotData.expireOne, { tradeId: proposalId })).toBe(false);
    expect((await w.db.get(proposalId))?.handoff).toBe("pending");
    w.state.now += 1;
    expect(await w.call(autopilotData.expireOne, { tradeId: proposalId })).toBe(true);
    expect(await w.db.get(proposalId)).toMatchObject({ status: "undone", handoff: "not_opened", handoffReason: HANDOFF_MESSAGES.notPickedUp });
    // Run again, or for a row that is not a pending proposal, it changes nothing.
    expect(await w.call(autopilotData.expireOne, { tradeId: proposalId })).toBe(false);
  });

  it("is finished when its order went out and nothing was ever said, and says to look", async () => {
    const { proposalId } = await proposal();
    await w.call(autopilotData.begin, open(proposalId));
    w.state.now += HANDOFF_EXPIRY_MS;
    expect(await w.call(autopilotData.expireOne, { tradeId: proposalId })).toBe(true);
    expect(await w.db.get(proposalId)).toMatchObject({ status: "undone", handoff: "not_opened", handoffReason: HANDOFF_MESSAGES.noAnswer });
  });

  it("is finished by the next bucket's pass when its scheduled expiry was lost", async () => {
    const { proposalId } = await proposal();
    // The next bucket's tick, an hour on: the pass finishes every proposal past its time.
    expect(await sweepAfter(w, 9, FAIL)).toMatchObject({ expired: 1 });
    expect(await w.db.get(proposalId)).toMatchObject({ handoff: "not_opened", handoffReason: HANDOFF_MESSAGES.notPickedUp });
  });

  it("is withdrawn when its owner turns autopilot off before it went to the venue, and left alone once it has", async () => {
    const { proposalId, strategyId } = await proposal();
    await w.call(setAutopilot, { strategyId, on: false });
    expect(await w.db.get(proposalId)).toMatchObject({ status: "undone", handoff: "not_opened", handoffReason: HANDOFF_MESSAGES.turnedOff });
    expect(await w.call(autopilotData.begin, open(proposalId))).toEqual({ ok: false, code: "not_pending" });

    // Another, whose order is already on its way: turning autopilot off does not unsend it.
    await w.call(setAutopilot, { strategyId, on: true });
    await sweepAfter(w, 6, FAIL);
    await sweepAfter(w, 7, PASS);
    const second = proposalsOf(w)[1]!._id;
    await w.call(autopilotData.begin, open(second));
    await w.call(setAutopilot, { strategyId, on: false });
    expect((await w.db.get(second))?.handoff).toBe("pending");
    expect(await w.call(autopilotData.start, opened(second, w.state.now))).toMatchObject({ ok: true });
  });
});

describe("what the owner can and cannot do to an autopilot proposal from the app", () => {
  it("cannot confirm it onto paper or undo it while the gateway may be opening it", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const proposalId = proposalsOf(w)[0]!._id;
    w.state.subject = ALICE;
    expect(await w.call(trades.confirmTrade, { tradeId: proposalId })).toEqual({ ok: false, reason: "not_proposed", status: "proposed" });
    expect(await w.call(trades.undoTrade, { tradeId: proposalId })).toEqual({ ok: false, reason: "window_closed", status: "proposed" });
    expect(await w.db.get(proposalId)).toMatchObject({ status: "proposed", handoff: "pending" });
  });

  it("sees the mark on every read of their own trades, and a button press without one", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    w.state.series = seriesEnding(5, FAIL);
    w.chain.state.close = FAIL;
    w.state.now += 1_000;
    await w.call(runProposer, { strategyId });
    const proposalId = proposalsOf(w)[0]!._id;

    // Newest first.
    const activity = (await w.call(trades.listRecentActivity, {})) as Array<Record<string, unknown>>;
    expect(activity.map((row) => [row.status, row.origin])).toEqual([
      ["refused", undefined],
      ["proposed", "autopilot"],
    ]);
    expect(await w.call(trades.getTrade, { tradeId: proposalId })).toMatchObject({ origin: "autopilot", handoff: "pending", stakeUsd: 10, holdSeconds: 900 });
    const listed = (await w.call(trades.listTradesByStrategy, { strategyId })) as Array<Record<string, unknown>>;
    expect(listed.map((row) => row.origin)).toEqual([undefined, "autopilot"]);

    // Nobody else reads any of it.
    w.state.subject = BOB;
    expect(await w.call(trades.getTrade, { tradeId: proposalId })).toBeNull();
    expect(await w.call(trades.listRecentActivity, {})).toEqual([]);
  });
});

describe("the routes the gateway calls", () => {
  const KEY = "recorder-key-".repeat(4);
  const route = async (path: string, body: unknown, headers: Record<string, string> = { [RECORDER_HEADER]: KEY }) => {
    const found = http.lookup(path, "POST");
    if (!found) throw new Error(`no route at ${path}`);
    const request = new Request(`https://example-123.convex.site${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const res = (await handlerOf(found[0])(w.ctx, request as unknown as Record<string, unknown>)) as Response;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(() => {
    process.env.VENUE_RECORDER_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.VENUE_RECORDER_KEY;
  });

  it("are held by the recorder key, like the routes beside them, and answer nothing without it", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const proposalId = proposalsOf(w)[0]!._id;
    const bodies: Array<[string, unknown]> = [
      ["/autopilot/pending", {}],
      ["/autopilot/begin", open(proposalId)],
      ["/autopilot/start", opened(proposalId, w.state.now)],
      ["/autopilot/report", { proposalId, outcome: "not_opened", reason: "x" }],
    ];
    for (const [path, body] of bodies) {
      expect(await route(path, body, {}), path).toEqual({ status: 403, body: { ok: false, code: "forbidden" } });
      expect(await route(path, body, { [RECORDER_HEADER]: "not-the-key" }), path).toMatchObject({ status: 403 });
      // A signed-in user's own token is not the key.
      expect(await route(path, body, { authorization: "Bearer aaa.bbb.ccc" }), path).toMatchObject({ status: 403 });
    }
    delete process.env.VENUE_RECORDER_KEY;
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [path, body] of bodies) {
      expect(await route(path, body), path).toEqual({ status: 503, body: { ok: false, code: "not_configured" } });
    }
    // Nothing moved.
    expect(await w.db.get(proposalId)).toMatchObject({ status: "proposed", handoff: "pending" });
    expect(w.db.rows("venueOrders")).toEqual([]);
    expect(w.db.rows("timedTrades")).toEqual([]);
  });

  it("turn away a body that is not one of theirs before anything is read", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const proposalId = proposalsOf(w)[0]!._id;
    const bad = { status: 400, body: { ok: false, code: "bad_request" } };
    expect(await route("/autopilot/begin", { ...open(proposalId), userId: "abc" })).toEqual(bad);
    expect(await route("/autopilot/begin", { network: "testnet", asset: "BTC/USD", action: "open" })).toEqual(bad);
    expect(await route("/autopilot/begin", "not json")).toEqual(bad);
    expect(await route("/autopilot/start", { ...opened(proposalId, w.state.now), stakeUsd: 12.5 })).toEqual(bad);
    expect(await route("/autopilot/start", { ...opened(proposalId, w.state.now), userId: "abc" })).toEqual(bad);
    expect(await route("/autopilot/report", { proposalId, outcome: "retry" })).toEqual(bad);
    expect(await route("/autopilot/report", { proposalId, outcome: "not_opened" })).toEqual(bad);
    expect(w.db.rows("venueOrders")).toEqual([]);
    expect((await w.db.get(proposalId))?.handoff).toBe("pending");
  });

  it("carry a proposal from the keeper tick to a running timed trade, with no token anywhere", async () => {
    const { alice } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    w.state.subject = null;

    const listed = await route("/autopilot/pending", {});
    expect(listed.status).toBe(200);
    const proposals = listed.body.proposals as Array<Record<string, unknown>>;
    expect(listed.body.ok).toBe(true);
    expect(proposals).toEqual([{ proposalId: proposalsOf(w)[0]!._id, asset: "BTC/USD", direction: "up", stakeUsd: 10, seconds: 900 }]);
    const proposalId = String(proposals[0]!.proposalId);

    const begun = await route("/autopilot/begin", open(proposalId));
    expect(begun).toMatchObject({ status: 200, body: { ok: true } });
    expect(await w.db.get(String(begun.body.orderId))).toMatchObject({ userId: alice, action: "open", status: "submitting" });
    // Handed to the venue: it is offered to nobody else.
    expect((await route("/autopilot/pending", {})).body.proposals).toEqual([]);

    const started = await route("/autopilot/start", { ...opened(proposalId, w.state.now), openFee: { atoms: "8575", decimals: 6 }, openTx: "0x" + "ab".repeat(32) });
    expect(started).toMatchObject({ status: 200, body: { ok: true } });
    const timedTradeId = String(started.body.tradeId);
    expect(await w.db.get(timedTradeId)).toMatchObject({ userId: alice, origin: "autopilot", proposalId, status: "live", openTx: "0x" + "ab".repeat(32) });

    expect(await route("/autopilot/report", { proposalId, outcome: "opened", timedTradeId })).toEqual({ status: 200, body: { ok: true } });
    expect(await w.db.get(proposalId)).toMatchObject({ status: "executed", handoff: "opened", timedTradeId });
  });

  it("say so, as an answer, when an id is not a pending autopilot proposal", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, FAIL);
    const refusal = w.db.rows("trades")[0]!._id;
    expect(await route("/autopilot/begin", open(refusal))).toEqual({ status: 200, body: { ok: false, code: "not_pending" } });
    expect(await route("/autopilot/start", opened(refusal, w.state.now))).toEqual({ status: 200, body: { ok: false, code: "not_pending" } });
    expect(await route("/autopilot/report", { proposalId: strategyId, outcome: "not_opened", reason: "x" })).toEqual({ status: 200, body: { ok: false, code: "not_found" } });
    expect(w.db.rows("venueOrders")).toEqual([]);
    expect(w.db.rows("timedTrades")).toEqual([]);
  });

  it("finish a proposal that could not be opened, in the venue's words, and offer it no more", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const proposalId = proposalsOf(w)[0]!._id;
    const reason = "The shared account already holds a BTC position.";
    expect(await route("/autopilot/report", { proposalId, outcome: "not_opened", reason })).toEqual({ status: 200, body: { ok: true } });
    expect(await w.db.get(proposalId)).toMatchObject({ status: "undone", handoff: "not_opened", handoffReason: reason });
    expect((await route("/autopilot/pending", {})).body.proposals).toEqual([]);
    expect(await route("/autopilot/begin", open(proposalId))).toEqual({ status: 200, body: { ok: false, code: "not_pending" } });
  });
});
