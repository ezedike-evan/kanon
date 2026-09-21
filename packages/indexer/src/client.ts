/**
 * Typed GraphQL client for the Kanon Envio indexer.
 *
 * Deliberately independent of the `envio` runtime package: importing this file
 * pulls in only `zod`, so web, mobile and backend code can call it. Responses
 * are validated at the boundary; a schema mismatch throws rather than returning
 * partial data.
 *
 * Numbers: prices, sizes and PnL are BigInt integers exactly as emitted on-chain
 * (never floats). Hasura returns `numeric` columns as JSON numbers unless the
 * deployment stringifies them. This client accepts both, and throws if a JSON
 * number is beyond Number.MAX_SAFE_INTEGER (precision already lost) instead of
 * silently rounding. See README.md, "BigInt precision".
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Boundary schemas
// ---------------------------------------------------------------------------

/** Accepts a decimal string or a safe-integer JSON number. Returns bigint. */
const bigintField = z.union([z.string(), z.number()]).transform((v, ctx) => {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      ctx.addIssue({
        code: "custom",
        message: `numeric value ${v} exceeds the safe integer range; configure the indexer to stringify numerics`,
      });
      return z.NEVER;
    }
    return BigInt(v);
  }
  if (!/^-?\d+$/.test(v)) {
    ctx.addIssue({ code: "custom", message: `not an integer string: ${v}` });
    return z.NEVER;
  }
  return BigInt(v);
});

const nullable = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? null);

export const TRADE_LOG_KINDS = [
  "PROPOSED",
  "REFUSED",
  "OPENED",
  "CLOSED",
  "LIQUIDATED",
  "DELEVERAGED",
  "MIRRORED",
  "MIRROR_CLOSED",
  "SKIPPED",
] as const;
export type TradeLogKind = (typeof TRADE_LOG_KINDS)[number];

const tradeLogSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  kind: z.enum(TRADE_LOG_KINDS),
  account: z.string(),
  actor: nullable(z.string()),
  contractAddress: z.string(),
  contractName: z.string(),
  vault: nullable(z.string()),
  strategy_id: nullable(z.string()),
  /** Spec hash the trade or refusal was checked against. Evidence anchor. */
  specHash: nullable(z.string()),
  assetId: nullable(z.string()),
  series: nullable(z.string()),
  isLong: nullable(z.boolean()),
  size: nullable(bigintField),
  price: nullable(bigintField),
  pnl: nullable(bigintField),
  reason: nullable(z.string()),
  decidingValue: nullable(bigintField),
  position_id: nullable(z.string()),
  refusal_id: nullable(z.string()),
  timestamp: z.number(),
  blockNumber: z.number(),
  logIndex: z.number(),
  /** Transaction that carries the evidence. */
  txHash: z.string(),
});
export type TradeLogEntry = z.infer<typeof tradeLogSchema>;

const refusalSchema = z.object({
  id: z.string(),
  chainId: z.number(),
  gate: z.string(),
  strategy_id: z.string(),
  specHash: z.string(),
  proposer: z.string(),
  account: z.string(),
  actor: nullable(z.string()),
  vault: nullable(z.string()),
  predicate: z.string(),
  predicateRaw: z.string(),
  /** Predicate-specific failing number. Not a price. */
  decidingValue: bigintField,
  timestamp: z.number(),
  blockNumber: z.number(),
  logIndex: z.number(),
  txHash: z.string(),
});
export type RefusalEntry = z.infer<typeof refusalSchema>;

const strategySchema = z.object({
  id: z.string(),
  chainId: z.number(),
  registry: z.string(),
  strategyId: z.string(),
  owner: z.string(),
  activeSpecHash: z.string(),
  /** Commitment to the strategy's predicate list. */
  predicatesCommitment: z.string(),
  /** CanonicalSeries the strategy is pinned to. */
  series: z.string(),
  bond: bigintField,
  pinnedAt: z.number(),
  pendingSpecHash: nullable(z.string()),
  pendingPredicatesCommitment: nullable(z.string()),
  pendingSeries: nullable(z.string()),
  cooldownEndsAt: nullable(z.number()),
  tightenCount: z.number(),
  looseningCount: z.number(),
  proposalCount: z.number(),
  refusalCount: z.number(),
  lastActivityAt: z.number(),
});
export type StrategyEntry = z.infer<typeof strategySchema>;

const strategyEventSchema = z.object({
  id: z.string(),
  strategy_id: z.string(),
  chainId: z.number(),
  kind: z.enum(["PINNED", "TIGHTENED", "LOOSENING_PROPOSED", "LOOSENING_FINALIZED"]),
  oldSpecHash: nullable(z.string()),
  newSpecHash: z.string(),
  /** Predicate-list commitment after this event (proposed value for LOOSENING_PROPOSED). */
  predicatesCommitment: z.string(),
  /** Series after this event (proposed value for LOOSENING_PROPOSED). */
  series: z.string(),
  oldPredicatesCommitment: nullable(z.string()),
  oldSeries: nullable(z.string()),
  cooldownEndsAt: nullable(z.number()),
  bond: nullable(bigintField),
  actor: nullable(z.string()),
  timestamp: z.number(),
  blockNumber: z.number(),
  logIndex: z.number(),
  txHash: z.string(),
});
export type StrategyEventEntry = z.infer<typeof strategyEventSchema>;

const priceSampleSchema = z.object({
  id: z.string(),
  series: z.string(),
  bucketIndex: z.string(),
  /** Integer price; real value is price * 10^expo. */
  price: bigintField,
  expo: z.number(),
  publishTime: z.number(),
  txHash: z.string(),
});
export type PriceSampleEntry = z.infer<typeof priceSampleSchema>;

const accountSchema = z.object({
  id: z.string(),
  address: z.string(),
  proposalCount: z.number(),
  refusalCount: z.number(),
  openedCount: z.number(),
  closedCount: z.number(),
  liquidationCount: z.number(),
  /** Strategy the account's MarginAccount is bound to, if any. */
  boundStrategy_id: nullable(z.string()),
  firstSeenAt: z.number(),
  lastActivityAt: z.number(),
});
export type AccountEntry = z.infer<typeof accountSchema>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; statusText?: string; json: () => Promise<unknown> }>;

export interface IndexerClientOptions {
  /** GraphQL endpoint, for example the Envio hosted service URL or http://localhost:8080/v1/graphql. */
  readonly url: string;
  /** Injectable for tests and for runtimes without a global fetch. Defaults to global fetch. */
  readonly fetch?: FetchLike;
  /** Extra headers, for example `{ "x-hasura-admin-secret": "..." }` against a local dev instance. */
  readonly headers?: Record<string, string>;
  /** Chain filter applied to every query. Default 143 (Monad mainnet). */
  readonly chainId?: number;
}

export class IndexerError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "IndexerError";
  }
}

export interface Page {
  /** Rows to return. Default 50, capped at 1000. */
  readonly limit?: number;
  readonly offset?: number;
}

export interface TradeHistoryOptions extends Page {
  readonly kinds?: readonly TradeLogKind[];
  /** Only rows at or after this unix timestamp (seconds). */
  readonly since?: number;
  /** Only rows strictly before this unix timestamp (seconds). */
  readonly until?: number;
  /** Oldest first instead of newest first. */
  readonly ascending?: boolean;
}

export interface RefusalsOptions extends Page {
  readonly strategyId?: string | number | bigint;
  readonly since?: number;
  readonly until?: number;
  readonly ascending?: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

const clampLimit = (n: number | undefined): number => Math.min(Math.max(Math.trunc(n ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
const clampOffset = (n: number | undefined): number => Math.max(Math.trunc(n ?? 0), 0);

/** Addresses are indexed lowercase (address_format: lowercase). */
const normalizeAddress = (address: string): string => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new IndexerError(`not an address: ${address}`);
  return address.toLowerCase();
};

const strategyKey = (chainId: number, strategyId: string | number | bigint): string => {
  const s = strategyId.toString();
  if (!/^\d+$/.test(s)) throw new IndexerError(`not a strategy id: ${s}`);
  return `${chainId}_${s}`;
};

const TRADE_LOG_FIELDS = `
  id chainId kind account actor contractAddress contractName vault strategy_id specHash
  assetId series isLong size price pnl reason decidingValue position_id refusal_id
  timestamp blockNumber logIndex txHash
`;
const REFUSAL_FIELDS = `
  id chainId gate strategy_id specHash proposer account actor vault predicate predicateRaw
  decidingValue timestamp blockNumber logIndex txHash
`;
const STRATEGY_FIELDS = `
  id chainId registry strategyId owner activeSpecHash predicatesCommitment series bond pinnedAt
  pendingSpecHash pendingPredicatesCommitment pendingSeries cooldownEndsAt
  tightenCount looseningCount proposalCount refusalCount lastActivityAt
`;
const STRATEGY_EVENT_FIELDS = `
  id strategy_id chainId kind oldSpecHash newSpecHash predicatesCommitment series
  oldPredicatesCommitment oldSeries cooldownEndsAt bond actor
  timestamp blockNumber logIndex txHash
`;
const PRICE_SAMPLE_FIELDS = `id series bucketIndex price expo publishTime txHash`;

export interface RefusalOutcomeInput {
  readonly refusal: RefusalEntry;
  /** Latest series sample at or before the refusal. Null if none was indexed that early. */
  readonly priceAtRefusal: PriceSampleEntry | null;
  /**
   * Latest series sample at or before `refusal.timestamp + horizonSeconds`. Can
   * be the same sample as `priceAtRefusal` when the tape recorded no change
   * inside the horizon (an event-driven feed only publishes on deviation).
   * Null while the horizon has not yet elapsed (`asOf` < timestamp + horizon).
   */
  readonly priceAtHorizon: PriceSampleEntry | null;
}

export interface IndexerClient {
  /**
   * Every trade, refusal and position event for an address, newest first, each
   * row carrying its evidence (specHash, txHash, blockNumber, logIndex). The
   * address may be a trader, a vault owner, an executor key or a vault.
   */
  getTradeHistory(address: string, options?: TradeHistoryOptions): Promise<TradeLogEntry[]>;
  /** Refusals for an address, with predicate, failing value and evidence. */
  getRefusals(address: string, options?: RefusalsOptions): Promise<RefusalEntry[]>;
  /** The strategy row plus its full pin/tighten/loosen timeline, oldest first. Null strategy if unknown. */
  getStrategyTimeline(
    strategyId: string | number | bigint,
  ): Promise<{ strategy: StrategyEntry | null; events: StrategyEventEntry[] }>;
  /** Counters for an address (proposals, refusals, opens, closes, liquidations). Null if never seen. */
  getAccount(address: string): Promise<AccountEntry | null>;
  /** Price samples of one CanonicalSeries contract, oldest first. */
  getPriceSamples(
    seriesAddress: string,
    options?: Page & { readonly from?: number; readonly to?: number },
  ): Promise<PriceSampleEntry[]>;
  /**
   * Inputs for "how many refusals would have lost": each refusal with the series
   * price at refusal time and the price at `horizonSeconds` later. The caller
   * supplies the series the strategy trades and decides direction; see
   * {@link wouldHaveLost}.
   */
  getRefusalOutcomeInputs(
    address: string,
    seriesAddress: string,
    options: {
      readonly horizonSeconds: number;
      readonly limit?: number;
      readonly strategyId?: string | number | bigint;
      /** Unix seconds treated as "now". Defaults to the wall clock. */
      readonly asOf?: number;
    },
  ): Promise<RefusalOutcomeInput[]>;
}

export function createIndexerClient(options: IndexerClientOptions): IndexerClient {
  const chainId = options.chainId ?? 143;
  const doFetch: FetchLike | undefined =
    options.fetch ?? (typeof fetch === "function" ? (fetch as unknown as FetchLike) : undefined);

  async function query<T extends z.ZodType>(
    operation: string,
    document: string,
    variables: Record<string, unknown>,
    schema: T,
  ): Promise<z.infer<T>> {
    if (!doFetch) throw new IndexerError("no fetch implementation available; pass options.fetch");
    const res = await doFetch(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify({ operationName: operation, query: document, variables }),
    });
    if (!res.ok) throw new IndexerError(`indexer HTTP ${res.status} ${res.statusText ?? ""}`.trim());
    const body = (await res.json()) as { data?: unknown; errors?: ReadonlyArray<{ message?: string }> };
    if (body.errors && body.errors.length > 0) {
      throw new IndexerError(`indexer query ${operation} failed: ${body.errors.map((e) => e.message).join("; ")}`, body.errors);
    }
    const parsed = schema.safeParse(body.data);
    if (!parsed.success) {
      throw new IndexerError(`indexer response for ${operation} did not match the expected shape`, parsed.error.issues);
    }
    return parsed.data;
  }

  const order = (ascending?: boolean) => [{ timestamp: ascending ? "asc" : "desc" }, { logIndex: ascending ? "asc" : "desc" }];

  const timeFilter = (since?: number, until?: number) => {
    const t: Record<string, number> = {};
    if (since !== undefined) t._gte = since;
    if (until !== undefined) t._lt = until;
    return Object.keys(t).length > 0 ? [{ timestamp: t }] : [];
  };

  const getRefusals: IndexerClient["getRefusals"] = async (address, opts = {}) => {
    const a = normalizeAddress(address);
    const and: unknown[] = [
      { chainId: { _eq: chainId } },
      { _or: [{ account: { _eq: a } }, { actor: { _eq: a } }, { vault: { _eq: a } }, { proposer: { _eq: a } }] },
      ...timeFilter(opts.since, opts.until),
    ];
    if (opts.strategyId !== undefined) and.push({ strategy_id: { _eq: strategyKey(chainId, opts.strategyId) } });
    const data = await query(
      "KanonRefusals",
      `query KanonRefusals($where: Refusal_bool_exp!, $order: [Refusal_order_by!], $limit: Int!, $offset: Int!) {
        Refusal(where: $where, order_by: $order, limit: $limit, offset: $offset) { ${REFUSAL_FIELDS} }
      }`,
      { where: { _and: and }, order: order(opts.ascending), limit: clampLimit(opts.limit), offset: clampOffset(opts.offset) },
      z.object({ Refusal: z.array(refusalSchema) }),
    );
    return data.Refusal;
  };

  const getPriceSamples: IndexerClient["getPriceSamples"] = async (seriesAddress, opts = {}) => {
    const s = normalizeAddress(seriesAddress);
    const publishTime: Record<string, number> = {};
    if (opts.from !== undefined) publishTime._gte = opts.from;
    if (opts.to !== undefined) publishTime._lte = opts.to;
    const data = await query(
      "KanonPriceSamples",
      `query KanonPriceSamples($where: PriceSample_bool_exp!, $limit: Int!, $offset: Int!) {
        PriceSample(where: $where, order_by: [{ publishTime: asc }, { logIndex: asc }], limit: $limit, offset: $offset) { ${PRICE_SAMPLE_FIELDS} }
      }`,
      {
        where: {
          _and: [
            { chainId: { _eq: chainId } },
            { series: { _eq: s } },
            ...(Object.keys(publishTime).length > 0 ? [{ publishTime }] : []),
          ],
        },
        limit: clampLimit(opts.limit),
        offset: clampOffset(opts.offset),
      },
      z.object({ PriceSample: z.array(priceSampleSchema) }),
    );
    return data.PriceSample;
  };

  return {
    async getTradeHistory(address, opts = {}) {
      const a = normalizeAddress(address);
      const and: unknown[] = [
        { chainId: { _eq: chainId } },
        { _or: [{ account: { _eq: a } }, { actor: { _eq: a } }, { vault: { _eq: a } }, { contractAddress: { _eq: a } }] },
        ...timeFilter(opts.since, opts.until),
      ];
      if (opts.kinds && opts.kinds.length > 0) and.push({ kind: { _in: opts.kinds } });
      const data = await query(
        "KanonTradeHistory",
        `query KanonTradeHistory($where: TradeLog_bool_exp!, $order: [TradeLog_order_by!], $limit: Int!, $offset: Int!) {
          TradeLog(where: $where, order_by: $order, limit: $limit, offset: $offset) { ${TRADE_LOG_FIELDS} }
        }`,
        { where: { _and: and }, order: order(opts.ascending), limit: clampLimit(opts.limit), offset: clampOffset(opts.offset) },
        z.object({ TradeLog: z.array(tradeLogSchema) }),
      );
      return data.TradeLog;
    },

    getRefusals,

    async getStrategyTimeline(strategyId) {
      const key = strategyKey(chainId, strategyId);
      const data = await query(
        "KanonStrategyTimeline",
        `query KanonStrategyTimeline($id: String!) {
          Strategy_by_pk(id: $id) { ${STRATEGY_FIELDS} }
          StrategyEvent(where: { strategy_id: { _eq: $id } }, order_by: [{ timestamp: asc }, { logIndex: asc }], limit: ${MAX_LIMIT}) { ${STRATEGY_EVENT_FIELDS} }
        }`,
        { id: key },
        z.object({
          Strategy_by_pk: strategySchema.nullish().transform((v) => v ?? null),
          StrategyEvent: z.array(strategyEventSchema),
        }),
      );
      return { strategy: data.Strategy_by_pk, events: data.StrategyEvent };
    },

    async getAccount(address) {
      const id = `${chainId}_${normalizeAddress(address)}`;
      const data = await query(
        "KanonAccount",
        `query KanonAccount($id: String!) {
          Account_by_pk(id: $id) { id address proposalCount refusalCount openedCount closedCount liquidationCount boundStrategy_id firstSeenAt lastActivityAt }
        }`,
        { id },
        z.object({ Account_by_pk: accountSchema.nullish().transform((v) => v ?? null) }),
      );
      return data.Account_by_pk;
    },

    getPriceSamples,

    async getRefusalOutcomeInputs(address, seriesAddress, opts) {
      const refusals = await getRefusals(address, {
        limit: opts.limit ?? MAX_LIMIT,
        ascending: true,
        ...(opts.strategyId !== undefined ? { strategyId: opts.strategyId } : {}),
      });
      if (refusals.length === 0) return [];

      const first = refusals[0]!.timestamp;
      const last = refusals[refusals.length - 1]!.timestamp + opts.horizonSeconds;

      // One sample at or before the first refusal (the price "in force" then),
      // then everything up to the last horizon. Sparse, event-driven series
      // mean the newest earlier sample can be arbitrarily old; that is the
      // honest price at that moment, not an invented one.
      const [seed, later] = await Promise.all([
        query(
          "KanonPriceSampleBefore",
          `query KanonPriceSampleBefore($where: PriceSample_bool_exp!) {
            PriceSample(where: $where, order_by: [{ publishTime: desc }, { logIndex: desc }], limit: 1) { ${PRICE_SAMPLE_FIELDS} }
          }`,
          {
            where: {
              _and: [
                { chainId: { _eq: chainId } },
                { series: { _eq: normalizeAddress(seriesAddress) } },
                { publishTime: { _lte: first } },
              ],
            },
          },
          z.object({ PriceSample: z.array(priceSampleSchema) }),
        ),
        getPriceSamples(seriesAddress, { from: first + 1, to: last, limit: MAX_LIMIT }),
      ]);

      return pairRefusalsWithPrices(
        refusals,
        [...seed.PriceSample, ...later],
        opts.horizonSeconds,
        opts.asOf ?? Math.floor(Date.now() / 1000),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O, unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Pairs each refusal with the series price in force at the refusal and the price
 * in force at `refusal.timestamp + horizonSeconds`. `samples` must all belong to
 * one series. Samples are matched by `publishTime`. The horizon price is only
 * reported once `asOf` (unix seconds) has passed the horizon.
 */
export function pairRefusalsWithPrices(
  refusals: readonly RefusalEntry[],
  samples: readonly PriceSampleEntry[],
  horizonSeconds: number,
  asOf: number,
): RefusalOutcomeInput[] {
  const sorted = [...samples].sort((a, b) => a.publishTime - b.publishTime);

  const latestAtOrBefore = (t: number): PriceSampleEntry | null => {
    let found: PriceSampleEntry | null = null;
    for (const s of sorted) {
      if (s.publishTime <= t) found = s;
      else break;
    }
    return found;
  };

  return refusals.map((refusal) => {
    const horizonEnd = refusal.timestamp + horizonSeconds;
    return {
      refusal,
      priceAtRefusal: latestAtOrBefore(refusal.timestamp),
      priceAtHorizon: asOf >= horizonEnd ? latestAtOrBefore(horizonEnd) : null,
    };
  });
}

/**
 * Simple mark-to-mark check: would the refused trade have lost money by the
 * horizon? A long loses if the price fell, a short if it rose. Null when either
 * price is missing or the exponents differ (never compares unlike scales). Does
 * not model fees, stops, funding or slippage; it is an input to a story about
 * discipline, not a P&L.
 */
export function wouldHaveLost(input: RefusalOutcomeInput, isLong: boolean): boolean | null {
  const { priceAtRefusal: a, priceAtHorizon: b } = input;
  if (!a || !b || a.expo !== b.expo) return null;
  return isLong ? b.price < a.price : b.price > a.price;
}

/** Counts of decided outcomes across a set, with undecided ones reported separately. */
export function tallyOutcomes(
  inputs: readonly RefusalOutcomeInput[],
  directionOf: (refusal: RefusalEntry) => boolean,
): { wouldHaveLost: number; wouldHaveWon: number; undecided: number } {
  let lost = 0;
  let won = 0;
  let undecided = 0;
  for (const input of inputs) {
    const r = wouldHaveLost(input, directionOf(input.refusal));
    if (r === null) undecided += 1;
    else if (r) lost += 1;
    else won += 1;
  }
  return { wouldHaveLost: lost, wouldHaveWon: won, undecided };
}
