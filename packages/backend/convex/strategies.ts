import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import { MAX_LIST_ROWS } from "./limits";
import { ConvexError, v } from "convex/values";
import {
  COOLING_OFF_SECONDS,
  cooldownElapsed,
  cooldownEndsAt,
  exitsSentence,
  missingExits,
  parseSpec,
  planAmendment,
  predicatesCommitment,
  specHash,
  type Decimal,
} from "@kanon/spec";
import { decimal } from "./schema";
import {
  ownedStrategyBySubject,
  requireOwnedStrategy,
  requireSubject,
  requireUser,
  viewOwnedStrategy,
  viewerUser,
} from "./authz";
import { withdrawWaiting } from "./autopilotData";
import {
  NATIVE_DECIMALS,
  verifyLooseningFinalizedReceipt,
  verifyLooseningProposedReceipt,
  verifyPinReceipt,
  verifyTightenReceipt,
  type RegistryClaim,
  type RpcReceipt,
} from "./chainLogic";
import { getReceiptSoon, rpcFor, rpcIsOnChain } from "./chainReads";
import { GATE_BUCKET_SECONDS, gateEligibility } from "./gateLogic";
import { recomputeKeeperFeeds } from "./keeperData";
import { describeEnvProblem, parseGateEnv, parseKeeperSwitch, parseRegistryEnv, type RegistryEnv } from "./serverEnv";
import { resolveWallet } from "./users";

/**
 * A strategy's life: draft -> pinned -> (cooling_off -> pinned)*.
 *
 * Every rule below is enforced here, on the server, from `@kanon/spec`'s own
 * pure functions. None of it trusts the client: the client cannot pick a
 * shorter cooling-off, cannot pin what it did not put on-chain, and cannot
 * pin a spec other than the one whose hash it signed. There is no override and
 * no admin path.
 *
 * "Cannot pin what it did not put on-chain" is checked, not assumed. A pin, a
 * change and an applied loosening are each an action that reads the
 * transaction's receipt from the chain and writes the row only when the
 * StrategyRegistry's own event says what the row is about to say
 * (`chainLogic.ts`). A transaction hash is a pointer to that evidence, never
 * the evidence. With the registry's address or its RPC not configured, nothing
 * is pinned: the check fails closed.
 *
 * Who is calling comes from the Privy token (`authz.ts`). No function here
 * takes a user id: a strategy is reachable only by its owner.
 *
 * Functions are referenced by name because `_generated/api.d.ts` is stale until
 * `npx convex dev` regenerates it (see convex/README.md).
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
    // No stop and target the user stated, no draft: nothing without them is pinned or tested. A client
    // that predates targets would otherwise save a spec with the field dropped.
    const missing = missingExits(spec);
    if (missing.length > 0) {
      throw new ConvexError({ code: "exits_not_stated", message: exitsSentence(missing) });
    }
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
      .take(MAX_LIST_ROWS);
  },
});

// ---------------------------------------------------------------------------
// What the chain is asked before a row is written
// ---------------------------------------------------------------------------

/** Why a pin, a change or an applied loosening was not recorded. `message` is a sentence fit to show as it is. */
export type ChainRecordFailure = {
  ok: false;
  reason:
    | "invalid"
    | "not_configured"
    | "rejected"
    | "not_confirmed"
    | "no_user"
    | "wallet_not_linked"
    | "bad_signature"
    | "already_linked"
    | "wallet_in_use";
  message: string;
};

// Neither says "try again": what a second try does is the caller's to know. A pin is recorded
// again from the same transaction; a change or an applied loosening would be sent a second time.
const UNAVAILABLE = "The registry cannot be read from here right now, so nothing was recorded.";
const NOT_CONFIRMED = "The chain has not confirmed that transaction yet, so nothing was recorded.";
/** True of a pin only: the client keeps the transaction and records it again without sending another. */
const PIN_RETRY = " Try again in a moment. The pin is not sent twice.";

const walletMessages: Record<string, string> = {
  no_user: "Finish creating your account before pinning a rule.",
  wallet_not_linked: "Sign the link message with your wallet, so the pin can be checked against it.",
  bad_signature: "That signature is not from a wallet. Sign the link message again.",
  already_linked: "Your account is linked to a different wallet than the one that signed.",
  wallet_in_use: "That wallet is already linked to another account.",
};

const fail = (reason: ChainRecordFailure["reason"], message: string): ChainRecordFailure => ({ ok: false, reason, message });

type RegistryRead = { ok: true; env: RegistryEnv; receipt: RpcReceipt | null } | ChainRecordFailure;

/**
 * The receipt of `txHash`, read from the chain the registry is deployed on.
 * Fails closed: with the registry not configured, the RPC on another chain, or
 * the RPC not answering, there is no receipt and so no row.
 */
async function readRegistryReceipt(scope: string, txHash: string): Promise<RegistryRead> {
  const env = parseRegistryEnv(process.env);
  if (!env.ok) {
    console.error(describeEnvProblem(scope, env.invalid));
    return fail("not_configured", UNAVAILABLE);
  }
  try {
    const rpc = rpcFor(env.value);
    if (!(await rpcIsOnChain(rpc, env.value.chainId))) {
      console.error(`${scope}: the registry's RPC is on a different chain than its configured chain id`);
      return fail("not_configured", UNAVAILABLE);
    }
    return { ok: true, env: env.value, receipt: await getReceiptSoon(rpc, txHash) };
  } catch (err) {
    console.error(`${scope}: the registry's RPC could not be read`, err);
    return fail("not_configured", UNAVAILABLE);
  }
}

/** A verdict that failed, as the reply: a transaction that is not mined yet is not a refusal. */
const refused = (receipt: RpcReceipt | null, reason: string): ChainRecordFailure =>
  receipt ? fail("rejected", reason) : fail("not_confirmed", NOT_CONFIRMED);

/** The row's own registry entry, only when it is on the registry this deployment checks and its pin was checked. */
function registryEntry(strategy: Doc<"strategies">, env: RegistryEnv): { chainStrategyId: string } | null {
  if (strategy.pinVerified !== true || !strategy.chainStrategyId) return null;
  if (strategy.chainId !== env.chainId || strategy.registryAddress?.toLowerCase() !== env.registryAddress) return null;
  return { chainStrategyId: strategy.chainStrategyId };
}

const NO_ENTRY = "This rule has no checked entry on the deployed registry, so it cannot be changed. Pin it again.";

const ownedRef = makeFunctionReference<
  "query",
  { subject: string; strategyId: Id<"strategies"> },
  Doc<"strategies"> | null
>("strategies:ownedForRecord");

/** The caller's own strategy, for an action that has already authenticated them. Internal. */
export const ownedForRecord = internalQuery({
  args: { subject: v.string(), strategyId: v.id("strategies") },
  handler: async (ctx, args) => {
    return (await ownedStrategyBySubject(ctx.db, args.subject, args.strategyId))?.strategy ?? null;
  },
});

const NOT_FOUND = "strategy not found";

// ---------------------------------------------------------------------------
// Pin
// ---------------------------------------------------------------------------

const applyPinRef = makeFunctionReference<
  "mutation",
  {
    subject: string;
    strategyId: Id<"strategies">;
    specHash: string;
    predicatesCommitment: string;
    series: string;
    bondAtoms: Decimal;
    txHash: string;
    chainId: number;
    registryAddress: string;
    chainStrategyId: string;
  },
  { specHash: string }
>("strategies:applyVerifiedPin");

/**
 * Records a pin the chain accepted, after asking the chain. The transaction's
 * receipt must carry the registry's own `StrategyPinned` for the strategy id
 * given, from the caller's linked wallet, with the hash of the draft being
 * pinned, its predicates commitment and its series. The bond recorded is the
 * one in that event. A draft edited after signing cannot be pinned under the
 * old hash, and a made-up transaction hash pins nothing.
 */
export const pinStrategy = action({
  args: {
    strategyId: v.id("strategies"),
    /** The hash that was written on-chain. */
    specHash: v.string(),
    /** The commitment to the predicates, and the series the gate reads, as the registry recorded them. */
    predicatesCommitment: v.string(),
    series: v.string(),
    /** Only its presence is kept for older clients: the bond recorded is read from the chain. */
    bondAtoms: decimal,
    txHash: v.string(),
    chainId: v.number(),
    registryAddress: v.string(),
    chainStrategyId: v.string(),
    /** The wallet's signature of `users:walletLinkChallenge`, the first time a wallet is used. */
    walletSignature: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true; specHash: string } | ChainRecordFailure> => {
    const subject = await requireSubject(ctx);
    requireTx(args.txHash);
    if (!ADDRESS.test(args.registryAddress) || !/^\d{1,78}$/.test(args.chainStrategyId)) {
      return fail("invalid", "The registry address or the strategy id is not valid.");
    }

    const strategy = await ctx.runQuery(ownedRef, { subject, strategyId: args.strategyId });
    if (!strategy) throw new Error(NOT_FOUND);
    if (strategy.status !== "draft" || strategy.pendingSpec === undefined) {
      throw new Error("only a reviewed draft can be pinned");
    }
    const spec = parseSpec(strategy.pendingSpec);
    const hash = await specHash(spec);
    if (hash !== args.specHash) {
      throw new Error("the draft changed after it was signed; review and pin again");
    }
    requireOnchainTarget(spec, args.predicatesCommitment, args.series);

    const wallet = await resolveWallet(ctx, subject, args.walletSignature);
    if (!wallet.ok) return fail(wallet.reason, walletMessages[wallet.reason] ?? "The wallet could not be checked.");

    const read = await readRegistryReceipt("strategies:pinStrategy", args.txHash);
    if (!read.ok) return fail(read.reason, read.message + PIN_RETRY);
    if (args.chainId !== read.env.chainId || args.registryAddress.toLowerCase() !== read.env.registryAddress) {
      return fail("rejected", "That pin is not on the deployed registry.");
    }
    const verdict = verifyPinReceipt({
      receipt: read.receipt,
      registryAddress: read.env.registryAddress,
      chainStrategyId: args.chainStrategyId,
      wallet: wallet.wallet,
      specHash: hash,
      predicatesCommitment: args.predicatesCommitment,
      series: args.series,
    });
    if (!verdict.ok) {
      const no = refused(read.receipt, verdict.reason);
      return no.reason === "not_confirmed" ? fail(no.reason, no.message + PIN_RETRY) : no;
    }

    const out = await ctx.runMutation(applyPinRef, {
      subject,
      strategyId: args.strategyId,
      specHash: hash,
      predicatesCommitment: args.predicatesCommitment.toLowerCase(),
      series: args.series,
      bondAtoms: { atoms: verdict.bondWei.toString(), decimals: NATIVE_DECIMALS },
      txHash: args.txHash,
      chainId: read.env.chainId,
      registryAddress: read.env.registryAddress,
      chainStrategyId: args.chainStrategyId,
    });
    return { ok: true, specHash: out.specHash };
  },
});

/**
 * Writes a pin `pinStrategy` has checked against the chain. Internal: the only
 * way a row becomes `pinned`. It settles again what only one transaction can:
 * that the draft is still the caller's, still a draft, and still the spec
 * whose hash the registry holds, and that this registry entry is not already
 * another of their rules.
 */
export const applyVerifiedPin = internalMutation({
  args: {
    subject: v.string(),
    strategyId: v.id("strategies"),
    specHash: v.string(),
    predicatesCommitment: v.string(),
    series: v.string(),
    bondAtoms: decimal,
    txHash: v.string(),
    chainId: v.number(),
    registryAddress: v.string(),
    chainStrategyId: v.string(),
  },
  handler: async (ctx, args) => {
    const owned = await ownedStrategyBySubject(ctx.db, args.subject, args.strategyId);
    if (!owned) throw new Error(NOT_FOUND);
    const { strategy } = owned;
    if (strategy.status !== "draft" || strategy.pendingSpec === undefined) {
      throw new Error("only a reviewed draft can be pinned");
    }
    const spec = parseSpec(strategy.pendingSpec);
    const hash = await specHash(spec);
    if (hash !== args.specHash) {
      throw new Error("the draft changed after it was signed; review and pin again");
    }

    const others = await ctx.db
      .query("strategies")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", strategy.ownerUserId))
      .take(MAX_LIST_ROWS);
    // One registry entry is one rule. The wallet check already keeps it from being anybody else's.
    const taken = others.some(
      (other) =>
        other._id !== strategy._id &&
        other.chainStrategyId === args.chainStrategyId &&
        other.chainId === args.chainId &&
        other.registryAddress?.toLowerCase() === args.registryAddress,
    );
    if (taken) throw new Error("that registry entry is already recorded as another of your rules");

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
      pinVerified: true,
      predicatesCommitment: args.predicatesCommitment,
      seriesAddress: args.series,
    });
    // The rule this one replaces stops trading by itself: autopilot is turned on for a rule by
    // its owner, never inherited, and never left running on one they have moved on from.
    for (const other of others) {
      if (other._id === strategy._id || !other.autopilot) continue;
      await ctx.db.patch(other._id, { autopilot: false, autopilotBucket: undefined });
      await withdrawWaiting(ctx, other._id);
    }
    // The keeper keeps this rule's series fresh from now on, and stops for one it replaced.
    await recomputeKeeperFeeds(ctx);
    return { specHash: hash };
  },
});

// ---------------------------------------------------------------------------
// Amend
// ---------------------------------------------------------------------------

type AmendOutcome =
  | { kind: "immediate" }
  /** Milliseconds: when the registry's own cooldown ends, read from its event. */
  | { kind: "cooling_off"; chainCooldownEndsAt: number };

const applyAmendmentRef = makeFunctionReference<
  "mutation",
  {
    subject: string;
    strategyId: Id<"strategies">;
    /** The hash in force when the change was checked: the row must not have moved since. */
    fromSpecHash: string;
    nextSpec: unknown;
    predicatesCommitment: string;
    series: string;
    txHash: string;
    outcome: AmendOutcome;
  },
  { kind: "immediate"; specHash: string } | { kind: "cooling_off"; cooldownEndsAt: number }
>("strategies:applyVerifiedAmendment");

/**
 * Changes a pinned rule, after asking the chain what the registry did with it.
 *
 * The plan comes from `planAmendment`, the same pure function the review
 * screen uses: a tightening may apply at once, a loosening is held for
 * `COOLING_OFF_SECONDS` and the old spec stays enforced until then. What the
 * row then says follows the registry's own event, and of the two the stricter:
 *
 *   - `Tightened`, and the plan says it may apply at once: applied at once.
 *   - `LooseningProposed`: held until the later of this server's hold and the
 *     registry's cooldown, whatever the plan says. The registry is waiting,
 *     so the row waits.
 *   - `Tightened` for a change the plan holds (the registry orders predicates
 *     only; a looser size or stop is a loosening here): refused. It is not
 *     applied early, and there is no pending change on-chain to apply later.
 *
 * The client can never make the hold shorter: it supplies no time at all.
 */
export const amendStrategy = action({
  args: {
    strategyId: v.id("strategies"),
    nextSpec: v.any(),
    /** What that call carried next to the hash. */
    predicatesCommitment: v.string(),
    series: v.string(),
    /** The registry call that carried this change: `tighten` or `proposeLoosening`. */
    txHash: v.string(),
    /** Ignored. The registry's cooldown end is read from its own event. Kept so an older client's call still validates. */
    chainCooldownEndsAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; kind: "none" }
    | { ok: true; kind: "immediate"; specHash: string }
    | { ok: true; kind: "cooling_off"; cooldownEndsAt: number }
    | ChainRecordFailure
  > => {
    const subject = await requireSubject(ctx);
    requireTx(args.txHash);
    const strategy = await ctx.runQuery(ownedRef, { subject, strategyId: args.strategyId });
    if (!strategy) throw new Error(NOT_FOUND);
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
    if (plan.kind === "none") return { ok: true, kind: "none" };

    const read = await readRegistryReceipt("strategies:amendStrategy", args.txHash);
    if (!read.ok) return read;
    const entry = registryEntry(strategy, read.env);
    if (!entry) return fail("rejected", NO_ENTRY);

    const claim: RegistryClaim = {
      receipt: read.receipt,
      registryAddress: read.env.registryAddress,
      chainStrategyId: entry.chainStrategyId,
      specHash: await specHash(next),
      predicatesCommitment: args.predicatesCommitment,
      series: args.series,
    };

    let outcome: AmendOutcome;
    const proposed = verifyLooseningProposedReceipt(claim);
    if (proposed.ok) {
      outcome = { kind: "cooling_off", chainCooldownEndsAt: proposed.cooldownEndsAtMs };
    } else {
      const tightened = verifyTightenReceipt(claim);
      if (!tightened.ok) {
        // The reason of the check the plan called for: that is the event the caller meant to send.
        return refused(read.receipt, plan.kind === "immediate" ? tightened.reason : proposed.reason);
      }
      if (plan.kind !== "immediate") {
        return fail(
          "rejected",
          "The registry applied this at once, but it loosens the rule, and a loosening waits. It was not recorded. Propose it as a loosening.",
        );
      }
      outcome = { kind: "immediate" };
    }

    const out = await ctx.runMutation(applyAmendmentRef, {
      subject,
      strategyId: args.strategyId,
      fromSpecHash: strategy.specHash,
      nextSpec: next,
      predicatesCommitment: args.predicatesCommitment.toLowerCase(),
      series: args.series,
      txHash: args.txHash,
      outcome,
    });
    return { ok: true, ...out };
  },
});

/** Writes a change `amendStrategy` has checked against the chain. Internal. */
export const applyVerifiedAmendment = internalMutation({
  args: {
    subject: v.string(),
    strategyId: v.id("strategies"),
    fromSpecHash: v.string(),
    nextSpec: v.any(),
    predicatesCommitment: v.string(),
    series: v.string(),
    txHash: v.string(),
    outcome: v.union(
      v.object({ kind: v.literal("immediate") }),
      v.object({ kind: v.literal("cooling_off"), chainCooldownEndsAt: v.number() }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ kind: "immediate"; specHash: string } | { kind: "cooling_off"; cooldownEndsAt: number }> => {
    const owned = await ownedStrategyBySubject(ctx.db, args.subject, args.strategyId);
    if (!owned) throw new Error(NOT_FOUND);
    const { strategy } = owned;
    if (strategy.status !== "pinned" || strategy.spec === undefined || strategy.specHash !== args.fromSpecHash) {
      throw new Error("the rule changed while this was being checked; review and send it again");
    }

    const current = parseSpec(strategy.spec);
    const next = parseSpec(args.nextSpec);
    const plan = planAmendment(current, next, {
      currentSeries: strategy.seriesAddress,
      nextSeries: args.series,
    });

    if (args.outcome.kind === "immediate") {
      // Decided again here, from the row as it is now: only a change the plan lets through applies at once.
      if (plan.kind !== "immediate") throw new Error("a loosening waits out its cooling-off period");
      const hash = await specHash(next);
      await ctx.db.patch(strategy._id, {
        spec: next,
        specHash: hash,
        predicatesCommitment: args.predicatesCommitment,
        seriesAddress: args.series,
        amendTxHash: args.txHash,
      });
      return { kind: "immediate", specHash: hash };
    }

    const held = plan.kind === "cooling_off" ? cooldownEndsAt(Date.now(), plan.cooldownSeconds) : 0;
    const endsAt = Math.max(held, args.outcome.chainCooldownEndsAt);
    await ctx.db.patch(strategy._id, {
      status: "cooling_off",
      pendingSpec: next,
      pendingPredicatesCommitment: args.predicatesCommitment,
      pendingSeriesAddress: args.series,
      cooldownEndsAt: endsAt,
      amendTxHash: args.txHash,
    });
    return { kind: "cooling_off", cooldownEndsAt: endsAt };
  },
});

const applyFinalizationRef = makeFunctionReference<
  "mutation",
  { subject: string; strategyId: Id<"strategies">; pendingSpecHash: string; txHash: string },
  { specHash: string }
>("strategies:applyVerifiedFinalization");

/**
 * Applies a loosening whose hold has fully run, after asking the chain. It is
 * refused a millisecond before this server's own hold ends, and refused unless
 * the receipt carries the registry's `LooseningFinalized` for this strategy
 * adopting exactly the spec that was pending.
 */
export const finalizeAmendment = action({
  args: {
    strategyId: v.id("strategies"),
    txHash: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true; specHash: string } | ChainRecordFailure> => {
    const subject = await requireSubject(ctx);
    requireTx(args.txHash);
    const strategy = await ctx.runQuery(ownedRef, { subject, strategyId: args.strategyId });
    if (!strategy) throw new Error(NOT_FOUND);
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
    const commitment = strategy.pendingPredicatesCommitment ?? strategy.predicatesCommitment;
    const series = strategy.pendingSeriesAddress ?? strategy.seriesAddress;
    if (!commitment || !series) return fail("rejected", NO_ENTRY);

    const read = await readRegistryReceipt("strategies:finalizeAmendment", args.txHash);
    if (!read.ok) return read;
    const entry = registryEntry(strategy, read.env);
    if (!entry) return fail("rejected", NO_ENTRY);

    const pendingSpecHash = await specHash(parseSpec(strategy.pendingSpec));
    const verdict = verifyLooseningFinalizedReceipt({
      receipt: read.receipt,
      registryAddress: read.env.registryAddress,
      chainStrategyId: entry.chainStrategyId,
      specHash: pendingSpecHash,
      predicatesCommitment: commitment,
      series,
    });
    if (!verdict.ok) return refused(read.receipt, verdict.reason);

    const out = await ctx.runMutation(applyFinalizationRef, {
      subject,
      strategyId: args.strategyId,
      pendingSpecHash,
      txHash: args.txHash,
    });
    return { ok: true, specHash: out.specHash };
  },
});

/** Writes an applied loosening `finalizeAmendment` has checked against the chain. Internal. */
export const applyVerifiedFinalization = internalMutation({
  args: {
    subject: v.string(),
    strategyId: v.id("strategies"),
    pendingSpecHash: v.string(),
    txHash: v.string(),
  },
  handler: async (ctx, args) => {
    const owned = await ownedStrategyBySubject(ctx.db, args.subject, args.strategyId);
    if (!owned) throw new Error(NOT_FOUND);
    const { strategy } = owned;
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
    if (hash !== args.pendingSpecHash) {
      throw new Error("the rule changed while this was being checked; try again");
    }
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
    // A loosening can move the rule to another series: the keeper follows it.
    if (strategy.pendingSeriesAddress !== undefined && strategy.pendingSeriesAddress !== strategy.seriesAddress) {
      await recomputeKeeperFeeds(ctx);
    }
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

/** Why autopilot is not turned on for a rule the gate cannot judge. A sentence the app shows as it is. */
const AUTOPILOT_NOT_CONFIGURED = "Autopilot is judged on the on-chain gate, which is not configured on this deployment.";
const AUTOPILOT_SIGNER_OFF = "Autopilot is judged on the on-chain gate, and Kanon's signer is switched off on this deployment, so nothing would judge it.";

/**
 * Turns autopilot on or off for the caller's own strategy. On, the rule is
 * judged on the on-chain gate once per 15-minute bucket with nobody pressing
 * anything, and a bucket that passes opens a timed trade (`autopilot.ts`).
 *
 * It can only be turned on for a rule that is enforced (a draft is judged by
 * nothing) and that the gate on this deployment can judge: written on 15m
 * candles, pinned and read from the chain, on this deployment's chain and
 * registry, on a series the keeper samples. Anything else is refused with a
 * sentence (`not_eligible`). Turning it on remembers the bucket it is turned
 * on in, so no price from before is judged. Turning it off withdraws any
 * proposal still waiting to be opened. A trade already running runs to its
 * time, or until its owner ends it.
 *
 * This changes when the rule is consulted, never what the rule is: no predicate
 * is loosened by it, so it does not wait out a cooling-off period.
 */
export const setAutopilot = mutation({
  args: {
    strategyId: v.id("strategies"),
    on: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { strategy } = await requireOwnedStrategy(ctx, args.strategyId);
    if (strategy.autopilot === args.on) return { autopilot: strategy.autopilot };
    if (args.on && (strategy.spec === undefined || (strategy.status !== "pinned" && strategy.status !== "cooling_off"))) {
      throw new Error("autopilot runs a pinned rule; pin this one first");
    }
    // Autopilot is what sends orders to the venue for a rule, so it runs only a pin this backend read from the chain.
    if (args.on && strategy.pinVerified !== true) {
      throw new Error("this rule's pin was recorded before pins were checked on-chain; pin it again to run it on autopilot");
    }
    let autopilotBucket: number | undefined;
    if (args.on) {
      const gate = parseGateEnv(process.env);
      if (!gate.ok) throw new ConvexError({ code: "not_eligible", message: AUTOPILOT_NOT_CONFIGURED });
      const on = parseKeeperSwitch(process.env);
      if (!on.ok || !on.value) throw new ConvexError({ code: "not_eligible", message: AUTOPILOT_SIGNER_OFF });
      const eligible = gateEligibility(strategy, parseSpec(strategy.spec), gate.value);
      if (!eligible.ok) throw new ConvexError({ code: "not_eligible", message: eligible.message });
      const nowSeconds = Math.floor(Date.now() / 1000);
      autopilotBucket = nowSeconds - (nowSeconds % GATE_BUCKET_SECONDS);
    }
    await ctx.db.patch(strategy._id, { autopilot: args.on, autopilotBucket });
    if (!args.on) await withdrawWaiting(ctx, strategy._id);
    return { autopilot: args.on };
  },
});

/** The hold, for clients that want to show it before a change is made. */
export const coolingOffSeconds = query({
  args: {},
  handler: async () => COOLING_OFF_SECONDS,
});
