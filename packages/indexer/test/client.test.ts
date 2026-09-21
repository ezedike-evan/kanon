import { describe, expect, it, vi } from "vitest";
import {
  createIndexerClient,
  IndexerError,
  pairRefusalsWithPrices,
  tallyOutcomes,
  wouldHaveLost,
  type FetchLike,
  type PriceSampleEntry,
  type RefusalEntry,
} from "../src/client";

const OWNER = "0x00000000000000000000000000000000000000aa";
const SERIES = "0x0000000000000000000000000000000000000007";
const SPEC = `0x${"a1".repeat(32)}`;
const COMMIT = `0x${"c3".repeat(32)}`;

function mockFetch(data: unknown, init: { ok?: boolean; status?: number; errors?: unknown } = {}) {
  const fn = vi.fn<FetchLike>(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => (init.errors ? { errors: init.errors } : { data }),
  }));
  return fn;
}

const bodyOf = (fn: ReturnType<typeof mockFetch>, call = 0) => JSON.parse(fn.mock.calls[call]![1].body) as {
  operationName: string;
  query: string;
  variables: Record<string, any>;
};

const tradeRow = (over: Record<string, unknown> = {}) => ({
  id: "143_10_1",
  chainId: 143,
  kind: "REFUSED",
  account: OWNER,
  actor: null,
  contractAddress: "0x0000000000000000000000000000000000000002",
  contractName: "RefusalGate",
  vault: null,
  strategy_id: "143_0",
  specHash: SPEC,
  assetId: null,
  series: null,
  isLong: null,
  size: null,
  price: null,
  pnl: null,
  reason: "bos_long",
  decidingValue: "-42",
  position_id: null,
  refusal_id: "143_10_1",
  timestamp: 1000,
  blockNumber: 10,
  logIndex: 1,
  txHash: "0xdead",
  ...over,
});

const refusal = (timestamp: number, over: Partial<RefusalEntry> = {}): RefusalEntry => ({
  id: `143_${timestamp}_0`,
  chainId: 143,
  gate: "0x0000000000000000000000000000000000000002",
  strategy_id: "143_0",
  specHash: SPEC,
  proposer: OWNER,
  account: OWNER,
  actor: null,
  vault: null,
  predicate: "bos_long",
  predicateRaw: "0x",
  decidingValue: 1n,
  timestamp,
  blockNumber: timestamp,
  logIndex: 0,
  txHash: `0x${timestamp}`,
  ...over,
});

const sample = (publishTime: number, price: bigint, expo = -8): PriceSampleEntry => ({
  id: `s${publishTime}`,
  series: SERIES,
  bucketIndex: String(publishTime),
  price,
  expo,
  publishTime,
  txHash: `0xs${publishTime}`,
});

describe("getTradeHistory", () => {
  it("queries by account, actor, vault and contract, lowercases the address, and parses bigints", async () => {
    const fetch = mockFetch({ TradeLog: [tradeRow(), tradeRow({ id: "b", decidingValue: 7, size: "12345678901234567890" })] });
    const client = createIndexerClient({ url: "http://idx/v1/graphql", fetch });
    const rows = await client.getTradeHistory(OWNER.toUpperCase().replace("0X", "0x"), { limit: 10, kinds: ["REFUSED"], since: 500 });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "REFUSED", decidingValue: -42n, txHash: "0xdead", specHash: SPEC, actor: null });
    expect(rows[1]).toMatchObject({ decidingValue: 7n, size: 12345678901234567890n });

    const call = bodyOf(fetch);
    expect(fetch.mock.calls[0]![0]).toBe("http://idx/v1/graphql");
    expect(call.operationName).toBe("KanonTradeHistory");
    expect(call.variables.limit).toBe(10);
    const and = call.variables.where._and;
    expect(and[0]).toEqual({ chainId: { _eq: 143 } });
    expect(and[1]._or).toContainEqual({ account: { _eq: OWNER } });
    expect(and[1]._or).toContainEqual({ vault: { _eq: OWNER } });
    expect(and).toContainEqual({ timestamp: { _gte: 500 } });
    expect(and).toContainEqual({ kind: { _in: ["REFUSED"] } });
    expect(call.variables.order[0]).toEqual({ timestamp: "desc" });
  });

  it("rejects malformed addresses before any request is made", async () => {
    const fetch = mockFetch({ TradeLog: [] });
    const client = createIndexerClient({ url: "http://idx", fetch });
    await expect(client.getTradeHistory("not-an-address")).rejects.toThrow(IndexerError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clamps limit and offset", async () => {
    const fetch = mockFetch({ TradeLog: [] });
    const client = createIndexerClient({ url: "http://idx", fetch });
    await client.getTradeHistory(OWNER, { limit: 999_999, offset: -5 });
    expect(bodyOf(fetch).variables).toMatchObject({ limit: 1000, offset: 0 });
  });

  it("throws on a JSON number that lost precision instead of rounding it", async () => {
    const fetch = mockFetch({ TradeLog: [tradeRow({ decidingValue: 1.2345678901234567e21 })] });
    const client = createIndexerClient({ url: "http://idx", fetch });
    await expect(client.getTradeHistory(OWNER)).rejects.toThrow(/did not match the expected shape/);
  });

  it("surfaces GraphQL errors and HTTP failures", async () => {
    const client = createIndexerClient({
      url: "http://idx",
      fetch: mockFetch(null, { errors: [{ message: "field 'Nope' not found" }] }),
    });
    await expect(client.getTradeHistory(OWNER)).rejects.toThrow(/field 'Nope' not found/);

    const down = createIndexerClient({ url: "http://idx", fetch: mockFetch(null, { ok: false, status: 503 }) });
    await expect(down.getTradeHistory(OWNER)).rejects.toThrow(/HTTP 503/);
  });

  it("sends custom headers and honours a different chain", async () => {
    const fetch = mockFetch({ TradeLog: [] });
    const client = createIndexerClient({ url: "http://idx", fetch, headers: { "x-hasura-admin-secret": "s" }, chainId: 10143 });
    await client.getTradeHistory(OWNER);
    expect(fetch.mock.calls[0]![1].headers["x-hasura-admin-secret"]).toBe("s");
    expect(bodyOf(fetch).variables.where._and[0]).toEqual({ chainId: { _eq: 10143 } });
  });
});

describe("getRefusals", () => {
  const row = {
    id: "143_10_1",
    chainId: 143,
    gate: "0x0000000000000000000000000000000000000002",
    strategy_id: "143_3",
    specHash: SPEC,
    proposer: OWNER,
    account: OWNER,
    actor: null,
    vault: null,
    predicate: "bos_long",
    predicateRaw: "0x626f735f6c6f6e67",
    decidingValue: "9",
    timestamp: 1000,
    blockNumber: 10,
    logIndex: 1,
    txHash: "0xdead",
  };

  it("filters by strategy and returns evidence fields", async () => {
    const fetch = mockFetch({ Refusal: [row] });
    const client = createIndexerClient({ url: "http://idx", fetch });
    const out = await client.getRefusals(OWNER, { strategyId: 3, ascending: true });
    expect(out[0]).toMatchObject({ specHash: SPEC, txHash: "0xdead", predicate: "bos_long", decidingValue: 9n });
    const call = bodyOf(fetch);
    expect(call.variables.where._and).toContainEqual({ strategy_id: { _eq: "143_3" } });
    expect(call.variables.order[0]).toEqual({ timestamp: "asc" });
  });

  it("rejects a non-numeric strategy id", async () => {
    const client = createIndexerClient({ url: "http://idx", fetch: mockFetch({ Refusal: [] }) });
    await expect(client.getRefusals(OWNER, { strategyId: "1; drop" })).rejects.toThrow(/strategy id/);
  });
});

describe("getStrategyTimeline", () => {
  it("returns the strategy and its events oldest first", async () => {
    const fetch = mockFetch({
      Strategy_by_pk: {
        id: "143_0",
        chainId: 143,
        registry: "0x0000000000000000000000000000000000000001",
        strategyId: "0",
        owner: OWNER,
        activeSpecHash: SPEC,
        predicatesCommitment: COMMIT,
        series: SERIES,
        bond: "5000000000000000000",
        pinnedAt: 100,
        pendingSpecHash: null,
        pendingPredicatesCommitment: null,
        pendingSeries: null,
        cooldownEndsAt: null,
        tightenCount: 1,
        looseningCount: 0,
        proposalCount: 2,
        refusalCount: 5,
        lastActivityAt: 300,
      },
      StrategyEvent: [
        {
          id: "e1",
          strategy_id: "143_0",
          chainId: 143,
          kind: "PINNED",
          oldSpecHash: null,
          newSpecHash: SPEC,
          predicatesCommitment: COMMIT,
          series: SERIES,
          oldPredicatesCommitment: null,
          oldSeries: null,
          cooldownEndsAt: null,
          bond: "5000000000000000000",
          actor: OWNER,
          timestamp: 100,
          blockNumber: 1,
          logIndex: 0,
          txHash: "0x01",
        },
      ],
    });
    const client = createIndexerClient({ url: "http://idx", fetch });
    const t = await client.getStrategyTimeline(0n);
    expect(t.strategy).toMatchObject({ refusalCount: 5, bond: 5_000_000_000_000_000_000n, pendingSpecHash: null, predicatesCommitment: COMMIT, series: SERIES });
    expect(t.events[0]).toMatchObject({ kind: "PINNED", txHash: "0x01", predicatesCommitment: COMMIT, series: SERIES });
    expect(bodyOf(fetch).variables).toEqual({ id: "143_0" });
  });

  it("returns a null strategy for an unknown id", async () => {
    const client = createIndexerClient({ url: "http://idx", fetch: mockFetch({ Strategy_by_pk: null, StrategyEvent: [] }) });
    expect(await client.getStrategyTimeline(99)).toEqual({ strategy: null, events: [] });
  });
});

describe("getAccount", () => {
  it("returns counters or null", async () => {
    const acc = { id: `143_${OWNER}`, address: OWNER, proposalCount: 1, refusalCount: 4, openedCount: 0, closedCount: 0, liquidationCount: 0, boundStrategy_id: null, firstSeenAt: 1, lastActivityAt: 2 };
    const client = createIndexerClient({ url: "http://idx", fetch: mockFetch({ Account_by_pk: acc }) });
    expect((await client.getAccount(OWNER))?.refusalCount).toBe(4);
    const none = createIndexerClient({ url: "http://idx", fetch: mockFetch({ Account_by_pk: null }) });
    expect(await none.getAccount(OWNER)).toBeNull();
  });
});

describe("refusal outcomes", () => {
  it("pairs each refusal with the price at refusal and at the horizon", () => {
    const samples = [sample(90, 100n), sample(150, 95n), sample(400, 120n)];
    const out = pairRefusalsWithPrices([refusal(100), refusal(300)], samples, 100, 10_000);
    expect(out[0]!.priceAtRefusal?.price).toBe(100n); // sample at 90
    expect(out[0]!.priceAtHorizon?.price).toBe(95n); // sample at 150, horizon ends 200
    expect(out[1]!.priceAtRefusal?.price).toBe(95n);
    expect(out[1]!.priceAtHorizon?.price).toBe(120n); // horizon ends at 400, sample at 400 counts
  });

  it("reports no horizon price while the horizon has not elapsed", () => {
    const out = pairRefusalsWithPrices([refusal(100)], [sample(90, 100n)], 500, 300);
    expect(out[0]!.priceAtRefusal?.price).toBe(100n);
    expect(out[0]!.priceAtHorizon).toBeNull();
  });

  it("has no price at refusal when the tape starts later", () => {
    const out = pairRefusalsWithPrices([refusal(10)], [sample(90, 100n)], 100, 10_000);
    expect(out[0]!.priceAtRefusal).toBeNull();
  });

  it("decides long and short losses, and refuses to compare unlike exponents", () => {
    const fell = pairRefusalsWithPrices([refusal(100)], [sample(90, 100n), sample(150, 95n)], 100, 10_000)[0]!;
    expect(wouldHaveLost(fell, true)).toBe(true);
    expect(wouldHaveLost(fell, false)).toBe(false);

    const flat = pairRefusalsWithPrices([refusal(100)], [sample(90, 100n)], 100, 10_000)[0]!;
    expect(wouldHaveLost(flat, true)).toBe(false);
    expect(wouldHaveLost(flat, false)).toBe(false);

    const mixed = pairRefusalsWithPrices([refusal(100)], [sample(90, 100n, -8), sample(150, 95n, -6)], 100, 10_000)[0]!;
    expect(wouldHaveLost(mixed, true)).toBeNull();
  });

  it("tallies decided and undecided outcomes", () => {
    const samples = [sample(90, 100n), sample(150, 95n)];
    const inputs = pairRefusalsWithPrices([refusal(100), refusal(140), refusal(5)], samples, 100, 200);
    // refusal(100): 100 -> 95; refusal(140): 100 -> horizon 240 has passed at asOf 200? No, 240 > 200 so undecided.
    const tally = tallyOutcomes(inputs, () => true);
    expect(tally).toEqual({ wouldHaveLost: 1, wouldHaveWon: 0, undecided: 2 });
  });

  it("getRefusalOutcomeInputs fetches refusals then the series tape and pairs them", async () => {
    const refusalRow = {
      id: "143_100_0",
      chainId: 143,
      gate: "0x0000000000000000000000000000000000000002",
      strategy_id: "143_0",
      specHash: SPEC,
      proposer: OWNER,
      account: OWNER,
      actor: null,
      vault: null,
      predicate: "bos_long",
      predicateRaw: "0x",
      decidingValue: "1",
      timestamp: 100,
      blockNumber: 1,
      logIndex: 0,
      txHash: "0x1",
    };
    const s = (t: number, p: string) => ({ id: `s${t}`, series: SERIES, bucketIndex: "0", price: p, expo: -8, publishTime: t, txHash: "0x" });
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      const { operationName } = JSON.parse(init.body) as { operationName: string };
      const data =
        operationName === "KanonRefusals"
          ? { Refusal: [refusalRow] }
          : operationName === "KanonPriceSampleBefore"
            ? { PriceSample: [s(90, "100")] }
            : { PriceSample: [s(150, "90")] };
      return { ok: true, status: 200, json: async () => ({ data }) };
    });
    const client = createIndexerClient({ url: "http://idx", fetch });
    const [out] = await client.getRefusalOutcomeInputs(OWNER, SERIES, { horizonSeconds: 100, asOf: 10_000 });
    expect(out!.priceAtRefusal?.price).toBe(100n);
    expect(out!.priceAtHorizon?.price).toBe(90n);
    expect(wouldHaveLost(out!, true)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("getRefusalOutcomeInputs makes no price queries when there are no refusals", async () => {
    const fetch = mockFetch({ Refusal: [] });
    const client = createIndexerClient({ url: "http://idx", fetch });
    expect(await client.getRefusalOutcomeInputs(OWNER, SERIES, { horizonSeconds: 60 })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
