import { ConvexError } from "convex/values";
import type { Auth } from "convex/server";
import type { DatabaseReader } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Who is calling, and whether the row they named is theirs.
 *
 * Identity comes only from the verified Privy access token (`auth.config.ts`),
 * read through `ctx.auth`. No public function takes a user id from the client:
 * it derives the user here, then checks the row it was asked about belongs to
 * that user. The Privy DID (`identity.subject`, e.g. `did:privy:...`) is stored
 * verbatim in `users.privyId`, so the lookup is an exact match.
 *
 * Two shapes for every resource:
 *
 *   `require*`  mutations and actions. Throws `unauthenticated` with no valid
 *               token, `no_user` for a token with no `users` row yet, and
 *               `not_found` for a row that is missing *or someone else's*: the
 *               two are indistinguishable so an id cannot be probed.
 *   `view*`     reactive queries. Returns `null` in every one of those cases, so
 *               a screen that mounts a beat before the token lands renders
 *               empty instead of throwing.
 *
 * Both fail closed. Neither ever falls back to a client-supplied id.
 */

export type AuthErrorCode = "unauthenticated" | "no_user" | "not_found";
export type AuthErrorData = { code: AuthErrorCode; message: string };

export function authError(code: AuthErrorCode, message: string): ConvexError<AuthErrorData> {
  return new ConvexError<AuthErrorData>({ code, message });
}

const unauthenticated = () => authError("unauthenticated", "Sign in to continue.");
const notFound = (what: string) => authError("not_found", `${what} not found`);

/** The slice of a Convex ctx that carries identity. Queries, mutations and actions all have it. */
export type AuthCtx = { auth: Auth };
/** Identity plus a reader: every query and mutation ctx satisfies this. */
export type ReadCtx = AuthCtx & { db: DatabaseReader };

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/**
 * The Privy DID from a token's identity. A missing identity, or one whose
 * subject is empty, is unauthenticated: an empty subject must never match a
 * `users` row.
 */
export function subjectOf(identity: { subject?: string } | null | undefined): string {
  const subject = identity?.subject;
  if (typeof subject !== "string" || subject.trim() === "") throw unauthenticated();
  return subject;
}

/** True only when both ids are present and equal. */
export function isOwner(ownerId: string | undefined | null, userId: string): boolean {
  return typeof ownerId === "string" && ownerId !== "" && ownerId === userId;
}

/**
 * The privyId a `createUser` call is allowed to write: the token's subject,
 * and only that. A client-supplied `privyId` is accepted as a sanity check but
 * never as authority; a mismatch is refused rather than quietly overridden.
 */
export function bindPrivyId(subject: string, claimed: string | undefined): string {
  if (claimed !== undefined && claimed !== subject) {
    throw authError("unauthenticated", "That account does not belong to the signed-in user.");
  }
  return subject;
}

// ---------------------------------------------------------------------------
// Identity and user
// ---------------------------------------------------------------------------

/** The token's Privy DID. Throws `unauthenticated` with no valid token. */
export async function requireSubject(ctx: AuthCtx): Promise<string> {
  return subjectOf(await ctx.auth.getUserIdentity());
}

/** The `users` row for a Privy DID, or `null`. */
export async function userBySubject(
  db: DatabaseReader,
  subject: string,
): Promise<Doc<"users"> | null> {
  return await db
    .query("users")
    .withIndex("by_privyId", (q) => q.eq("privyId", subject))
    .first();
}

/** The signed-in user's row, or `null` (no token, or no row yet). Never throws on auth. */
export async function viewerUser(ctx: ReadCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || typeof identity.subject !== "string" || identity.subject.trim() === "") return null;
  return await userBySubject(ctx.db, identity.subject);
}

/** The signed-in user's row. Throws `unauthenticated` or `no_user`. */
export async function requireUser(ctx: ReadCtx): Promise<Doc<"users">> {
  const subject = await requireSubject(ctx);
  const user = await userBySubject(ctx.db, subject);
  if (!user) throw authError("no_user", "Finish signing up to continue.");
  return user;
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

async function requireOwned<T>(
  ctx: ReadCtx,
  what: string,
  find: (user: Doc<"users">) => Promise<T | null>,
): Promise<{ user: Doc<"users">; row: T }> {
  const user = await requireUser(ctx);
  const row = await find(user);
  if (!row) throw notFound(what);
  return { user, row };
}

async function viewOwned<T>(
  ctx: ReadCtx,
  find: (user: Doc<"users">) => Promise<T | null>,
): Promise<{ user: Doc<"users">; row: T } | null> {
  const user = await viewerUser(ctx);
  if (!user) return null;
  const row = await find(user);
  return row ? { user, row } : null;
}

const strategyOf =
  (db: DatabaseReader, id: Id<"strategies">) =>
  async (user: Doc<"users">): Promise<Doc<"strategies"> | null> => {
    const strategy = await db.get(id);
    return strategy && isOwner(strategy.ownerUserId, user._id) ? strategy : null;
  };

const tradeOf =
  (db: DatabaseReader, id: Id<"trades">) =>
  async (user: Doc<"users">): Promise<{ trade: Doc<"trades">; strategy: Doc<"strategies"> } | null> => {
    const trade = await db.get(id);
    if (!trade) return null;
    const strategy = await strategyOf(db, trade.strategyId)(user);
    return strategy ? { trade, strategy } : null;
  };

const vaultOf =
  (db: DatabaseReader, id: Id<"vaults">) =>
  async (user: Doc<"users">): Promise<Doc<"vaults"> | null> => {
    const vault = await db.get(id);
    return vault && isOwner(vault.ownerUserId, user._id) ? vault : null;
  };

const accountOf =
  (db: DatabaseReader, id: Id<"accounts">) =>
  async (user: Doc<"users">): Promise<Doc<"accounts"> | null> => {
    const account = await db.get(id);
    return account && isOwner(account.userId, user._id) ? account : null;
  };

const positionOf =
  (db: DatabaseReader, id: Id<"positions">) =>
  async (user: Doc<"users">): Promise<Doc<"positions"> | null> => {
    const position = await db.get(id);
    if (!position) return null;
    return (await accountOf(db, position.accountId)(user)) ? position : null;
  };

const copyRelationshipOf =
  (db: DatabaseReader, id: Id<"copyRelationships">) =>
  async (user: Doc<"users">): Promise<Doc<"copyRelationships"> | null> => {
    const row = await db.get(id);
    return row && isOwner(row.followerUserId, user._id) ? row : null;
  };

const predictionOf =
  (db: DatabaseReader, id: Id<"predictions">) =>
  async (user: Doc<"users">): Promise<Doc<"predictions"> | null> => {
    const row = await db.get(id);
    return row && isOwner(row.userId, user._id) ? row : null;
  };

export async function requireOwnedStrategy(ctx: ReadCtx, id: Id<"strategies">) {
  const { user, row } = await requireOwned(ctx, "strategy", strategyOf(ctx.db, id));
  return { user, strategy: row };
}
export async function viewOwnedStrategy(ctx: ReadCtx, id: Id<"strategies">) {
  const found = await viewOwned(ctx, strategyOf(ctx.db, id));
  return found ? { user: found.user, strategy: found.row } : null;
}

export async function requireOwnedTrade(ctx: ReadCtx, id: Id<"trades">) {
  const { user, row } = await requireOwned(ctx, "trade", tradeOf(ctx.db, id));
  return { user, trade: row.trade, strategy: row.strategy };
}
export async function viewOwnedTrade(ctx: ReadCtx, id: Id<"trades">) {
  const found = await viewOwned(ctx, tradeOf(ctx.db, id));
  return found ? { user: found.user, trade: found.row.trade, strategy: found.row.strategy } : null;
}

export async function requireOwnedVault(ctx: ReadCtx, id: Id<"vaults">) {
  const { user, row } = await requireOwned(ctx, "vault", vaultOf(ctx.db, id));
  return { user, vault: row };
}
export async function viewOwnedVault(ctx: ReadCtx, id: Id<"vaults">) {
  const found = await viewOwned(ctx, vaultOf(ctx.db, id));
  return found ? { user: found.user, vault: found.row } : null;
}

export async function requireOwnedAccount(ctx: ReadCtx, id: Id<"accounts">) {
  const { user, row } = await requireOwned(ctx, "account", accountOf(ctx.db, id));
  return { user, account: row };
}
export async function viewOwnedAccount(ctx: ReadCtx, id: Id<"accounts">) {
  const found = await viewOwned(ctx, accountOf(ctx.db, id));
  return found ? { user: found.user, account: found.row } : null;
}

export async function requireOwnedPosition(ctx: ReadCtx, id: Id<"positions">) {
  const { user, row } = await requireOwned(ctx, "position", positionOf(ctx.db, id));
  return { user, position: row };
}
export async function viewOwnedPosition(ctx: ReadCtx, id: Id<"positions">) {
  const found = await viewOwned(ctx, positionOf(ctx.db, id));
  return found ? { user: found.user, position: found.row } : null;
}

export async function requireOwnedCopyRelationship(ctx: ReadCtx, id: Id<"copyRelationships">) {
  const { user, row } = await requireOwned(ctx, "relationship", copyRelationshipOf(ctx.db, id));
  return { user, relationship: row };
}
export async function viewOwnedCopyRelationship(ctx: ReadCtx, id: Id<"copyRelationships">) {
  const found = await viewOwned(ctx, copyRelationshipOf(ctx.db, id));
  return found ? { user: found.user, relationship: found.row } : null;
}

export async function viewOwnedPrediction(ctx: ReadCtx, id: Id<"predictions">) {
  const found = await viewOwned(ctx, predictionOf(ctx.db, id));
  return found ? { user: found.user, prediction: found.row } : null;
}

/**
 * For an internal function that acts for a user an action already
 * authenticated: the strategy, only if that DID owns it. Actions cannot read
 * the database, so they pass `identity.subject` to an internal query that
 * calls this.
 */
export async function ownedStrategyBySubject(
  db: DatabaseReader,
  subject: string,
  id: Id<"strategies">,
): Promise<{ user: Doc<"users">; strategy: Doc<"strategies"> } | null> {
  const user = await userBySubject(db, subject);
  if (!user) return null;
  const strategy = await strategyOf(db, id)(user);
  return strategy ? { user, strategy } : null;
}
