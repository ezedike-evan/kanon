import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { recoverLinkedWallet, walletLinkMessage } from "@kanon/spec";
import { cleanUserInput, usernameKey, validateUserInput } from "./usersLogic";
import { bindPrivyId, requireSubject, userBySubject, viewerUser } from "./authz";

/**
 * Creates (or updates) the signed-in user's row.
 *
 * The row's `privyId` is the token's subject and nothing else. `privyId` may
 * still be sent, as a check: a value that is not the token's subject is
 * refused, so a client cannot create or overwrite a row for someone it is not.
 */
export const createUser = mutation({
  args: {
    privyId: v.optional(v.string()),
    email: v.optional(v.string()),
    name: v.string(),
    username: v.string(),
    experience: v.string(),
  },
  handler: async (ctx, args) => {
    const privyId = bindPrivyId(await requireSubject(ctx), args.privyId);
    const existingUser = await userBySubject(ctx.db, privyId);

    const clean = cleanUserInput(args);
    const problems = validateUserInput(clean);
    if (problems.length > 0) {
      throw new ConvexError({ code: "invalid_user", message: problems.map((p) => p.message).join(" "), problems: problems.map((p) => ({ field: p.field, message: p.message })) });
    }

    const key = usernameKey(clean.username);
    const holder = await ctx.db
      .query("users")
      .withIndex("by_usernameLower", (q) => q.eq("usernameLower", key))
      .first();
    if (holder && holder._id !== existingUser?._id) {
      throw new ConvexError({
        code: "username_taken",
        message: "That username is taken. Choose another.",
        problems: [{ field: "username", message: "That username is taken. Choose another." }],
      });
    }

    if (existingUser) {
      return await ctx.db.patch(existingUser._id, {
        name: clean.name,
        username: clean.username,
        usernameLower: key,
        experience: clean.experience,
        ...(clean.email ? { email: clean.email } : {}),
      });
    }

    return await ctx.db.insert("users", {
      privyId,
      name: clean.name,
      username: clean.username,
      usernameLower: key,
      experience: clean.experience,
      ...(clean.email ? { email: clean.email } : {}),
    });
  },
});

/**
 * The signed-in user's own row, or `null` (signed out, or no row yet). This is
 * the only way a client reads a `users` row: there is no lookup by id or by
 * `privyId`, because a row carries an email.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    return await viewerUser(ctx);
  },
});

/**
 * The wallet a user has proved control of. Internal: the actions that verify
 * chain data pass the DID they already authenticated.
 */
export const walletOf = internalQuery({
  args: { subject: v.string() },
  handler: async (ctx, args) => {
    const user = await userBySubject(ctx.db, args.subject);
    return user ? { userId: user._id, wallet: user.walletAddress ?? null } : null;
  },
});

/** First link wins, and a wallet belongs to one user. Returns the bound address or why not. */
export const bindWallet = internalMutation({
  args: { subject: v.string(), wallet: v.string() },
  handler: async (ctx, args): Promise<{ ok: true; wallet: string } | { ok: false; reason: "already_linked" | "wallet_in_use" | "no_user" }> => {
    const user = await userBySubject(ctx.db, args.subject);
    if (!user) return { ok: false, reason: "no_user" };
    const wallet = args.wallet.toLowerCase();
    if (user.walletAddress) {
      return user.walletAddress === wallet ? { ok: true, wallet } : { ok: false, reason: "already_linked" };
    }
    const holder = await ctx.db
      .query("users")
      .withIndex("by_walletAddress", (q) => q.eq("walletAddress", wallet))
      .first();
    if (holder) return { ok: false, reason: "wallet_in_use" };
    await ctx.db.patch(user._id, { walletAddress: wallet });
    return { ok: true, wallet };
  },
});

const walletOfRef = makeFunctionReference<
  "query",
  { subject: string },
  { userId: string; wallet: string | null } | null
>("users:walletOf");
const bindWalletRef = makeFunctionReference<
  "mutation",
  { subject: string; wallet: string },
  { ok: true; wallet: string } | { ok: false; reason: "already_linked" | "wallet_in_use" | "no_user" }
>("users:bindWallet");

export type WalletResult =
  | { ok: true; userId: string; wallet: string }
  | { ok: false; reason: "no_user" | "wallet_not_linked" | "bad_signature" | "already_linked" | "wallet_in_use" };

/**
 * The wallet chain rows are checked against. A linked wallet is used as is; an
 * unlinked user may link one now by signing `walletLinkMessage`. Never takes an
 * address from the client: the address is recovered from the signature.
 */
export async function resolveWallet(
  ctx: {
    runQuery: (ref: typeof walletOfRef, args: { subject: string }) => Promise<{ userId: string; wallet: string | null } | null>;
    runMutation: (ref: typeof bindWalletRef, args: { subject: string; wallet: string }) => Promise<
      { ok: true; wallet: string } | { ok: false; reason: "already_linked" | "wallet_in_use" | "no_user" }
    >;
  },
  subject: string,
  signature: string | undefined,
): Promise<WalletResult> {
  const row = await ctx.runQuery(walletOfRef, { subject });
  if (!row) return { ok: false, reason: "no_user" };
  if (row.wallet) return { ok: true, userId: row.userId, wallet: row.wallet };
  if (!signature) return { ok: false, reason: "wallet_not_linked" };
  const recovered = await recoverLinkedWallet(subject, signature);
  if (!recovered) return { ok: false, reason: "bad_signature" };
  const bound = await ctx.runMutation(bindWalletRef, { subject, wallet: recovered });
  if (!bound.ok) return { ok: false, reason: bound.reason };
  return { ok: true, userId: row.userId, wallet: bound.wallet };
}

/** Links the signer of `walletLinkMessage` to the signed-in user. */
export const linkWallet = action({
  args: { signature: v.string() },
  handler: async (ctx, args): Promise<WalletResult> => {
    const subject = await requireSubject(ctx);
    return await resolveWallet(ctx, subject, args.signature);
  },
});

/** The exact text the wallet signs to link itself to this account. Names the caller's DID, so it cannot be replayed onto another. */
export const walletLinkChallenge = action({
  args: {},
  handler: async (ctx): Promise<{ message: string }> => {
    return { message: walletLinkMessage(await requireSubject(ctx)) };
  },
});
