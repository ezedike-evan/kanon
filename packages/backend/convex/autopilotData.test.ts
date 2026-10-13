import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  RULE_04,
  parseDecimal,
  predicatesCommitment,
  specHash,
  stated,
  type Candle,
  type Series,
  type StrategySpec,
} from "@kanon/spec";
import { sweep } from "./autopilot";
import * as autopilotData from "./autopilotData";
import { HANDOFF_EXPIRY_MS, HANDOFF_MESSAGES, HANDOFF_WINDOW_MS } from "./autopilotLogic";
import crons from "./crons";
import http from "./http";
import { runProposer } from "./proposer";
import * as proposerData from "./proposerData";
import { applyVerifiedPin, setAutopilot } from "./strategies";
import * as timedData from "./timedData";
import * as trades from "./trades";
import * as venueData from "./venueData";
import { ORDER_LOCK_MS, RECORDER_HEADER } from "./venueLogic";

/**
 * Autopilot's handlers, run as they are against a database held in memory.
 *
 * Nothing here is deployed and nothing reaches a venue. Each registered
 * function's own handler is called with a stand-in `ctx`: the database below,
 * a token's identity, and `runQuery` / `runMutation` that find the real handler
 * by the name it is referenced by. The one thing that is not real is the price
 * series, which a test supplies, so a candle can be made to pass or to fail.
 *
 * Functions here are referenced by name, as strings, which no type check reads.
 * Every name the sweep and the routes use is resolved below against the modules
 * themselves, so one that names nothing fails a test.
 */

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
// The stand-in ctx
// ---------------------------------------------------------------------------

type Handler = (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
const handlerOf = (fn: unknown): Handler => (fn as { _handler: Handler })._handler;

const ALICE = "did:privy:alice";
const BOB = "did:privy:bob";

const T0 = 1_800_000_000 - (1_800_000_000 % 900); // a 15m boundary
const at = (i: number) => T0 + i * 900;
const px = (v: string) => parseDecimal(v, 2);

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

function world() {
  const db = memoryDb();
  const state = {
    /** Unix milliseconds: what `Date.now()` reads inside a handler. */
    now: at(5) * 1000 + 30_000,
    /** Whose token the next public call carries. Null is nobody. */
    subject: ALICE as string | null,
    /** What `series:getSeries` answers, or an error for it to throw: one answer for every asset, or one per asset. */
    series: seriesEnding(4, FAIL) as SeriesAnswer | ((asset: string) => SeriesAnswer),
    seriesReads: 0,
    scheduled: [] as unknown[],
  };

  const named: Record<string, Handler> = {
    "series:getSeries": async (_ctx, args) => {
      state.seriesReads += 1;
      const answer = typeof state.series === "function" ? state.series(String(args.asset)) : state.series;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  // `module:export`, exactly as Convex names a function: a reference that is misspelt finds nothing.
  for (const [module, exports] of Object.entries({ autopilotData, proposerData, timedData, trades, venueData })) {
    for (const [name, fn] of Object.entries(exports)) {
      if (typeof fn === "function" && "_handler" in fn) named[`${module}:${name}`] = handlerOf(fn);
    }
  }
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
  return { db, state, ctx, call };
}

type World = ReturnType<typeof world>;

async function seed(w: World, over: Record<string, unknown> = {}) {
  const alice = await w.db.insert("users", { privyId: ALICE, name: "Alice", username: "alice", experience: "some" });
  const bob = await w.db.insert("users", { privyId: BOB, name: "Bob", username: "bob", experience: "some" });
  const strategyId = await w.db.insert("strategies", {
    ownerUserId: alice,
    spec: bosSpec,
    specHash: "0xspec",
    status: "pinned",
    // The pin was read from the chain (`strategies:pinStrategy`): without that, autopilot runs nothing.
    pinVerified: true,
    autopilot: false,
    ...over,
  });
  return { alice, bob, strategyId };
}

/** The sweep at half a minute past the close of the candle `at(closed)`, with a series whose last candle is that one. */
async function sweepAfter(w: World, closed: number, close: string) {
  w.state.now = at(closed + 1) * 1000 + 30_000;
  w.state.series = seriesEnding(closed, close);
  return (await w.call(sweep)) as Record<string, number>;
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
  w = world();
  vi.spyOn(Date, "now").mockImplementation(() => w.state.now);
});
afterEach(() => {
  vi.restoreAllMocks();
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

  it("forgets the last candle judged when it is turned on again, and keeps it when asked for what it already is", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(3) });
    await w.call(setAutopilot, { strategyId, on: true });
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(3));
    await w.call(setAutopilot, { strategyId, on: false });
    await w.call(setAutopilot, { strategyId, on: true });
    expect("autopilotBucket" in ((await w.db.get(strategyId)) ?? {})).toBe(false);
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

describe("the sweep", () => {
  it("is run every minute, by the name it is exported under, and by nothing a client can call", () => {
    const jobs = (crons as unknown as { crons: Record<string, { name: string; schedule: Record<string, unknown> }> }).crons;
    expect(jobs["sweep autopilot"]).toMatchObject({ name: "autopilot:sweep", schedule: { type: "interval", minutes: 1 } });
    const registered = sweep as unknown as { isAction?: boolean; isInternal?: boolean; isPublic?: boolean };
    expect([registered.isAction, registered.isInternal, registered.isPublic]).toEqual([true, true, undefined]);
  });

  it("judges nothing on its first pass after autopilot is turned on, whatever the candle that just closed did", async () => {
    const { strategyId } = await seed(w);
    await w.call(setAutopilot, { strategyId, on: true });

    // The candle that closed before it was turned on would have passed. It is not replayed.
    expect(await sweepAfter(w, 4, PASS)).toMatchObject({ armed: 1, proposed: 0, refused: 0 });
    expect(w.db.rows("trades")).toEqual([]);
    expect(w.state.seriesReads).toBe(0);
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(4));
  });

  it("judges nothing for a rule whose pin was never read from the chain, even with autopilot on", async () => {
    // A row left `pinned` by a client's say-so, from before pins were checked, with autopilot already on.
    const { strategyId } = await seed(w, { pinVerified: undefined, autopilot: true, autopilotBucket: at(3) });

    expect(await sweepAfter(w, 4, PASS)).toMatchObject({ proposed: 0, refused: 0 });
    expect(w.db.rows("trades")).toEqual([]);
    expect(w.state.seriesReads).toBe(0);
    // And it cannot be turned back on once it is off.
    await w.call(setAutopilot, { strategyId, on: false });
    await expect(w.call(setAutopilot, { strategyId, on: true })).rejects.toThrow(/pin it again/);
  });

  it("judges each closed candle once, however many times it runs before the next close", async () => {
    const { strategyId } = await seed(w);
    await w.call(setAutopilot, { strategyId, on: true });
    await sweepAfter(w, 4, FAIL);

    // A sweep a minute through the candle that is forming: nothing has closed, nothing is read.
    for (let minute = 1; minute < 14; minute++) {
      w.state.now += 60_000;
      expect(await w.call(sweep)).toMatchObject({ armed: 0, proposed: 0, refused: 0, skipped: 0 });
    }
    expect(w.state.seriesReads).toBe(0);

    expect(await sweepAfter(w, 5, FAIL)).toMatchObject({ refused: 1 });
    w.state.now += 60_000;
    expect(await w.call(sweep)).toMatchObject({ refused: 0 });
    expect(w.db.rows("trades")).toHaveLength(1);
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(5));
  });

  it("records a refusal as a button press does, and marks it as autopilot's", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, FAIL);
    const [byAutopilot] = w.db.rows("trades");

    w.state.subject = ALICE;
    expect(await w.call(runProposer, { strategyId })).toMatchObject({ status: "refused" });
    const byButton = w.db.rows("trades")[1];

    // The same verdict, the same numbers, the same evidence. Only who asked differs.
    const { _id: _a, _creationTime: _b, origin, ...swept } = byAutopilot ?? {};
    const { _id: _c, _creationTime: _d, ...pressed } = byButton ?? {};
    expect(origin).toBe("autopilot");
    expect(swept).toEqual(pressed);
    expect(pressed).toMatchObject({
      status: "refused",
      failedPredicateId: "p1",
      failedSymbol: "bos_bullish",
      failingValue: px(FAIL),
      requiredValue: px("101"),
    });
    expect("origin" in pressed).toBe(false);
    expect("handoff" in swept).toBe(false);
  });

  it("writes a proposal for the gateway when every predicate passes: no undo window, no paper execution", async () => {
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
    });
    expect("undoExpiresAt" in (row ?? {})).toBe(false);
    expect(w.state.scheduled).toEqual([]);
  });

  it("leaves a button press exactly as it was: its undo window, its paper execution, no mark", async () => {
    const { strategyId } = await seed(w);
    w.state.now = at(6) * 1000 + 30_000;
    w.state.series = seriesEnding(5, PASS);
    const out = (await w.call(runProposer, { strategyId })) as { status: string; tradeId: string };
    expect(out.status).toBe("proposed");
    const row = await w.db.get(out.tradeId);
    expect(row).toMatchObject({ status: "proposed", undoExpiresAt: w.state.now + 7_000 });
    for (const field of ["origin", "handoff", "stakeUsd", "holdSeconds"]) expect(field in (row ?? {})).toBe(false);
    expect(w.state.scheduled).toHaveLength(1);
    // And it does not move autopilot's own place.
    expect("autopilotBucket" in ((await w.db.get(strategyId)) ?? {})).toBe(false);
  });

  it("writes nothing when the series cannot support an answer, and tries the same candle again", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    // The newest candle is hours old: a setup is not judged against old prices.
    w.state.now = at(40) * 1000 + 30_000;
    w.state.series = seriesEnding(5, PASS);
    expect(await w.call(sweep)).toMatchObject({ unavailable: 1, proposed: 0, refused: 0 });
    expect(w.db.rows("trades")).toEqual([]);
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(4));

    // The series catches up a minute later: that candle is judged then.
    w.state.now += 60_000;
    w.state.series = seriesEnding(39, FAIL);
    expect(await w.call(sweep)).toMatchObject({ refused: 1 });
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(39));
  });

  it("keeps judging the rest when one strategy cannot be read", async () => {
    const { alice } = await seed(w, { autopilot: true, autopilotBucket: at(4), spec: { ...bosSpec, series: { ...bosSpec.series, asset: "ETH/USD" } } });
    const second = await w.db.insert("strategies", { ownerUserId: alice, spec: bosSpec, specHash: "0xother", status: "pinned", pinVerified: true, autopilot: true, autopilotBucket: at(4) });
    w.state.now = at(6) * 1000 + 30_000;
    // The first strategy's read throws; the second's answers.
    w.state.series = (asset) => (asset === "ETH/USD" ? new Error("read failed") : seriesEnding(5, FAIL));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await w.call(sweep)).toMatchObject({ failed: 1, refused: 1 });
    expect(w.db.rows("trades").map((row) => row.strategyId)).toEqual([second]);
  });

  it("leaves alone a strategy autopilot is off for, and one whose stored spec does not parse", async () => {
    const { alice } = await seed(w, { autopilot: false, autopilotBucket: at(1) });
    await w.db.insert("strategies", { ownerUserId: alice, spec: { not: "a spec" }, specHash: "0xbad", status: "pinned", pinVerified: true, autopilot: true, autopilotBucket: at(1) });
    expect(await sweepAfter(w, 5, PASS)).toEqual({ armed: 0, proposed: 0, refused: 0, skipped: 0, unavailable: 0, failed: 0, expired: 0 });
    expect(w.db.rows("trades")).toEqual([]);
  });

  it("does not judge a candle twice when two sweeps overlap: the write itself checks", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(5) });
    const row = {
      strategyId,
      direction: "long",
      asset: "BTC/USD",
      entry: px(PASS),
      size: px("1"),
      stop: px("104"),
      status: "refused",
      satisfiedPredicateIds: [],
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
    // Already judged, by whichever sweep got there first.
    expect(await w.call(trades.recordEvaluation, row)).toBeNull();
    // Turned off between the read and the write.
    await w.db.patch(strategyId, { autopilot: false });
    expect(await w.call(trades.recordEvaluation, { ...row, autopilot: { ...row.autopilot, bucket: at(6) } })).toBeNull();
    // Never armed: the first sweep only notes where it starts.
    await w.db.patch(strategyId, { autopilot: true, autopilotBucket: undefined });
    expect(await w.call(trades.recordEvaluation, { ...row, autopilot: { ...row.autopilot, bucket: at(6) } })).toBeNull();
    expect(w.db.rows("trades")).toEqual([]);
  });
});

describe("one autopilot trade per strategy at a time", () => {
  it("records nothing for a candle that passes while the last proposal is waiting, and still records a refusal", async () => {
    const { strategyId } = await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const [first] = proposalsOf(w);
    await w.call(autopilotData.begin, open(first!._id));
    // The next candle closes while that order is still unanswered, and not yet given up on. (A 15m
    // candle outlasts any order; the proposal is made young again so this holds for a 1m one too.)
    w.state.now = at(7) * 1000 + 30_000;
    await w.db.patch(first!._id, { createdAt: w.state.now - HANDOFF_WINDOW_MS });

    w.state.series = seriesEnding(6, PASS);
    expect(await w.call(sweep)).toMatchObject({ proposed: 0, skipped: 1 });
    expect(w.db.rows("trades")).toHaveLength(1);
    // The candle counts as judged: it is not written later, when the trade has ended.
    expect((await w.db.get(strategyId))?.autopilotBucket).toBe(at(6));

    await w.db.patch(first!._id, { createdAt: at(8) * 1000 });
    expect(await sweepAfter(w, 7, FAIL)).toMatchObject({ refused: 1, skipped: 0 });
    expect(w.db.rows("trades").map((row) => row.status)).toEqual(["proposed", "refused"]);
  });

  it("records nothing for a candle that passes while its trade is running, and proposes again once that has closed", async () => {
    await seed(w, { autopilot: true, autopilotBucket: at(4) });
    await sweepAfter(w, 5, PASS);
    const [first] = proposalsOf(w);
    await w.call(autopilotData.begin, open(first!._id));
    const started = (await w.call(autopilotData.start, opened(first!._id, w.state.now))) as { ok: true; tradeId: string };

    expect(await sweepAfter(w, 6, PASS)).toMatchObject({ proposed: 0, skipped: 1 });
    expect(await sweepAfter(w, 7, FAIL)).toMatchObject({ refused: 1 });
    expect(proposalsOf(w)).toHaveLength(1);

    // The gateway closes the trade when its time is up, as it closes any timed trade.
    await w.call(timedData.update, { tradeId: started.tradeId, status: "closed", endedBy: "time", closedAt: w.state.now });
    expect(await sweepAfter(w, 8, PASS)).toMatchObject({ proposed: 1, skipped: 0 });
    expect(proposalsOf(w).map((row) => row.handoff)).toEqual(["opened", "pending"]);
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

  it("is finished by the sweep when the gateway never picked it up, and says nothing was sent", async () => {
    const { proposalId } = await proposal();
    w.state.now += HANDOFF_EXPIRY_MS - 1;
    expect(await w.call(sweep)).toMatchObject({ expired: 0 });
    expect((await w.db.get(proposalId))?.handoff).toBe("pending");
    w.state.now += 1;
    expect(await w.call(sweep)).toMatchObject({ expired: 1 });
    expect(await w.db.get(proposalId)).toMatchObject({ status: "undone", handoff: "not_opened", handoffReason: HANDOFF_MESSAGES.notPickedUp });
  });

  it("is finished by the sweep when its order went out and nothing was ever said, and says to look", async () => {
    const { proposalId } = await proposal();
    await w.call(autopilotData.begin, open(proposalId));
    w.state.now += HANDOFF_EXPIRY_MS;
    await w.call(sweep);
    expect(await w.db.get(proposalId)).toMatchObject({ status: "undone", handoff: "not_opened", handoffReason: HANDOFF_MESSAGES.noAnswer });
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

  it("carry a proposal from the sweep to a running timed trade, with no token anywhere", async () => {
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
