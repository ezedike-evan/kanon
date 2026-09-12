import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    privyId: v.string(),
    email: v.optional(v.string()),
    name: v.string(),
    username: v.string(),
    experience: v.string(),
  }).index("by_privyId", ["privyId"]),
});
