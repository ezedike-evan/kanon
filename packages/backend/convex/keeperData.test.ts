import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RULE_04, predicatesCommitment, specHash } from "@kanon/spec";
import crons from "./crons";
import { acquire, noteTick, publicStatus, recomputeFeeds, release, state } from "./keeperData";
import { LEASE_TTL_MS } from "./keeperLogic";
import { applyVerifiedPin } from "./strategies";

/**
 * The keeper row's handlers, run as they are against a database held in
 * memory: the lease, the day's spend, what a tick writes, and the feeds in use
 * as a pin changes them. Nothing here is deployed and nothing reaches a chain.
 */

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
      const reader = {
        withIndex(_name: string, range: (q: { eq(field: string, value: unknown): unknown }) => unknown) {
          const q = {
            eq(field: string, value: unknown) {
              found = found.filter((row) => row[field] === value);
              return q;
            },
          };
          range(q);
          return reader;
        },
        async take(n: number): Promise<Row[]> {
          return found.slice(0, n);
        },
        async first(): Promise<Row | null> {
          return found[0] ?? null;
        },
      };
      return reader;
    },
  };
}

type Handler = (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
const handlerOf = (fn: unknown): Handler => (fn as { _handler: Handler })._handler;

const DAY = 86_400_000;
const BTC_SERIES = "0x74c4b8710Fb83Dcc18c1A5ae2E35A63dc005257a";
const ETH_SERIES = "0x8D2D1b9DAfA8f68ECcfEC9FDEbbe04268b4ffbf3";

function world() {
  const db = memoryDb();
  const clock = { now: 20_000 * DAY + 3_600_000 };
  const ctx = { db, auth: { getUserIdentity: async () => null } };
  const call = <T = unknown>(fn: unknown, args: Record<string, unknown> = {}): Promise<T> => handlerOf(fn)(ctx, args) as Promise<T>;
  const keeper = () => db.rows("keeper")[0];
  return { db, clock, call, keeper };
}

let w: ReturnType<typeof world>;
beforeEach(() => {
  w = world();
  vi.spyOn(Date, "now").mockImplementation(() => w.clock.now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the signer lease", () => {
  it("is taken by one holder at a time, for two minutes", async () => {
    expect(await w.call(acquire, { holder: "a" })).toEqual({ ok: true, leaseUntil: w.clock.now + LEASE_TTL_MS });
    expect(await w.call(acquire, { holder: "b" })).toMatchObject({ ok: false });
    expect(w.keeper()).toMatchObject({ leaseHolder: "a", leaseUntil: w.clock.now + 120_000 });
  });

  it("passes on once its holder lets go, or once its time runs out", async () => {
    await w.call(acquire, { holder: "a" });
    await w.call(release, { holder: "a", spentWei: "0" });
    expect(w.keeper()?.leaseHolder).toBeUndefined();
    expect(await w.call(acquire, { holder: "b" })).toMatchObject({ ok: true });

    w.clock.now += LEASE_TTL_MS;
    expect(await w.call(acquire, { holder: "c" })).toMatchObject({ ok: true });
    expect(w.keeper()?.leaseHolder).toBe("c");
  });

  it("is not let go of by someone who does not hold it, though what they spent is counted", async () => {
    await w.call(acquire, { holder: "a" });
    await w.call(release, { holder: "b", spentWei: "5" });
    expect(w.keeper()).toMatchObject({ leaseHolder: "a", spentWeiDay: "5" });
  });

  it("adds what was spent under it to the day, and starts a new day at midnight UTC", async () => {
    await w.call(acquire, { holder: "a" });
    await w.call(release, { holder: "a", spentWei: "27745000000000000" });
    await w.call(acquire, { holder: "a" });
    await w.call(release, { holder: "a", spentWei: "5" });
    expect(w.keeper()).toMatchObject({ spentWeiDay: "27745000000000005", dayStart: 20_000 * DAY });

    w.clock.now = 20_001 * DAY + 1;
    await w.call(release, { holder: "a", spentWei: "7" });
    expect(w.keeper()).toMatchObject({ spentWeiDay: "7", dayStart: 20_001 * DAY });
  });

  it("refuses a spend that is not a whole number of wei", async () => {
    await expect(w.call(release, { holder: "a", spentWei: "1.5" })).rejects.toThrow(/whole number/);
  });
});

describe("what a tick writes", () => {
  it("records the buckets, the balance, the signer and the last error; a pause clears when it is over", async () => {
    await w.call(noteTick, {
      sampled: [{ feed: "BTC/USD", bucket: 2_000_000 }],
      paused: "daily_cap",
      error: "BTC/USD: something",
      balanceWei: "3780000000000000000",
      signer: "0xE0072e39D6Fb592BafB3c6783710C1b24EC601b4",
    });
    expect(w.keeper()).toMatchObject({
      sampled: [{ feed: "BTC/USD", bucket: 2_000_000 }],
      paused: "daily_cap",
      lastError: "BTC/USD: something",
      lastErrorAt: w.clock.now,
      balanceWei: "3780000000000000000",
      balanceAt: w.clock.now,
    });
    await w.call(noteTick, { sampled: [{ feed: "BTC/USD", bucket: 2_000_001 }], paused: null, error: null });
    expect(w.keeper()?.paused).toBeUndefined();
    // The last error stays as the record of what last went wrong.
    expect(w.keeper()?.lastError).toBe("BTC/USD: something");
  });

  it("is what the tick reads back, and what anyone may see", async () => {
    expect(await w.call(state)).toBeNull();
    await w.call(noteTick, { sampled: [], paused: null, error: null, balanceWei: "1" });
    expect(await w.call(state)).toMatchObject({ balanceWei: "1" });
    expect(await w.call(publicStatus)).toMatchObject({ enabled: false, paused: "off", balance: { atoms: "1", decimals: 18 } });
  });
});

describe("the feeds in use", () => {
  async function seedPinnedDraft(series: string, chainStrategyId: string) {
    const existing = w.db.rows("users").find((u) => u.privyId === "did:privy:alice");
    const user =
      existing?._id ?? (await w.db.insert("users", { privyId: "did:privy:alice", name: "Alice", username: "alice", experience: "some" }));
    const draft = await w.db.insert("strategies", { ownerUserId: user, pendingSpec: RULE_04, specHash: "0x", status: "draft", autopilot: false });
    await w.call(applyVerifiedPin, {
      subject: "did:privy:alice",
      strategyId: draft,
      specHash: await specHash(RULE_04),
      predicatesCommitment: predicatesCommitment(RULE_04),
      series,
      bondAtoms: { atoms: "0", decimals: 18 },
      txHash: `0x${"ab".repeat(32)}`,
      chainId: 10143,
      registryAddress: `0x${"22".repeat(20)}`,
      chainStrategyId,
    });
    return draft;
  }

  it("gains a pinned rule's pair when it is pinned, and follows the owner to the rule that replaces it", async () => {
    vi.stubEnv("SERIES_BTCUSD_ADDRESS", BTC_SERIES);
    vi.stubEnv("SERIES_ETHUSD_ADDRESS", ETH_SERIES);
    await seedPinnedDraft(BTC_SERIES, "0");
    expect(w.keeper()?.feeds).toEqual(["BTC/USD"]);
    await seedPinnedDraft(ETH_SERIES, "1");
    expect(w.keeper()?.feeds).toEqual(["ETH/USD"]);
  });

  it("counts nothing on a series the deployment does not name", async () => {
    vi.stubEnv("SERIES_BTCUSD_ADDRESS", BTC_SERIES);
    await seedPinnedDraft(`0x${"11".repeat(20)}`, "0");
    expect(w.keeper()?.feeds).toEqual([]);
  });

  it("backfills, by hand, a rule pinned before the keeper existed", async () => {
    const user = await w.db.insert("users", { privyId: "did:privy:alice", name: "Alice", username: "alice", experience: "some" });
    await w.db.insert("strategies", {
      ownerUserId: user,
      spec: RULE_04,
      specHash: "0x",
      status: "pinned",
      pinVerified: true,
      seriesAddress: BTC_SERIES,
      autopilot: false,
    });
    vi.stubEnv("SERIES_BTCUSD_ADDRESS", BTC_SERIES);
    expect(await w.call(recomputeFeeds)).toEqual({ feeds: ["BTC/USD"] });
    expect(w.keeper()).toMatchObject({ feeds: ["BTC/USD"], sampled: [], spentWeiDay: "0" });
  });

  it("leaves the set as it was when a series variable is malformed", async () => {
    await w.call(noteTick, { sampled: [], paused: null, error: null });
    await w.db.patch(w.keeper()!._id, { feeds: ["BTC/USD"] });
    vi.stubEnv("SERIES_BTCUSD_ADDRESS", "0x12");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(w.call(recomputeFeeds)).rejects.toThrow(/malformed/);
    expect(w.keeper()?.feeds).toEqual(["BTC/USD"]);
  });
});

describe("the cron", () => {
  it("ticks the keeper every minute by the name it is exported under; autopilot runs inside it, with no sweep of its own", () => {
    const jobs = (crons as unknown as { crons: Record<string, { name: string; schedule: Record<string, unknown> }> }).crons;
    expect(jobs["keeper tick"]).toMatchObject({ name: "keeper:tick", schedule: { type: "interval", minutes: 1 } });
    expect(jobs["sweep autopilot"]).toBeUndefined();
  });
});
