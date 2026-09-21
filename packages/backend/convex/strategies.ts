import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  COOLING_OFF_SECONDS,
  cooldownElapsed,
  cooldownEndsAt,
  parseSpec,
  planAmendment,
  predicatesCommitment,
  specHash,
} from "@kanon/spec";
import { decimal } from "./schema";
import { requireOwnedStrategy, requireUser, viewOwnedStrategy, viewerUser } from "./authz";

/**
 * A strategy's life: draft -> pinned -> (cooling_off -> pinned)*.
 *
 * Every rule below is enforced here, on the server, from `@kanon/spec`'s own
 * pure functions. None of it trusts the client: the client cannot pick a
 * shorter cooling-off, cannot pin what it did not put on-chain, and cannot
 * pin a spec other than the one whose hash it signed. There is no override and
 * no admin path.
 *
 * Who is calling comes from the Privy token (`authz.ts`). No function here
 * takes a user id: a strategy is reachable only by its owner.
 */

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function requireTx(txHash: string) {
  if (!TX_HASH.test(txHash)) throw new Error("a transaction hash is required");
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The commitment the client sent must be the commitment of the spec being
 * saved, recomputed here from `@kanon/spec`. A spec whose predicates cannot be
 * encoded for the gate has no commitment and is refused, not stored.
 */
function requireOnchainTarget(spec: Parameters<typeof predicatesCommitment>[0], commitment: string, series: string) {
  if (!ADDRESS.test(series)) throw new Error("a series address is required");
  if (predicatesCommitment(spec).toLowerCase() !== commitment.toLowerCase()) {
    throw new Error("the predicates commitment does not match the spec");
  }
}

/**
 * Persists a compiled candidate as the strategy's `pendingSpec`. Creates the
 * draft on first save, updates it in place after. Nothing here enforces the
 * spec: only pinning does, and only after the user has reviewed it.
 */
export const saveDraft = mutation({
  args: {
    strategyId: v.optional(v.id("strategies")),
    spec: v.any(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const spec = parseSpec(args.spec);
    const hash = await specHash(spec);

    if (args.strategyId) {
      const { strategy: existing } = await requireOwnedStrategy(ctx, args.strategyId);
      if (existing.status !== "draft") {
        throw new Error("a pinned strategy changes through an amendment, not a draft save");
      }
      await ctx.db.patch(existing._id, { pendingSpec: spec, specHash: hash });
      return { strategyId: existing._id, specHash: hash };
    }

    const strategyId = await ctx.db.insert("strategies", {
      ownerUserId: user._id,
      pendingSpec: spec,
      specHash: hash,
      status: "draft",
      autopilot: false,
    });
    return { strategyId, specHash: hash };
  },
});

export const getStrategy = query({
  args: { strategyId: v.id("strategies") },
  handler: async (ctx, args) => {
    return (await viewOwnedStrategy(ctx, args.strategyId))?.strategy ?? null;
  },
});

/** The signed-in user's strategies. */
export const listStrategiesByOwner = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("strategies")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .collect();
  },
});

/**
 * Records a pin the chain already accepted. Requires the transaction, and
 * requires the hash that went on-chain to be the hash of the spec being
 * pinned: a draft edited after signing cannot be pinned under the old hash.
 */
export const pinStrategy = mutation({
  args: {
    strategyId: v.id("strategies"),
    /** The hash that was written on-chain. */
    specHash: v.string(),
    /** The commitment to the predicates, and the series the gate reads, as the registry recorded them. */
    predicatesCommitment: v.string(),
    series: v.string(),
    bondAtoms: decimal,
    txHash: v.string(),
    chainId: v.number(),
    registryAddress: v.string(),
    chainStrategyId: v.string(),
  },
  handler: async (ctx, args) => {
    requireTx(args.txHash);
    const { strategy } = await requireOwnedStrategy(ctx, args.strategyId);
    if (strategy.status !== "draft" || strategy.pendingSpec === undefined) {
      throw new Error("only a reviewed draft can be pinned");
    }
    const spec = parseSpec(strategy.pendingSpec);
    const hash = await specHash(spec);
    if (hash !== args.specHash) {
      throw new Error("the draft changed after it was signed; review and pin again");
    }
    requireOnchainTarget(spec, args.predicatesCommitment, args.series);

    await ctx.db.patch(strategy._id, {
      spec,
      pendingSpec: undefined,
      specHash: hash,
      status: "pinned",
      pinnedAt: Date.now(),
      bondAtoms: args.bondAtoms,
      chainId: args.chainId,
      registryAddress: args.registryAddress,
      chainStrategyId: args.chainStrategyId,
      pinTxHash: args.txHash,
      predicatesCommitment: args.predicatesCommitment,
      seriesAddress: args.series,
    });
    return { specHash: hash };
  },
});

/**
 * Changes a pinned rule. The plan comes from `planAmendment`, the same pure
 * function the review screen uses: a tightening applies at once, a loosening
 * is held for `COOLING_OFF_SECONDS` and the old spec stays enforced until then.
 * The hold can be longer than that (the registry's own cooldown is authoritative
 * on-chain) but the client can never make it shorter.
 */
export const amendStrategy = mutation({
  args: {
    strategyId: v.id("strategies"),
    nextSpec: v.any(),
    /** What that call carried next to the hash. */
    predicatesCommitment: v.string(),
    series: v.string(),
    /** The registry call that carried this change: `tighten` or `proposeLoosening`. */
    txHash: v.string(),
    /** Milliseconds. The registry's own cooldown end, when it was a loosening. */
    chainCooldownEndsAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireTx(args.txHash);
    const { strategy } = await requireOwnedStrategy(ctx, args.strategyId);
    if (strategy.status === "cooling_off") {
      throw new Error("a change is already cooling off; wait for it or withdraw it first");
    }
    if (strategy.status !== "pinned" || strategy.spec === undefined) {
      throw new Error("only a pinned strategy can be amended");
    }

    const current = parseSpec(strategy.spec);
    const next = parseSpec(args.nextSpec);
    requireOnchainTarget(next, args.predicatesCommitment, args.series);
    // A change that moves the pinned series address cannot be ordered, so it waits.
    const plan = planAmendment(current, next, {
      currentSeries: strategy.seriesAddress,
      nextSeries: args.series,
    });

    if (plan.kind === "none") return { kind: "none" as const };

    const hash = await specHash(next);
    if (plan.kind === "immediate") {
      await ctx.db.patch(strategy._id, {
        spec: next,
        specHash: hash,
        predicatesCommitment: args.predicatesCommitment,
        seriesAddress: args.series,
        amendTxHash: args.txHash,
      });
      return { kind: "immediate" as const, specHash: hash };
    }

    const held = cooldownEndsAt(Date.now(), plan.cooldownSeconds);
    const endsAt = Math.max(held, args.chainCooldownEndsAt ?? 0);
    await ctx.db.patch(strategy._id, {
      status: "cooling_off",
      pendingSpec: next,
      pendingPredicatesCommitment: args.predicatesCommitment,
      pendingSeriesAddress: args.series,
      cooldownEndsAt: endsAt,
      amendTxHash: args.txHash,
    });
    return { kind: "cooling_off" as const, cooldownEndsAt: endsAt };
  },
});

/** Applies a loosening whose hold has fully run. Refused a millisecond early. */
export const finalizeAmendment = mutation({
  args: {
    strategyId: v.id("strategies"),
    txHash: v.string(),
  },
  handler: async (ctx, args) => {
    requireTx(args.txHash);
    const { strategy } = await requireOwnedStrategy(ctx, args.strategyId);
    if (
      strategy.status !== "cooling_off" ||
      strategy.pendingSpec === undefined ||
      strategy.cooldownEndsAt === undefined
    ) {
      throw new Error("nothing is cooling off");
    }
    if (!cooldownElapsed(strategy.cooldownEndsAt, Date.now())) {
      throw new Error("the cooling-off period has not elapsed");
    }
    const next = parseSpec(strategy.pendingSpec);
    const hash = await specHash(next);
    // The registry adopts the pending hash, commitment and series together; so does the row.
    await ctx.db.patch(strategy._id, {
      spec: next,
      specHash: hash,
      predicatesCommitment: strategy.pendingPredicatesCommitment ?? strategy.predicatesCommitment,
      seriesAddress: strategy.pendingSeriesAddress ?? strategy.seriesAddress,
      pendingSpec: undefined,
      pendingPredicatesCommitment: undefined,
      pendingSeriesAddress: undefined,
      cooldownEndsAt: undefined,
      status: "pinned",
      amendTxHash: args.txHash,
    });
    return { specHash: hash };
  },
});

/**
 * Drops a pending loosening. The current spec never stopped being enforced, so
 * this only ever moves back toward the stricter rule; on-chain it is a
 * `tighten` to the current hash, which clears the pending change.
 */
export const withdrawAmendment = mutation({
  args: {
    strategyId: v.id("strategies"),
    txHash: v.string(),
  },
  handler: async (ctx, args) => {
    requireTx(args.txHash);
    const { strategy } = await requireOwnedStrategy(ctx, args.strategyId);
    if (strategy.status !== "cooling_off") throw new Error("nothing is cooling off");
    await ctx.db.patch(strategy._id, {
      status: "pinned",
      pendingSpec: undefined,
      pendingPredicatesCommitment: undefined,
      pendingSeriesAddress: undefined,
      cooldownEndsAt: undefined,
      amendTxHash: args.txHash,
    });
    return null;
  },
});

/** The hold, for clients that want to show it before a change is made. */
export const coolingOffSeconds = query({
  args: {},
  handler: async () => COOLING_OFF_SECONDS,
});
