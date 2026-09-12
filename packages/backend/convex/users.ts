import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const createUser = mutation({
  args: {
    privyId: v.string(),
    email: v.optional(v.string()),
    name: v.string(),
    username: v.string(),
    experience: v.string(),
  },
  handler: async (ctx, args) => {
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_privyId", (q) => q.eq("privyId", args.privyId))
      .first();

    if (existingUser) {
      return await ctx.db.patch(existingUser._id, {
        name: args.name,
        username: args.username,
        experience: args.experience,
        ...(args.email ? { email: args.email } : {}),
      });
    }

    return await ctx.db.insert("users", {
      privyId: args.privyId,
      email: args.email,
      name: args.name,
      username: args.username,
      experience: args.experience,
    });
  },
});

export const getUserByPrivyId = query({
  args: { privyId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_privyId", (q) => q.eq("privyId", args.privyId))
      .first();
  },
});
