import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import { BOS20_15M_NO_TARGET, RULE_04, parseDecimal, specHash, stated, type StrategySpec } from "@kanon/spec";
import { run, type BacktestReply } from "./backtest";
import * as backtestData from "./backtestData";
import { CANDLE_PAGE_SIZE } from "./backtestData";
import * as rateLimit from "./rateLimit";
import { RATE_LIMITS } from "./rateLimit";

/**
 * `backtest:run`, run as it is against a database held in memory, the way
 * `autopilotData.test.ts` runs autopilot: each registered function's own handler
 * is called with a stand-in `ctx` whose `runQuery` and `runMutation` find the
 * real handler by the name it is referenced by. Every row a handler reads is
 * counted, by the function that read it, so what a run costs in database I/O is
 * asserted rather than assumed.
 */

// ---------------------------------------------------------------------------
// The stand-in database: tables of rows, read through index ranges.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { _id: string; _creationTime: number };
type Cond = { field: string; op: "eq" | "gte" | "gt" | "lte" | "lt"; value: number | string };

function memoryDb() {
  const tables = new Map<string, Row[]>();
  /** `function name` -> row id -> times read. */
  const reads = new Map<string, Map<string, number>>();
  let reader = "test";
  let made = 0;
  const rows = (table: string): Row[] => tables.get(table) ?? [];
  const note = (row: Row) => {
    const byRow = reads.get(reader) ?? new Map<string, number>();
    byRow.set(row._id, (byRow.get(row._id) ?? 0) + 1);
    reads.set(reader, byRow);
  };
  const holds = (row: Row, c: Cond): boolean => {
    const v = row[c.field] as number | string;
    switch (c.op) {
      case "eq":
        return v === c.value;
      case "gte":
        return v >= c.value;
      case "gt":
        return v > c.value;
      case "lte":
        return v <= c.value;
      case "lt":
        return v < c.value;
    }
  };

  return {
    rows,
    reads,
    as<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const before = reader;
      reader = name;
      return fn().finally(() => {
        reader = before;
      });
    },
    async insert(table: string, doc: Record<string, unknown>): Promise<string> {
      made += 1;
      const row: Row = { ...doc, _id: `${table}:${made}`, _creationTime: made };
      tables.set(table, [...rows(table), row]);
      return row._id;
    },
    async patch(id: string, fields: Record<string, unknown>): Promise<void> {
      const row = [...tables.values()].flat().find((r) => r._id === id);
      if (!row) throw new Error(`no row ${id}`);
      Object.assign(row, fields);
    },
    async replace(id: string, doc: Record<string, unknown>): Promise<void> {
      for (const [table, list] of tables) {
        const i = list.findIndex((r) => r._id === id);
        if (i >= 0) {
          list[i] = { ...doc, _id: id, _creationTime: list[i]!._creationTime };
          tables.set(table, list);
          return;
        }
      }
      throw new Error(`no row ${id}`);
    },
    query(table: string) {
      const conds: Cond[] = [];
      let desc = false;
      const q = {
        eq: (field: string, value: number | string) => (conds.push({ field, op: "eq", value }), q),
        gte: (field: string, value: number) => (conds.push({ field, op: "gte", value }), q),
        gt: (field: string, value: number) => (conds.push({ field, op: "gt", value }), q),
        lte: (field: string, value: number) => (conds.push({ field, op: "lte", value }), q),
        lt: (field: string, value: number) => (conds.push({ field, op: "lt", value }), q),
      };
      const found = (): Row[] => {
        const hit = rows(table).filter((row) => conds.every((c) => holds(row, c)));
        // Index order: by the ranged field when there is one (a candle's `start`), else as written.
        const ranged = conds.find((c) => c.op !== "eq")?.field ?? (table === "candles" ? "start" : null);
        const sorted = ranged
          ? [...hit].sort((a, b) => (a[ranged] as number) - (b[ranged] as number))
          : hit;
        return desc ? sorted.reverse() : sorted;
      };
      const chain = {
        withIndex(_name: string, range?: (b: typeof q) => unknown) {
          range?.(q);
          return chain;
        },
        order(direction: "asc" | "desc") {
          desc = direction === "desc";
          return chain;
        },
        async take(n: number): Promise<Row[]> {
          const out = found().slice(0, n);
          out.forEach(note);
          return out;
        },
        async first(): Promise<Row | null> {
          return (await chain.take(1))[0] ?? null;
        },
      };
      return chain;
    },
  };
}

// ---------------------------------------------------------------------------
// The stand-in ctx
// ---------------------------------------------------------------------------

type Handler = (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
const handlerOf = (fn: unknown): Handler => (fn as { _handler: Handler })._handler;

const ALICE = "did:privy:alice";
const W = 900;
const T0 = 1_800_000_000 - (1_800_000_000 % W);
const px = (v: string) => parseDecimal(v, 2);

function world() {
  const db = memoryDb();
  const state = { now: 0, subject: ALICE as string | null, calls: [] as string[] };
  const named: Record<string, Handler> = {};
  for (const [module, exports] of Object.entries({ backtestData, rateLimit })) {
    for (const [name, fn] of Object.entries(exports)) {
      if (typeof fn === "function" && "_handler" in fn) named[`${module}:${name}`] = handlerOf(fn);
    }
  }
  const call = (ref: FunctionReference<"query" | "mutation">, args: Record<string, unknown>): Promise<unknown> => {
    const name = getFunctionName(ref);
    const handler = named[name];
    if (!handler) throw new Error(`no handler stands in for ${name}`);
    state.calls.push(name);
    return db.as(name, () => handler(ctx, args));
  };
  const ctx = {
    db,
    auth: { getUserIdentity: async () => (state.subject ? { subject: state.subject } : null) },
    runQuery: call,
    runMutation: call,
  };
  const test = (spec: unknown, runIt = true) =>
    handlerOf(run)(ctx, { spec, run: runIt }) as Promise<BacktestReply>;
  return { db, state, test };
}

type World = ReturnType<typeof world>;

/** A long break of structure over 3 candles with a 1% stop and a 2% target: eight candles a window. */
const spec: StrategySpec = {
  ...RULE_04,
  predicates: [
    { kind: "break_of_structure", id: "p1", direction: "long", swingLookbackCandles: stated(3), timeframe: stated("15m") },
  ],
  risk: { riskPerTradeBps: stated(50), stopDistanceBps: stated(100), targetDistanceBps: stated(200) },
};

type Ohlc = [string, string, string, string];
const FLAT: Ohlc = ["100", "101", "99", "100"];
const BREAK_UP: Ohlc = ["100", "105", "100", "105"];
const WIN: Ohlc = ["105", "107.10", "104", "104.50"];

/** Stores candles from bucket `first` on, at `W`, and marks the asset's history ready. */
async function seedCandles(w: World, shapes: Ohlc[], opts: { first?: number; asset?: string; ready?: boolean } = {}) {
  const asset = opts.asset ?? "BTC/USD";
  const first = opts.first ?? 0;
  if (!w.db.rows("candleMeta").some((r) => r.asset === asset)) {
    await w.db.insert("candleMeta", { asset, state: opts.ready === false ? "backfilling" : "ready", cursor: 0 });
  }
  for (const [i, [o, h, l, c]] of shapes.entries()) {
    const start = T0 + (first + i) * W;
    await w.db.insert("candles", {
      asset,
      bucketSeconds: W,
      start,
      open: px(o),
      high: px(h),
      low: px(l),
      close: px(c),
      openTime: start + 1,
      closeTime: start + W - 1,
    });
  }
}

const flats = (n: number): Ohlc[] => Array.from({ length: n }, () => FLAT);

/** The clock 30 seconds into bucket `i`: bucket `i - 1` is the newest closed candle. */
const insideBucket = (i: number) => (T0 + i * W + 30) * 1000;

const candleReads = (w: World) =>
  [...w.db.reads.entries()].flatMap(([fn, byRow]) =>
    [...byRow.entries()].filter(([id]) => id.startsWith("candles:")).map(([id, n]) => ({ fn, id, n })),
  );

let w: World;
beforeEach(() => {
  w = world();
  vi.spyOn(Date, "now").mockImplementation(() => w.state.now);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("backtest:run", () => {
  it("refuses a caller with no token", async () => {
    w.state.subject = null;
    await expect(w.test(spec)).rejects.toThrow(/Sign in/);
  });

  it("refuses something that is not a rule", async () => {
    await expect(w.test({ hello: "world" })).rejects.toThrow();
  });

  it("halts a rule with no stated target before reading anything or spending a slot", async () => {
    await seedCandles(w, flats(40));
    w.state.now = insideBucket(40);
    const out = await w.test(BOS20_15M_NO_TARGET);
    expect(out.status).toBe("halted");
    if (out.status !== "halted") return;
    expect(out.halt.reason).toBe("exits_not_stated");
    expect(out.specHash).toBe(await specHash(BOS20_15M_NO_TARGET));
    expect(out.ran).toBeUndefined();
    expect(w.state.calls).toEqual([]);
    expect(w.db.rows("rateLimits")).toHaveLength(0);
  });

  it("halts while the history is still being built, with no candles, and with too few, spending no slot", async () => {
    w.state.now = insideBucket(40);
    const none = await w.test(spec);
    expect(none.status === "halted" && none.halt.reason).toBe("no_candles");

    await seedCandles(w, flats(40), { ready: false });
    const building = await w.test(spec);
    expect(building.status === "halted" && building.halt.reason).toBe("history_not_ready");

    const fresh = world();
    w = fresh;
    await seedCandles(w, flats(8));
    w.state.now = insideBucket(8);
    const short = await w.test(spec);
    expect(short.status === "halted" && short.halt.reason).toBe("insufficient_history");
    expect(candleReads(w).every((r) => r.fn === "backtestData:bounds")).toBe(true);
    expect(w.db.rows("rateLimits")).toHaveLength(0);
  });

  it("runs, stores the run, and works out the spec hash itself", async () => {
    await seedCandles(w, [...flats(7), BREAK_UP, WIN, ...flats(3)]);
    w.state.now = insideBucket(12);
    const out = await w.test(spec);
    expect(out.status).toBe("result");
    if (out.status !== "result") return;
    expect(out.source).toBe("run");
    expect(out.behindCandles).toBe(0);
    expect(out.throughBucket).toBe(T0 + 11 * W);
    expect(out.result.trades.map((t) => t.outcome)).toEqual(["win"]);
    expect(out.result.range).toMatchObject({ from: T0, to: T0 + 12 * W, candles: 12 });

    const stored = w.db.rows("backtests");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ specHash: await specHash(spec), throughBucket: T0 + 11 * W, asset: "BTC/USD" });
    expect(w.db.rows("rateLimits")[0]).toMatchObject({ subject: ALICE, key: "backtest", count: 1 });
  });

  it("answers from the stored run while it is current, reading no candle and spending no slot", async () => {
    await seedCandles(w, [...flats(7), BREAK_UP, WIN, ...flats(3)]);
    w.state.now = insideBucket(12);
    const first = await w.test(spec);

    w.db.reads.clear();
    w.state.calls = [];
    w.state.now = insideBucket(12) + 600_000; // later, inside the same bucket
    const again = await w.test(spec);
    expect(again.status === "result" && again.source).toBe("stored");
    expect(again.status === "result" && again.result).toEqual(first.status === "result" && first.result);
    expect(w.state.calls).toEqual(["backtestData:cached"]);
    expect(candleReads(w)).toEqual([]);
    expect(w.db.rows("rateLimits")[0]!.count).toBe(1);
  });

  it("never reads the candle still forming", async () => {
    // Twelve closed candles and the one forming now, which would break structure if it were judged.
    await seedCandles(w, [...flats(12), BREAK_UP]);
    w.state.now = insideBucket(12);
    const out = await w.test(spec);
    const forming = w.db.rows("candles").find((r) => r.start === T0 + 12 * W)!;
    expect(candleReads(w).some((r) => r.id === forming._id)).toBe(false);
    expect(out.status === "result" && out.result.range.to).toBe(T0 + 12 * W);
    expect(out.status === "result" && out.result.counts.passed).toBe(0);
  });

  it("pages through a long history reading every candle row exactly once", async () => {
    const n = 2 * CANDLE_PAGE_SIZE + 500;
    await seedCandles(w, flats(n));
    w.state.now = insideBucket(n);
    const out = await w.test(spec);
    expect(out.status === "result" && out.result.range.candles).toBe(n);

    expect(w.state.calls.filter((c) => c === "backtestData:candlePage")).toHaveLength(3);
    const paged = candleReads(w).filter((r) => r.fn === "backtestData:candlePage");
    expect(paged).toHaveLength(n);
    expect(paged.every((r) => r.n === 1)).toBe(true);
    // Outside the pages, only the bounds read touches a candle: the oldest and the newest.
    expect(candleReads(w).filter((r) => r.fn !== "backtestData:candlePage").map((r) => r.fn)).toEqual([
      "backtestData:bounds",
      "backtestData:bounds",
    ]);
  });

  it("reads no further back than the newest 20,000 buckets", async () => {
    // A candle long before the window, and enough after it to run.
    await seedCandles(w, [FLAT], { first: 0 });
    await seedCandles(w, flats(20), { first: 30_000 });
    w.state.now = insideBucket(30_020);
    const out = await w.test(spec);
    expect(out.status === "result" && out.result.range).toMatchObject({ from: T0 + 30_000 * W, candles: 20 });
    const ancient = w.db.rows("candles").find((r) => r.start === T0)!;
    expect(candleReads(w).filter((r) => r.id === ancient._id).map((r) => r.fn)).toEqual(["backtestData:bounds"]);
  });

  it("with run false, answers only from what is stored, and says when nothing is", async () => {
    await seedCandles(w, [...flats(7), BREAK_UP, WIN, ...flats(3)]);
    w.state.now = insideBucket(12);
    const nothing = await w.test(spec, false);
    expect(nothing).toEqual({ status: "not_run", specHash: await specHash(spec) });
    expect(w.state.calls).toEqual(["backtestData:cached"]);

    await w.test(spec, true);
    await seedCandles(w, flats(2), { first: 12 });
    w.state.calls = [];
    w.db.reads.clear();
    w.state.now = insideBucket(14);
    const stale = await w.test(spec, false);
    expect(stale.status === "result" && stale.source).toBe("stored");
    expect(stale.status === "result" && stale.behindCandles).toBe(2);
    expect(candleReads(w)).toEqual([]);
  });

  it("runs again once a newer candle has closed, replacing the one stored row", async () => {
    await seedCandles(w, [...flats(7), BREAK_UP, WIN, ...flats(3)]);
    w.state.now = insideBucket(12);
    await w.test(spec);
    await seedCandles(w, flats(1), { first: 12 });
    w.state.now = insideBucket(13);
    const out = await w.test(spec);
    expect(out.status === "result" && out.source).toBe("run");
    expect(out.status === "result" && out.throughBucket).toBe(T0 + 12 * W);
    expect(w.db.rows("backtests")).toHaveLength(1);
    expect(w.db.rows("backtests")[0]!.throughBucket).toBe(T0 + 12 * W);
    expect(w.db.rows("rateLimits")[0]!.count).toBe(2);
  });

  it("stops running after the hour's runs are spent, and says so", async () => {
    await seedCandles(w, flats(20));
    w.state.now = insideBucket(20);
    const limit = RATE_LIMITS.backtest.limit;
    expect(limit).toBe(6);
    for (let i = 0; i < limit; i++) {
      const differs = { ...spec, risk: { ...spec.risk, stopDistanceBps: stated(100 + i) } };
      expect((await w.test(differs)).status).toBe("result");
    }
    w.db.reads.clear();
    const over = await w.test({ ...spec, risk: { ...spec.risk, stopDistanceBps: stated(99) } });
    expect(over.status).toBe("rate_limited");
    expect(candleReads(w).filter((r) => r.fn === "backtestData:candlePage")).toEqual([]);
    // A stored answer is still free.
    expect((await w.test(spec)).status).toBe("result");
  });
});
