import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  COOLING_OFF_SECONDS,
  RULE_04,
  RULE_04_LOOSENED,
  applyParamEdit,
  predicatesCommitment,
  specHash,
  type StrategySpec,
} from "@kanon/spec";
import { REGISTRY_TOPICS, padAddress, padUint, type RpcLog, type RpcReceipt } from "./chainLogic";
import * as strategies from "./strategies";
import { amendStrategy, finalizeAmendment, pinStrategy, setAutopilot } from "./strategies";
import * as users from "./users";

/**
 * A rule's row says what the chain says, or it is not written.
 *
 * The actions are run as they are, against a database held in memory and an
 * RPC that answers from a table of receipts. Nothing is deployed. What is
 * being proved is the thing a client could otherwise lie about: that a
 * transaction hash, on its own, records nothing.
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

// ---------------------------------------------------------------------------
// The stand-in chain
// ---------------------------------------------------------------------------

const CHAIN_ID = 10143;
const REGISTRY = "0x00000000000000000000000000000000000000aa";
const ELSEWHERE = "0x00000000000000000000000000000000000000bb";
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const SERIES = "0x3333333333333333333333333333333333333333";
const BOND = 10_000_000_000_000_000n;
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

const words = (...parts: string[]) => "0x" + parts.map((p) => p.slice(2)).join("");
const receiptOf = (logs: RpcLog[], over: Partial<RpcReceipt> = {}): RpcReceipt => ({
  status: "0x1",
  to: REGISTRY,
  from: WALLET,
  logs,
  ...over,
});

const pinnedLog = (o: { id?: bigint; owner?: string; specHash: string; commitment: string; address?: string }): RpcLog => ({
  address: o.address ?? REGISTRY,
  topics: [REGISTRY_TOPICS.pinned, padUint(o.id ?? 7n), padAddress(o.owner ?? WALLET)],
  data: words(o.specHash, padUint(BOND), o.commitment, padAddress(SERIES)),
});
const tightenedLog = (o: { specHash: string; commitment: string }): RpcLog => ({
  address: REGISTRY,
  topics: [REGISTRY_TOPICS.tightened, padUint(7n)],
  data: words("0x" + "00".repeat(32), o.specHash, o.commitment, padAddress(SERIES)),
});
const proposedLog = (o: { specHash: string; commitment: string; endsAtSeconds: number }): RpcLog => ({
  address: REGISTRY,
  topics: [REGISTRY_TOPICS.looseningProposed, padUint(7n)],
  data: words(o.specHash, o.commitment, padAddress(SERIES), padUint(o.endsAtSeconds)),
});
const finalizedLog = (o: { specHash: string; commitment: string }): RpcLog => ({
  address: REGISTRY,
  topics: [REGISTRY_TOPICS.looseningFinalized, padUint(7n)],
  data: words("0x" + "00".repeat(32), o.specHash, o.commitment, padAddress(SERIES)),
});

// ---------------------------------------------------------------------------
// The stand-in ctx
// ---------------------------------------------------------------------------

type Handler = (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
const handlerOf = (fn: unknown): Handler => (fn as { _handler: Handler })._handler;

const ALICE = "did:privy:alice";
const BOB = "did:privy:bob";
const T0 = 1_800_000_000_000;

function world() {
  const db = memoryDb();
  const state = {
    now: T0,
    subject: ALICE as string | null,
    /** What `eth_chainId` answers. */
    rpcChainId: CHAIN_ID,
    /** What `eth_getTransactionReceipt` answers, by hash. A hash not here is a transaction the chain never saw. */
    receipts: new Map<string, RpcReceipt>(),
    /** The methods the RPC was asked, in order. */
    asked: [] as string[],
  };

  const named: Record<string, Handler> = {};
  for (const [module, exports] of Object.entries({ strategies, users })) {
    for (const [name, fn] of Object.entries(exports)) {
      if (typeof fn === "function" && "_handler" in fn) named[`${module}:${name}`] = handlerOf(fn);
    }
  }
  const run = (ref: FunctionReference<"query" | "mutation">, args: Record<string, unknown>): Promise<unknown> => {
    const handler = named[getFunctionName(ref)];
    if (!handler) throw new Error(`no handler stands in for ${getFunctionName(ref)}`);
    return handler(ctx, args);
  };
  const ctx = {
    db,
    auth: { getUserIdentity: async () => (state.subject ? { subject: state.subject } : null) },
    runQuery: run,
    runMutation: run,
  };
  const call = <T = unknown>(fn: unknown, args: Record<string, unknown> = {}): Promise<T> => handlerOf(fn)(ctx, args) as Promise<T>;

  const fetchImpl = async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    state.asked.push(method);
    const answer = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
    if (method === "eth_chainId") return answer("0x" + state.rpcChainId.toString(16));
    if (method === "eth_getTransactionReceipt") return answer(state.receipts.get(String(params[0])) ?? null);
    return { ok: true, status: 200, json: async () => ({ error: { message: "unsupported" } }) };
  };
  return { db, state, ctx, call, fetchImpl };
}

type World = ReturnType<typeof world>;

/**
 * Every wait in the action is run out at once, so a transaction the chain never
 * saw does not cost real seconds. Hashing a spec is real asynchronous work, so
 * a wait can be set after the timers were last run: they are run until the
 * action has answered.
 */
async function settled<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  const tracked = pending.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  while (!done) {
    await vi.runAllTimersAsync();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return await tracked;
}

function edited(spec: StrategySpec, key: string, value: number): StrategySpec {
  const out = applyParamEdit(spec, key, value);
  if (!out.ok) throw new Error(out.error);
  return out.spec;
}

/** RULE_04 at a quarter of the risk: a tightening this server lets apply at once. */
const TIGHTER = edited(RULE_04, "risk.riskPerTradeBps", 25);

async function seedDraft(w: World, over: Record<string, unknown> = {}) {
  const alice = await w.db.insert("users", { privyId: ALICE, name: "Alice", username: "alice", experience: "some", walletAddress: WALLET });
  const bob = await w.db.insert("users", { privyId: BOB, name: "Bob", username: "bob", experience: "some", walletAddress: OTHER });
  const strategyId = await w.db.insert("strategies", {
    ownerUserId: alice,
    pendingSpec: RULE_04,
    specHash: await specHash(RULE_04),
    status: "draft",
    autopilot: false,
    ...over,
  });
  return { alice, bob, strategyId };
}

/** A rule whose pin this backend checked: the state `pinStrategy` leaves behind. */
async function seedPinned(w: World, over: Record<string, unknown> = {}) {
  return await seedDraft(w, {
    pendingSpec: undefined,
    spec: RULE_04,
    status: "pinned",
    chainId: CHAIN_ID,
    registryAddress: REGISTRY,
    chainStrategyId: "7",
    pinTxHash: tx(1),
    pinVerified: true,
    predicatesCommitment: predicatesCommitment(RULE_04),
    seriesAddress: SERIES,
    ...over,
  });
}

async function pinArgs(strategyId: string, over: Record<string, unknown> = {}) {
  return {
    strategyId,
    specHash: await specHash(RULE_04),
    predicatesCommitment: predicatesCommitment(RULE_04),
    series: SERIES,
    // What a client says the bond was. It is not what is recorded.
    bondAtoms: { atoms: "999000000000000000000", decimals: 18 },
    txHash: tx(1),
    chainId: CHAIN_ID,
    registryAddress: REGISTRY,
    chainStrategyId: "7",
    ...over,
  };
}

const realPin = async (over: Partial<Parameters<typeof pinnedLog>[0]> = {}) =>
  receiptOf([pinnedLog({ specHash: await specHash(RULE_04), commitment: predicatesCommitment(RULE_04), ...over })]);

let w: World;
beforeEach(() => {
  w = world();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Date, "now").mockImplementation(() => w.state.now);
  vi.stubGlobal("fetch", (url: string, init: { body: string }) => w.fetchImpl(url, init));
  vi.stubEnv("STRATEGY_REGISTRY_ADDRESS", REGISTRY);
  vi.stubEnv("STRATEGY_REGISTRY_RPC_URL", "https://rpc.example");
  vi.stubEnv("STRATEGY_REGISTRY_CHAIN_ID", String(CHAIN_ID));
  vi.stubEnv("MONAD_RPC_URL", "");
  vi.stubEnv("MONAD_CHAIN_ID", "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const statusOf = async (id: string) => (await w.db.get(id))?.status;

// ---------------------------------------------------------------------------

describe("pinning", () => {
  it("a made-up transaction hash pins nothing", async () => {
    const { strategyId } = await seedDraft(w);
    const out = await settled(w.call(pinStrategy, await pinArgs(strategyId, { txHash: "0x" + "ab".repeat(32) })));
    expect(out).toMatchObject({ ok: false, reason: "not_confirmed" });
    expect(await statusOf(strategyId)).toBe("draft");
    // It was looked for more than once before the answer was no.
    expect(w.state.asked.filter((m) => m === "eth_getTransactionReceipt").length).toBeGreaterThan(1);
  });

  it("a real transaction that is not a pin pins nothing", async () => {
    const { strategyId } = await seedDraft(w);
    w.state.receipts.set(tx(1), receiptOf([]));
    expect(await w.call(pinStrategy, await pinArgs(strategyId))).toMatchObject({ ok: false, reason: "rejected" });
    w.state.receipts.set(tx(1), await realPin({ address: ELSEWHERE }));
    expect(await w.call(pinStrategy, await pinArgs(strategyId))).toMatchObject({ ok: false, reason: "rejected" });
    w.state.receipts.set(tx(1), receiptOf((await realPin()).logs ?? [], { status: "0x0" }));
    expect(await w.call(pinStrategy, await pinArgs(strategyId))).toMatchObject({ ok: false, reason: "rejected" });
    expect(await statusOf(strategyId)).toBe("draft");
  });

  it("somebody else's pin, another strategy's pin, and a pin of another spec pin nothing", async () => {
    const { strategyId } = await seedDraft(w);
    for (const receipt of [
      await realPin({ owner: OTHER }),
      await realPin({ id: 8n }),
      await realPin({ specHash: "0x" + "cd".repeat(32) }),
      await realPin({ commitment: "0x" + "cd".repeat(32) }),
    ]) {
      w.state.receipts.set(tx(1), receipt);
      expect(await w.call(pinStrategy, await pinArgs(strategyId))).toMatchObject({ ok: false, reason: "rejected" });
    }
    expect(await statusOf(strategyId)).toBe("draft");
  });

  it("nothing is pinned where the registry is not configured, and the chain is not even asked", async () => {
    const { strategyId } = await seedDraft(w);
    w.state.receipts.set(tx(1), await realPin());
    vi.stubEnv("STRATEGY_REGISTRY_ADDRESS", "");
    expect(await w.call(pinStrategy, await pinArgs(strategyId))).toMatchObject({ ok: false, reason: "not_configured" });
    expect(w.state.asked).toEqual([]);
    expect(await statusOf(strategyId)).toBe("draft");
  });

  it("nothing is pinned from an RPC on another chain, or for a registry other than the deployed one", async () => {
    const { strategyId } = await seedDraft(w);
    w.state.receipts.set(tx(1), await realPin());
    w.state.rpcChainId = 143;
    expect(await w.call(pinStrategy, await pinArgs(strategyId))).toMatchObject({ ok: false, reason: "not_configured" });
    w.state.rpcChainId = CHAIN_ID;
    expect(await w.call(pinStrategy, await pinArgs(strategyId, { registryAddress: ELSEWHERE }))).toMatchObject({ ok: false, reason: "rejected" });
    expect(await w.call(pinStrategy, await pinArgs(strategyId, { chainId: 143 }))).toMatchObject({ ok: false, reason: "rejected" });
    expect(await statusOf(strategyId)).toBe("draft");
  });

  it("asks for the wallet to be linked before anything is checked against it", async () => {
    const { alice, strategyId } = await seedDraft(w);
    await w.db.patch(alice, { walletAddress: undefined });
    w.state.receipts.set(tx(1), await realPin());
    expect(await w.call(pinStrategy, await pinArgs(strategyId))).toMatchObject({ ok: false, reason: "wallet_not_linked" });
    expect(w.state.asked).toEqual([]);
    expect(await statusOf(strategyId)).toBe("draft");
  });

  it("records the registry's own pin, with the bond the registry holds and not the one the client named", async () => {
    const { strategyId } = await seedDraft(w);
    w.state.receipts.set(tx(1), await realPin());
    const hash = await specHash(RULE_04);
    expect(await w.call(pinStrategy, await pinArgs(strategyId))).toEqual({ ok: true, specHash: hash });
    expect(await w.db.get(strategyId)).toMatchObject({
      status: "pinned",
      pinVerified: true,
      spec: RULE_04,
      specHash: hash,
      bondAtoms: { atoms: BOND.toString(), decimals: 18 },
      chainId: CHAIN_ID,
      registryAddress: REGISTRY,
      chainStrategyId: "7",
      pinTxHash: tx(1),
      pinnedAt: T0,
      seriesAddress: SERIES,
    });
    expect("pendingSpec" in ((await w.db.get(strategyId)) ?? {})).toBe(false);
    // And only now may it be run on autopilot.
    expect(await w.call(setAutopilot, { strategyId, on: true })).toEqual({ autopilot: true });
  });

  it("one registry entry is one rule: it cannot be recorded against a second draft", async () => {
    const { alice, strategyId } = await seedDraft(w);
    w.state.receipts.set(tx(1), await realPin());
    await w.call(pinStrategy, await pinArgs(strategyId));
    const second = await w.db.insert("strategies", {
      ownerUserId: alice,
      pendingSpec: RULE_04,
      specHash: await specHash(RULE_04),
      status: "draft",
      autopilot: false,
    });
    await expect(w.call(pinStrategy, await pinArgs(second))).rejects.toThrow(/already recorded/);
    expect(await statusOf(second)).toBe("draft");
  });

  it("is the owner's alone, and a draft edited after signing is not pinned under the old hash", async () => {
    const { strategyId } = await seedDraft(w);
    w.state.receipts.set(tx(1), await realPin());
    w.state.subject = BOB;
    await expect(w.call(pinStrategy, await pinArgs(strategyId))).rejects.toThrow(/not found/);
    w.state.subject = null;
    await expect(w.call(pinStrategy, await pinArgs(strategyId))).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    w.state.subject = ALICE;
    await w.db.patch(strategyId, { pendingSpec: TIGHTER });
    await expect(w.call(pinStrategy, await pinArgs(strategyId))).rejects.toThrow(/changed after it was signed/);
    expect(await statusOf(strategyId)).toBe("draft");
  });
});

describe("autopilot and a pin nobody checked", () => {
  it("a row that says pinned without a checked pin is not run on autopilot", async () => {
    const { strategyId } = await seedPinned(w, { pinVerified: undefined });
    await expect(w.call(setAutopilot, { strategyId, on: true })).rejects.toThrow(/pin it again/);
    expect((await w.db.get(strategyId))?.autopilot).toBe(false);
  });
});

describe("amending", () => {
  const amendArgs = (strategyId: string, next: StrategySpec, over: Record<string, unknown> = {}) => ({
    strategyId,
    nextSpec: next,
    predicatesCommitment: predicatesCommitment(next),
    series: SERIES,
    txHash: tx(2),
    ...over,
  });

  it("a made-up transaction hash changes nothing", async () => {
    const { strategyId } = await seedPinned(w);
    const out = await settled(w.call(amendStrategy, amendArgs(strategyId, TIGHTER)));
    expect(out).toMatchObject({ ok: false, reason: "not_confirmed" });
    expect((await w.db.get(strategyId))?.spec).toEqual(RULE_04);
  });

  it("the registry's own tightening applies at once", async () => {
    const { strategyId } = await seedPinned(w);
    const hash = await specHash(TIGHTER);
    w.state.receipts.set(tx(2), receiptOf([tightenedLog({ specHash: hash, commitment: predicatesCommitment(TIGHTER) })]));
    expect(await w.call(amendStrategy, amendArgs(strategyId, TIGHTER))).toEqual({ ok: true, kind: "immediate", specHash: hash });
    expect(await w.db.get(strategyId)).toMatchObject({ status: "pinned", spec: TIGHTER, specHash: hash, amendTxHash: tx(2) });
  });

  it("a tightening to some other hash changes nothing", async () => {
    const { strategyId } = await seedPinned(w);
    w.state.receipts.set(tx(2), receiptOf([tightenedLog({ specHash: "0x" + "cd".repeat(32), commitment: predicatesCommitment(TIGHTER) })]));
    expect(await w.call(amendStrategy, amendArgs(strategyId, TIGHTER))).toMatchObject({ ok: false, reason: "rejected" });
    expect((await w.db.get(strategyId))?.spec).toEqual(RULE_04);
  });

  it("a proposed loosening waits until the later of this server's hold and the registry's cooldown", async () => {
    const serverHold = T0 + COOLING_OFF_SECONDS * 1000;
    for (const [chainEndsAtSeconds, expected] of [
      [(serverHold + 3_600_000) / 1000, serverHold + 3_600_000],
      [(serverHold - 3_600_000) / 1000, serverHold],
    ] as const) {
      w = world();
      const { strategyId } = await seedPinned(w);
      const hash = await specHash(RULE_04_LOOSENED);
      w.state.receipts.set(
        tx(2),
        receiptOf([proposedLog({ specHash: hash, commitment: predicatesCommitment(RULE_04_LOOSENED), endsAtSeconds: chainEndsAtSeconds })]),
      );
      // The client's own idea of when the cooldown ends is not read.
      const out = await w.call(amendStrategy, amendArgs(strategyId, RULE_04_LOOSENED, { chainCooldownEndsAt: 1 }));
      expect(out).toEqual({ ok: true, kind: "cooling_off", cooldownEndsAt: expected });
      expect(await w.db.get(strategyId)).toMatchObject({ status: "cooling_off", spec: RULE_04, pendingSpec: RULE_04_LOOSENED, cooldownEndsAt: expected });
    }
  });

  it("a change this server would apply at once still waits when the registry is waiting", async () => {
    const { strategyId } = await seedPinned(w);
    const chainEnd = T0 + 86_400_000;
    w.state.receipts.set(
      tx(2),
      receiptOf([proposedLog({ specHash: await specHash(TIGHTER), commitment: predicatesCommitment(TIGHTER), endsAtSeconds: chainEnd / 1000 })]),
    );
    expect(await w.call(amendStrategy, amendArgs(strategyId, TIGHTER))).toEqual({ ok: true, kind: "cooling_off", cooldownEndsAt: chainEnd });
    expect(await w.db.get(strategyId)).toMatchObject({ status: "cooling_off", spec: RULE_04, pendingSpec: TIGHTER });
  });

  it("a loosening the registry applied at once is not recorded: here it waits, and there is nothing pending to apply later", async () => {
    const { strategyId } = await seedPinned(w);
    w.state.receipts.set(
      tx(2),
      receiptOf([tightenedLog({ specHash: await specHash(RULE_04_LOOSENED), commitment: predicatesCommitment(RULE_04_LOOSENED) })]),
    );
    expect(await w.call(amendStrategy, amendArgs(strategyId, RULE_04_LOOSENED))).toMatchObject({ ok: false, reason: "rejected" });
    expect(await w.db.get(strategyId)).toMatchObject({ status: "pinned", spec: RULE_04 });
  });

  it("a rule whose pin was never checked, or that names another registry, cannot be changed", async () => {
    for (const over of [{ pinVerified: undefined }, { registryAddress: ELSEWHERE }, { chainId: 143 }]) {
      w = world();
      const { strategyId } = await seedPinned(w, over);
      w.state.receipts.set(
        tx(2),
        receiptOf([tightenedLog({ specHash: await specHash(TIGHTER), commitment: predicatesCommitment(TIGHTER) })]),
      );
      expect(await w.call(amendStrategy, amendArgs(strategyId, TIGHTER))).toMatchObject({ ok: false, reason: "rejected" });
      expect((await w.db.get(strategyId))?.spec).toEqual(RULE_04);
    }
  });

  it("no change is no change, and the chain is not asked", async () => {
    const { strategyId } = await seedPinned(w);
    expect(await w.call(amendStrategy, amendArgs(strategyId, structuredClone(RULE_04)))).toEqual({ ok: true, kind: "none" });
    expect(w.state.asked).toEqual([]);
  });
});

describe("applying a loosening", () => {
  const cooling = async () =>
    await seedPinned(w, {
      status: "cooling_off",
      pendingSpec: RULE_04_LOOSENED,
      pendingPredicatesCommitment: predicatesCommitment(RULE_04_LOOSENED),
      pendingSeriesAddress: SERIES,
      cooldownEndsAt: T0 + 1000,
    });
  const applied = async () =>
    receiptOf([finalizedLog({ specHash: await specHash(RULE_04_LOOSENED), commitment: predicatesCommitment(RULE_04_LOOSENED) })]);

  it("is refused a millisecond before the hold ends, whatever the chain says", async () => {
    const { strategyId } = await cooling();
    w.state.receipts.set(tx(3), await applied());
    w.state.now = T0 + 999;
    await expect(w.call(finalizeAmendment, { strategyId, txHash: tx(3) })).rejects.toThrow(/has not elapsed/);
    expect(await statusOf(strategyId)).toBe("cooling_off");
  });

  it("a made-up hash, or a transaction that applied nothing, applies nothing here", async () => {
    const { strategyId } = await cooling();
    w.state.now = T0 + 1000;
    expect(await settled(w.call(finalizeAmendment, { strategyId, txHash: tx(3) }))).toMatchObject({ ok: false, reason: "not_confirmed" });
    w.state.receipts.set(tx(3), receiptOf([]));
    expect(await w.call(finalizeAmendment, { strategyId, txHash: tx(3) })).toMatchObject({ ok: false, reason: "rejected" });
    expect(await w.db.get(strategyId)).toMatchObject({ status: "cooling_off", spec: RULE_04 });
  });

  it("the registry adopting the pending spec is what applies it", async () => {
    const { strategyId } = await cooling();
    w.state.now = T0 + 1000;
    w.state.receipts.set(tx(3), await applied());
    const hash = await specHash(RULE_04_LOOSENED);
    expect(await w.call(finalizeAmendment, { strategyId, txHash: tx(3) })).toEqual({ ok: true, specHash: hash });
    const row = (await w.db.get(strategyId)) ?? {};
    expect(row).toMatchObject({ status: "pinned", spec: RULE_04_LOOSENED, specHash: hash, amendTxHash: tx(3) });
    expect("pendingSpec" in row || "cooldownEndsAt" in row).toBe(false);
  });
});
