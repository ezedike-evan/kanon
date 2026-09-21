import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  bindPrivyId,
  isOwner,
  ownedStrategyBySubject,
  requireOwnedAccount,
  requireOwnedCopyRelationship,
  requireOwnedPosition,
  requireOwnedStrategy,
  requireOwnedTrade,
  requireOwnedVault,
  requireSubject,
  requireUser,
  subjectOf,
  viewOwnedPrediction,
  viewOwnedStrategy,
  viewOwnedTrade,
  viewOwnedVault,
  viewerUser,
  type AuthErrorData,
  type ReadCtx,
} from "./authz";
import { createUser, me } from "./users";

type Row = Record<string, unknown> & { _id: string };

/** A just-enough Convex db: `get` by id, and `query().withIndex(name, q => q.eq(...)).first()`. */
function fakeDb(tables: Record<string, Row[]>) {
  const state = tables;
  const inserted: Array<{ table: string; doc: Record<string, unknown> }> = [];
  const patched: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return {
    inserted,
    patched,
    db: {
      get: async (id: string) => {
        for (const rows of Object.values(state)) {
          const hit = rows.find((r) => r._id === id);
          if (hit) return hit;
        }
        return null;
      },
      query: (table: string) => ({
        withIndex: (_index: string, build: (q: { eq: (f: string, v: unknown) => unknown }) => unknown) => {
          const eqs: Record<string, unknown> = {};
          const q = {
            eq(field: string, value: unknown) {
              eqs[field] = value;
              return q;
            },
          };
          build(q);
          const rows = (state[table] ?? []).filter((r) => Object.entries(eqs).every(([k, v]) => r[k] === v));
          return { first: async () => rows[0] ?? null, collect: async () => rows };
        },
      }),
      insert: async (table: string, doc: Record<string, unknown>) => {
        inserted.push({ table, doc });
        return `${table}:new`;
      },
      patch: async (id: string, patch: Record<string, unknown>) => {
        patched.push({ id, patch });
      },
    },
  };
}

const ALICE_DID = "did:privy:alice";
const BOB_DID = "did:privy:bob";

const seed = () => ({
  users: [
    { _id: "users:alice", privyId: ALICE_DID, name: "Alice" },
    { _id: "users:bob", privyId: BOB_DID, name: "Bob" },
  ],
  strategies: [
    { _id: "strategies:a", ownerUserId: "users:alice" },
    { _id: "strategies:b", ownerUserId: "users:bob" },
  ],
  trades: [
    { _id: "trades:a", strategyId: "strategies:a" },
    { _id: "trades:b", strategyId: "strategies:b" },
    { _id: "trades:orphan", strategyId: "strategies:gone" },
  ],
  vaults: [
    { _id: "vaults:a", ownerUserId: "users:alice" },
    { _id: "vaults:b", ownerUserId: "users:bob" },
  ],
  accounts: [
    { _id: "accounts:a", userId: "users:alice" },
    { _id: "accounts:b", userId: "users:bob" },
  ],
  positions: [
    { _id: "positions:a", accountId: "accounts:a" },
    { _id: "positions:b", accountId: "accounts:b" },
  ],
  copyRelationships: [
    { _id: "copy:a", followerUserId: "users:alice" },
    { _id: "copy:b", followerUserId: "users:bob" },
  ],
  predictions: [
    { _id: "predictions:a", userId: "users:alice" },
    { _id: "predictions:b", userId: "users:bob" },
  ],
});

function ctxFor(subject: string | null, tables = seed(), extra: { subjectValue?: unknown } = {}) {
  const fake = fakeDb(tables as unknown as Record<string, Row[]>);
  const identity =
    subject === null && !("subjectValue" in extra) ? null : { subject: "subjectValue" in extra ? extra.subjectValue : subject };
  const ctx = {
    auth: { getUserIdentity: async () => identity },
    db: fake.db,
  } as unknown as ReadCtx;
  return { ctx, fake };
}

async function errorOf(p: Promise<unknown>): Promise<AuthErrorData> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConvexError);
    return (e as ConvexError<AuthErrorData>).data;
  }
  throw new Error("expected the call to throw");
}

describe("subjectOf", () => {
  it("returns the Privy DID exactly as the token carries it", () => {
    expect(subjectOf({ subject: ALICE_DID })).toBe(ALICE_DID);
  });

  it.each([null, undefined, {}, { subject: "" }, { subject: "   " }])("refuses %j as unauthenticated", (identity) => {
    try {
      subjectOf(identity as never);
      throw new Error("did not throw");
    } catch (e) {
      expect((e as ConvexError<AuthErrorData>).data.code).toBe("unauthenticated");
    }
  });
});

describe("isOwner", () => {
  it("matches only equal, present ids", () => {
    expect(isOwner("users:a", "users:a")).toBe(true);
    expect(isOwner("users:a", "users:b")).toBe(false);
    expect(isOwner(undefined, "users:a")).toBe(false);
    expect(isOwner(null, "users:a")).toBe(false);
    expect(isOwner("", "")).toBe(false);
  });
});

describe("bindPrivyId", () => {
  it("is the token subject whether or not a privyId was claimed", () => {
    expect(bindPrivyId(ALICE_DID, undefined)).toBe(ALICE_DID);
    expect(bindPrivyId(ALICE_DID, ALICE_DID)).toBe(ALICE_DID);
  });

  it("refuses a claimed privyId that is not the token's subject", () => {
    expect(() => bindPrivyId(ALICE_DID, BOB_DID)).toThrow(ConvexError);
    expect(() => bindPrivyId(ALICE_DID, "")).toThrow(ConvexError);
  });
});

describe("identity and user", () => {
  it("requireSubject: unauthenticated without a token", async () => {
    const { ctx } = ctxFor(null);
    expect((await errorOf(requireSubject(ctx))).code).toBe("unauthenticated");
  });

  it("requireSubject: an identity with an empty subject is unauthenticated", async () => {
    const { ctx } = ctxFor(null, seed(), { subjectValue: "" });
    expect((await errorOf(requireSubject(ctx))).code).toBe("unauthenticated");
  });

  it("requireUser: unauthenticated, then no_user, then the row", async () => {
    expect((await errorOf(requireUser(ctxFor(null).ctx))).code).toBe("unauthenticated");
    expect((await errorOf(requireUser(ctxFor("did:privy:stranger").ctx))).code).toBe("no_user");
    expect((await requireUser(ctxFor(ALICE_DID).ctx))._id).toBe("users:alice");
  });

  it("matches the DID exactly: a different case or a prefix is another user", async () => {
    expect(await viewerUser(ctxFor("did:privy:ALICE").ctx)).toBeNull();
    expect(await viewerUser(ctxFor("did:privy:alic").ctx)).toBeNull();
    expect(await viewerUser(ctxFor("alice").ctx)).toBeNull();
  });

  it("viewerUser is null, not a throw, without a token or a row", async () => {
    expect(await viewerUser(ctxFor(null).ctx)).toBeNull();
    expect(await viewerUser(ctxFor("did:privy:stranger").ctx)).toBeNull();
    expect((await viewerUser(ctxFor(BOB_DID).ctx))?._id).toBe("users:bob");
  });
});

describe("ownership: require* (mutations)", () => {
  it("returns the row to its owner", async () => {
    const { ctx } = ctxFor(ALICE_DID);
    expect((await requireOwnedStrategy(ctx, "strategies:a" as never)).strategy._id).toBe("strategies:a");
    expect((await requireOwnedTrade(ctx, "trades:a" as never)).trade._id).toBe("trades:a");
    expect((await requireOwnedVault(ctx, "vaults:a" as never)).vault._id).toBe("vaults:a");
    expect((await requireOwnedAccount(ctx, "accounts:a" as never)).account._id).toBe("accounts:a");
    expect((await requireOwnedPosition(ctx, "positions:a" as never)).position._id).toBe("positions:a");
    expect((await requireOwnedCopyRelationship(ctx, "copy:a" as never)).relationship._id).toBe("copy:a");
  });

  it("wrong owner is not_found for every resource, never the row", async () => {
    const { ctx } = ctxFor(ALICE_DID);
    const others = [
      requireOwnedStrategy(ctx, "strategies:b" as never),
      requireOwnedTrade(ctx, "trades:b" as never),
      requireOwnedVault(ctx, "vaults:b" as never),
      requireOwnedAccount(ctx, "accounts:b" as never),
      requireOwnedPosition(ctx, "positions:b" as never),
      requireOwnedCopyRelationship(ctx, "copy:b" as never),
    ];
    for (const p of others) expect((await errorOf(p)).code).toBe("not_found");
  });

  it("a missing row and someone else's row are indistinguishable", async () => {
    const { ctx } = ctxFor(ALICE_DID);
    const theirs = await errorOf(requireOwnedStrategy(ctx, "strategies:b" as never));
    const missing = await errorOf(requireOwnedStrategy(ctx, "strategies:nope" as never));
    expect(theirs).toEqual(missing);
  });

  it("a trade whose strategy is gone belongs to nobody", async () => {
    const { ctx } = ctxFor(ALICE_DID);
    expect((await errorOf(requireOwnedTrade(ctx, "trades:orphan" as never))).code).toBe("not_found");
  });

  it("no token: unauthenticated, before any row is looked at", async () => {
    const { ctx } = ctxFor(null);
    expect((await errorOf(requireOwnedStrategy(ctx, "strategies:a" as never))).code).toBe("unauthenticated");
    expect((await errorOf(requireOwnedVault(ctx, "vaults:a" as never))).code).toBe("unauthenticated");
  });

  it("a token with no users row cannot reach anything", async () => {
    const { ctx } = ctxFor("did:privy:stranger");
    expect((await errorOf(requireOwnedStrategy(ctx, "strategies:a" as never))).code).toBe("no_user");
  });
});

describe("ownership: view* (queries)", () => {
  it("returns the row to its owner", async () => {
    const { ctx } = ctxFor(BOB_DID);
    expect((await viewOwnedStrategy(ctx, "strategies:b" as never))?.strategy._id).toBe("strategies:b");
    expect((await viewOwnedTrade(ctx, "trades:b" as never))?.trade._id).toBe("trades:b");
    expect((await viewOwnedVault(ctx, "vaults:b" as never))?.vault._id).toBe("vaults:b");
    expect((await viewOwnedPrediction(ctx, "predictions:b" as never))?.prediction._id).toBe("predictions:b");
  });

  it("is null for someone else's row, a missing row, no token and no users row", async () => {
    expect(await viewOwnedStrategy(ctxFor(ALICE_DID).ctx, "strategies:b" as never)).toBeNull();
    expect(await viewOwnedStrategy(ctxFor(ALICE_DID).ctx, "strategies:nope" as never)).toBeNull();
    expect(await viewOwnedStrategy(ctxFor(null).ctx, "strategies:a" as never)).toBeNull();
    expect(await viewOwnedStrategy(ctxFor("did:privy:stranger").ctx, "strategies:a" as never)).toBeNull();
    expect(await viewOwnedTrade(ctxFor(ALICE_DID).ctx, "trades:b" as never)).toBeNull();
    expect(await viewOwnedVault(ctxFor(ALICE_DID).ctx, "vaults:b" as never)).toBeNull();
    expect(await viewOwnedPrediction(ctxFor(ALICE_DID).ctx, "predictions:b" as never)).toBeNull();
  });
});

describe("ownedStrategyBySubject (internal queries acting for an authenticated action)", () => {
  it("returns the strategy and user only for the owning DID", async () => {
    const { ctx } = ctxFor(null);
    const mine = await ownedStrategyBySubject(ctx.db, ALICE_DID, "strategies:a" as never);
    expect(mine?.user._id).toBe("users:alice");
    expect(await ownedStrategyBySubject(ctx.db, ALICE_DID, "strategies:b" as never)).toBeNull();
    expect(await ownedStrategyBySubject(ctx.db, "did:privy:stranger", "strategies:a" as never)).toBeNull();
    expect(await ownedStrategyBySubject(ctx.db, "", "strategies:a" as never)).toBeNull();
  });
});

describe("users.createUser / users.me", () => {
  const fields = { name: "A", username: "a", experience: "novice" };
  const run = (subject: string | null, args: Record<string, unknown>, tables = seed()) => {
    const { ctx, fake } = ctxFor(subject, tables);
    const handler = (createUser as unknown as { _handler: (c: unknown, a: unknown) => Promise<unknown> })._handler;
    return { fake, result: handler(ctx, args) };
  };

  it("needs a token", async () => {
    const { result } = run(null, { ...fields });
    expect((await errorOf(result)).code).toBe("unauthenticated");
  });

  it("binds a new row to the token's subject, even with no privyId sent", async () => {
    const { fake, result } = run("did:privy:carol", { ...fields });
    await result;
    expect(fake.inserted).toHaveLength(1);
    expect(fake.inserted[0]?.doc.privyId).toBe("did:privy:carol");
  });

  it("refuses a privyId that is not the token's subject, and writes nothing", async () => {
    const { fake, result } = run("did:privy:carol", { ...fields, privyId: ALICE_DID });
    expect((await errorOf(result)).code).toBe("unauthenticated");
    expect(fake.inserted).toHaveLength(0);
    expect(fake.patched).toHaveLength(0);
  });

  it("cannot overwrite another user's row by claiming their id", async () => {
    const { fake, result } = run(BOB_DID, { ...fields, privyId: ALICE_DID });
    await expect(result).rejects.toBeInstanceOf(ConvexError);
    expect(fake.patched).toHaveLength(0);
  });

  it("updates the caller's own row when it exists", async () => {
    const { fake, result } = run(ALICE_DID, { ...fields, privyId: ALICE_DID });
    await result;
    expect(fake.patched.map((p) => p.id)).toEqual(["users:alice"]);
    expect(fake.inserted).toHaveLength(0);
  });

  it("me returns only the caller's own row", async () => {
    const handler = (me as unknown as { _handler: (c: unknown, a: unknown) => Promise<{ _id: string } | null> })._handler;
    expect((await handler(ctxFor(ALICE_DID).ctx, {}))?._id).toBe("users:alice");
    expect(await handler(ctxFor(null).ctx, {})).toBeNull();
  });
});
