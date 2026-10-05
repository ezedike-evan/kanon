import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import type { AssetClass } from "@kanon/spec";

/** Matches packages/spec/src/decimal.ts's Decimal exactly — fixed-point, never a float. */
export const decimal = v.object({
  atoms: v.string(),
  decimals: v.number(),
});

/**
 * Asset classes the ledger accepts. Mirrors `ASSET_CLASSES` in
 * packages/spec/src/assets.ts, which is where enabling a new class starts.
 * Add its literal here too; the check below fails to compile until the two
 * agree, in either direction.
 */
export const assetClass = v.union(v.literal("crypto"));
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _assetClassMatchesSpec: Exact<Infer<typeof assetClass>, AssetClass> = true;
void _assetClassMatchesSpec;

/**
 * Every number that shaped a market, stored on it so the card can show it and
 * `termsHash` can commit to it. Nothing that decides a market's terms is a
 * default the reader cannot see.
 */
export const marketParams = v.object({
  template: v.string(),
  offsetBps: v.number(),
  significantDigits: v.number(),
  windowSeconds: v.number(),
  bucketSeconds: v.number(),
  referencePrice: decimal,
  referenceAt: v.number(),
  maxReferenceAgeSeconds: v.number(),
  feedId: v.string(),
});

export default defineSchema({
  users: defineTable({
    privyId: v.string(),
    email: v.optional(v.string()),
    name: v.string(),
    username: v.string(),
    experience: v.string(),
    /** Lower-cased `username`, for a case-insensitive uniqueness check. */
    usernameLower: v.optional(v.string()),
    /**
     * The wallet this user proved control of by signing `walletLinkMessage`.
     * Chain-mirroring rows are accepted only for this address. Lower-cased.
     */
    walletAddress: v.optional(v.string()),
  })
    .index("by_privyId", ["privyId"])
    .index("by_usernameLower", ["usernameLower"])
    .index("by_walletAddress", ["walletAddress"]),

  strategies: defineTable({
    ownerUserId: v.id("users"),
    /**
     * The spec being enforced. Absent while the strategy is a draft: a draft
     * is a compiled candidate, held in `pendingSpec`, that nothing enforces
     * until the user signs off and it is pinned.
     */
    spec: v.optional(v.any()),
    /** Hash of `spec`; of `pendingSpec` while the strategy is still a draft. */
    specHash: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("pinned"),
      v.literal("cooling_off"),
    ),
    pinnedAt: v.optional(v.number()),
    bondAtoms: v.optional(decimal),
    autopilot: v.boolean(),
    pendingSpec: v.optional(v.any()),
    cooldownEndsAt: v.optional(v.number()),
    /** StrategyRegistry anchor. A strategy is `pinned` only once this exists. */
    chainId: v.optional(v.number()),
    registryAddress: v.optional(v.string()),
    chainStrategyId: v.optional(v.string()),
    pinTxHash: v.optional(v.string()),
    /**
     * What the registry holds next to `specHash`: the commitment to the
     * predicates the gate checks (`keccak256(encodePredicates(spec))`) and the
     * CanonicalSeries address it reads. Both describe `spec`, the enforced one.
     */
    predicatesCommitment: v.optional(v.string()),
    seriesAddress: v.optional(v.string()),
    /** The same two for a loosening waiting out its hold, in step with `pendingSpec`. */
    pendingPredicatesCommitment: v.optional(v.string()),
    pendingSeriesAddress: v.optional(v.string()),
    /** Hash of the last amendment sent on-chain (tighten, or a proposed loosening). */
    amendTxHash: v.optional(v.string()),
  })
    .index("by_owner", ["ownerUserId"])
    .index("by_status", ["status"])
    .index("by_specHash", ["specHash"]),

  trades: defineTable({
    strategyId: v.id("strategies"),
    direction: v.union(v.literal("long"), v.literal("short")),
    asset: v.string(),
    entry: decimal,
    size: decimal,
    stop: decimal,
    status: v.union(
      v.literal("proposed"),
      v.literal("executed"),
      v.literal("refused"),
      v.literal("undone"),
    ),
    satisfiedPredicateIds: v.array(v.string()),
    failedPredicateId: v.optional(v.string()),
    failingValue: v.optional(decimal),
    evidenceRefs: v.array(v.string()),
    createdAt: v.number(),
    /** The number the failing value had to clear, in the unit it was decided in. */
    requiredValue: v.optional(decimal),
    failedSymbol: v.optional(v.string()),
    /** Every predicate's outcome, satisfied ones included: the evidence chain. */
    results: v.optional(
      v.array(
        v.object({
          predicateId: v.string(),
          kind: v.string(),
          symbol: v.string(),
          satisfied: v.boolean(),
          decidingValue: decimal,
          referenceValue: decimal,
          at: v.number(),
        }),
      ),
    ),
    /** The spec hash the trade was judged against. */
    specHash: v.optional(v.string()),
    /** Window the evaluation scanned, unix seconds, and the price time the entry came from. */
    scan: v.optional(
      v.object({ from: v.number(), to: v.number(), asOf: v.number() }),
    ),
    /** Account equity the size was risked against, and whether it is a real account or paper. */
    equity: v.optional(decimal),
    equitySource: v.optional(v.union(v.literal("account"), v.literal("paper"))),
    riskBps: v.optional(v.number()),
    /** Milliseconds. A proposed trade executes on its own at this time unless undone. */
    undoExpiresAt: v.optional(v.number()),
    executedAt: v.optional(v.number()),
    /**
     * How an executed trade was filled. Every fill is `paper` until a venue fill is confirmed;
     * nothing may present a paper fill as a real one.
     */
    executionMode: v.optional(v.union(v.literal("paper"), v.literal("live"))),
    feed: v.optional(v.string()),
  })
    .index("by_strategy", ["strategyId"])
    .index("by_status", ["status"])
    .index("by_strategy_and_status", ["strategyId", "status"]),

  predictions: defineTable({
    userId: v.id("users"),
    asset: v.string(),
    direction: v.union(v.literal("above"), v.literal("below")),
    thresholdPrice: decimal,
    windowStart: v.number(),
    windowEnd: v.number(),
    side: v.union(v.literal("above"), v.literal("below")),
    status: v.union(v.literal("open"), v.literal("settled")),
    result: v.optional(
      v.union(v.literal("won"), v.literal("lost"), v.literal("refunded")),
    ),
    decidingPrice: v.optional(decimal),
    decidingAt: v.optional(v.number()),
    /** The `markets` row this stake was taken on. Absent on rows from before markets existed. */
    marketId: v.optional(v.id("markets")),
    /** What was staked, in the chain's native unit at 18 decimals. */
    stake: v.optional(decimal),
    /** The `takeSide` transaction. A position is only recorded once the chain accepted it. */
    txHash: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_status", ["status"])
    .index("by_asset", ["asset"])
    .index("by_market", ["marketId"])
    .index("by_market_and_status", ["marketId", "status"]),

  accounts: defineTable({
    userId: v.id("users"),
    collateral: decimal,
    exposureByAssetClass: v.array(
      v.object({
        assetClass: assetClass,
        notional: decimal,
      }),
    ),
  }).index("by_user", ["userId"]),

  positions: defineTable({
    accountId: v.id("accounts"),
    asset: v.string(),
    assetClass: assetClass,
    side: v.union(v.literal("long"), v.literal("short")),
    size: decimal,
    entryPrice: decimal,
    liquidationPrice: v.union(decimal, v.null()),
    openedAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_account_and_asset", ["accountId", "asset"]),

  vaults: defineTable({
    strategyId: v.id("strategies"),
    ownerUserId: v.id("users"),
    depositBalance: decimal,
    whitelistedAssets: v.array(v.string()),
    maxDailyDrawdownBps: v.number(),
    createdAt: v.number(),
    /**
     * The on-chain mirror. The chain is the truth; these fields are how the app
     * finds a vault again. A row without `address` is a record of intent that
     * was never signed, and is never shown as a vault.
     */
    address: v.optional(v.string()),
    chainId: v.optional(v.number()),
    factoryAddress: v.optional(v.string()),
    /** The address allowed to propose trades for the owner. Cannot withdraw. */
    executor: v.optional(v.string()),
    seriesAddress: v.optional(v.string()),
    createTxHash: v.optional(v.string()),
    /**
     * A looser set of limits waiting out its hold. The contract's limits are
     * immutable, so a loosening is a new vault; this is the hold before the app
     * lets that vault be created.
     */
    pendingLoosening: v.optional(
      v.object({
        whitelistedAssets: v.array(v.string()),
        maxDailyDrawdownBps: v.number(),
        requestedAt: v.number(),
        endsAt: v.number(),
      }),
    ),
  })
    .index("by_owner", ["ownerUserId"])
    .index("by_strategy", ["strategyId"])
    .index("by_address", ["address"]),

  /** A vault's balance history: what the drawdown guard is evaluated over. */
  vaultEquity: defineTable({
    vaultId: v.id("vaults"),
    /** Unix seconds. */
    at: v.number(),
    /** Balance before `realizedPnl` applies, in collateral atoms. */
    equityAtoms: v.string(),
    realizedPnlAtoms: v.string(),
    txHash: v.optional(v.string()),
  }).index("by_vault_and_time", ["vaultId", "at"]),

  copyRelationships: defineTable({
    followerUserId: v.id("users"),
    leaderStrategyId: v.id("strategies"),
    allocationBps: v.number(),
    feeShareBps: v.number(),
    active: v.boolean(),
    createdAt: v.number(),
    /** The on-chain `CopyVault`. Absent means the follow was never signed. */
    address: v.optional(v.string()),
    chainId: v.optional(v.number()),
    createTxHash: v.optional(v.string()),
    leaderExecutor: v.optional(v.string()),
    feeRecipient: v.optional(v.string()),
    /** Set when the follower unfollowed. Immediate, with no hold. */
    unfollowedAt: v.optional(v.number()),
  })
    .index("by_follower", ["followerUserId"])
    .index("by_leaderStrategy", ["leaderStrategyId"])
    .index("by_follower_and_leaderStrategy", ["followerUserId", "leaderStrategyId"])
    .index("by_address", ["address"]),

  /**
   * A strategy its owner has listed for copying. Nothing is listed by default:
   * a strategy is private until its owner lists it, and `profitShareBps` is
   * the only fee a follower can be charged.
   */
  copyLeads: defineTable({
    strategyId: v.id("strategies"),
    ownerUserId: v.id("users"),
    profitShareBps: v.number(),
    /** The address that submits the leader's trades to `CopyVault.mirrorOpen`. */
    leaderExecutor: v.string(),
    /** Where the fee is paid. Defaults to the strategy owner's wallet. */
    feeRecipient: v.string(),
    listedAt: v.number(),
    active: v.boolean(),
  })
    .index("by_strategy", ["strategyId"])
    .index("by_active", ["active"]),

  /**
   * The off-chain canonical series: one row per distinct Pyth publish time per
   * asset, written by the `ticks:ingest` cron. `by_asset_and_time` is what
   * makes both the dedupe check and the candle read a bounded index range.
   */
  ticks: defineTable({
    asset: v.string(),
    price: decimal,
    publishTime: v.number(),
    feedId: v.string(),
  }).index("by_asset_and_time", ["asset", "publishTime"]),

  /**
   * Pre-aggregated candles, one row per (asset, width, bucket start), maintained
   * by `ticks:recordTicks` so a chart reads at most `limit` rows instead of
   * thousands of ticks. Only buckets that saw a tick exist; gaps are filled at
   * read time, as `bucketTicks` does. `openTime`/`closeTime` are the publish
   * times of the first and last tick folded in, which makes folding idempotent
   * and order-independent (a backfill can overlap live writes).
   */
  candles: defineTable({
    asset: v.string(),
    bucketSeconds: v.number(),
    start: v.number(),
    open: decimal,
    high: decimal,
    low: decimal,
    close: decimal,
    openTime: v.number(),
    closeTime: v.number(),
  }).index("by_asset_width_start", ["asset", "bucketSeconds", "start"]),

  /** Per-asset candle backfill state. `getSeries` trusts `candles` only once `ready`. */
  candleMeta: defineTable({
    asset: v.string(),
    state: v.union(v.literal("backfilling"), v.literal("ready")),
    /** Backfill resumes from the first tick with `publishTime > cursor`. */
    cursor: v.number(),
  }).index("by_asset", ["asset"]),

  /**
   * Predict-tab markets: does the recorded price touch `thresholdPrice` inside
   * a window. Opened and settled only by `markets:sweep` from the `ticks`
   * series; no client writes a market or its result. Every parameter that
   * shaped one is in `params`, and `termsHash` commits to them.
   *
   * Windows and timestamps are unix seconds. `createdAt` and `settledAt` are
   * milliseconds, as Convex clocks are.
   */
  markets: defineTable({
    asset: v.string(),
    assetClass,
    /** The question: does the price reach a level above (`above`) or below (`below`) the reference. */
    direction: v.union(v.literal("above"), v.literal("below")),
    thresholdPrice: decimal,
    windowStart: v.number(),
    windowEnd: v.number(),
    bucketSeconds: v.number(),
    template: v.string(),
    params: marketParams,
    /** sha-256 of the terms as created, so a stake can be tied to exactly what was shown. */
    termsHash: v.string(),
    createdAt: v.number(),
    status: v.union(
      v.literal("open"),
      v.literal("settled"),
      v.literal("unresolvable"),
    ),
    /** Set while the window runs once the recorded series has already touched the threshold. */
    crossed: v.optional(v.object({ price: decimal, at: v.number() })),
    outcome: v.optional(v.union(v.literal("hit"), v.literal("miss"))),
    /** `settleThreshold`'s deciding price and its candle's time. Present only on a hit. */
    decidingPrice: v.optional(decimal),
    decidingAt: v.optional(v.number()),
    /** The window's own extreme: how close a miss came. Evidence only, never a decision input. */
    windowExtreme: v.optional(v.object({ price: decimal, at: v.number() })),
    recordedCandles: v.optional(v.number()),
    /** sha-256 over the settlement's fields; see `evidencePreimage` in the spec package. */
    evidenceHash: v.optional(v.string()),
    settledAt: v.optional(v.number()),
    /**
     * Sweep bookkeeping: the newest tick time the market was last resolved
     * against, and whether `now` was past `windowEnd` then. While neither has
     * changed, resolution cannot change, so the sweep skips the market.
     */
    checkedTickAt: v.optional(v.number()),
    checkedEnded: v.optional(v.boolean()),
    /** The on-chain `ThresholdMarket` this row was linked to. Absent until someone opens it there. */
    chain: v.optional(
      v.object({
        chainId: v.number(),
        address: v.string(),
        marketId: v.string(),
        txHash: v.string(),
      }),
    ),
  })
    .index("by_status_and_windowEnd", ["status", "windowEnd"])
    .index("by_stream", ["asset", "template", "direction", "windowStart"]),

  /**
   * The last successful Nansen smart-money net-flow read per asset, so opening
   * the analytics screen does not buy the same 5 credits again. Written only by
   * `nansen:smartMoneyFlow`; `flow` is a validated `NansenFlow` with status "ok".
   */
  nansenFlowCache: defineTable({
    asset: v.string(),
    fetchedAt: v.number(),
    flow: v.any(),
  }).index("by_asset", ["asset"]),

  /**
   * Fixed-window counters for spend-bearing calls (model and Nansen credits).
   * One row per user and key; see `rateLimit.ts`.
   */
  rateLimits: defineTable({
    subject: v.string(),
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_subject_and_key", ["subject", "key"]),
});
