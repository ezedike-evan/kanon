import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
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

    if (existingUser) {
      return await ctx.db.patch(existingUser._id, {
        name: args.name,
        username: args.username,
        experience: args.experience,
        ...(args.email ? { email: args.email } : {}),
      });
    }

    return await ctx.db.insert("users", {
      privyId,
      name: args.name,
      username: args.username,
      experience: args.experience,
      ...(args.email ? { email: args.email } : {}),
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
