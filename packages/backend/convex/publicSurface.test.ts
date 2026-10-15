import { readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The guard on the public surface.
 *
 * Every function a client can call (`query`, `mutation`, `action`; the `internal*`
 * builders are not reachable from a client) is loaded and inspected at runtime:
 *
 *  1. It must not declare an argument that names a user, an owner or a
 *     follower. Identity comes from the Privy token (`authz.ts`); an id the
 *     client supplies is an id an attacker supplies.
 *  2. It must actually consult identity: its handler has to call into
 *     `authz.ts`, unless it is listed in PUBLIC_BY_DESIGN with the reason.
 *
 * Adding a function that fails either check fails this test. To make an
 * exception, add it to the matching allowlist below *with the reason*, and
 * expect that reason to be read in review.
 */

/** Argument names that carry client-asserted identity. */
const FORBIDDEN_ARGS = ["ownerUserId", "userId", "followerUserId", "privyId"] as const;

/** `module:function` -> arg -> why it may exist. */
const ARG_ALLOWLIST: Record<string, Record<string, string>> = {
  "users:createUser": {
    privyId:
      "Optional sanity check only. The handler binds the row to the token's subject and refuses any value that differs (bindPrivyId).",
  },
};

/** Public functions that read nothing per-user, and why. `module:function` -> reason. */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  "series:getSeries": "Canonical Pyth tick candles. Market data, nothing per-user.",
  "series:getTicker": "One pair's newest Pyth print and 24-hour move. Market data, nothing per-user.",
  "series:listTickers": "Every tradeable pair's newest Pyth print and 24-hour move. Market data, nothing per-user.",
  "markets:list": "The predict feed: open and settled threshold markets plus latest prints. Market data, nothing per-user.",
  "strategies:coolingOffSeconds": "A protocol constant.",
  "homeFeed:sparkline": "One pair's last day as a line, from Pyth ticks. Market data, nothing per-user.",
  "homeFeed:leadSummaries":
    "Home's copy carousel: listed strategies with counts only. Listing is the owner's opt-in; rows carry no user ids.",
  "copyRelationships:listLeads":
    "The copy marketplace. A strategy appears only after its owner lists it (opt-in); rows carry no user ids.",
  "keeperData:publicStatus":
    "The keeper's health: its signer's public address and balance, spend against its cap, the pairs it samples. Chain-public facts; no key, no URL, nothing per-user.",
};

/** Files under convex/ that hold no client-callable functions, or are not function modules. */
const SKIP = new Set(["schema.ts", "crons.ts", "auth.config.ts"]);

const modules = readdirSync(__dirname)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && !SKIP.has(f))
  .map((f) => f.slice(0, -3))
  .sort();

interface Registered {
  isPublic?: boolean;
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  exportArgs?: () => string;
  _handler?: (...a: unknown[]) => unknown;
}

const isRegistered = (x: unknown): x is Registered =>
  typeof x === "function" && ("isQuery" in x || "isMutation" in x || "isAction" in x);

type PublicFn = { name: string; fn: Registered; args: string[] };
let cache: PublicFn[] | undefined;

/** Loaded once: importing every module cold (openai, @kanon/spec) is slow. */
async function publicFunctions(): Promise<PublicFn[]> {
  if (cache) return cache;
  const out: PublicFn[] = [];
  for (const mod of modules) {
    const exports = (await import(/* @vite-ignore */ `./${mod}.ts`)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(exports)) {
      if (!isRegistered(value) || value.isPublic !== true) continue;
      const argsJson = JSON.parse(value.exportArgs?.() ?? '{"type":"object","value":{}}') as {
        value?: Record<string, unknown>;
      };
      out.push({ name: `${mod}:${key}`, fn: value, args: Object.keys(argsJson.value ?? {}) });
    }
  }
  cache = out;
  return out;
}

describe("public Convex surface", () => {
  beforeAll(async () => {
    await publicFunctions();
  }, 60_000);

  it("finds the functions (guards the scan itself)", async () => {
    const names = (await publicFunctions()).map((f) => f.name);
    for (const expected of [
      "strategies:saveDraft",
      "strategies:pinStrategy",
      "strategies:setAutopilot",
      "trades:undoTrade",
      "vaults:recordVault",
      "copyRelationships:recordFollow",
      "predictions:recordPosition",
      "analytics:report",
      "compiler:compileStrategy",
      "proposer:runProposer",
      "users:createUser",
      "users:me",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("no public function takes a client-supplied user, owner or follower id", async () => {
    const offenders: string[] = [];
    for (const { name, args } of await publicFunctions()) {
      for (const arg of args) {
        if (!(FORBIDDEN_ARGS as readonly string[]).includes(arg)) continue;
        if (ARG_ALLOWLIST[name]?.[arg]) continue;
        offenders.push(`${name} declares \`${arg}\``);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlisted arg still exists (no stale exceptions)", async () => {
    const fns = new Map((await publicFunctions()).map((f) => [f.name, f.args]));
    for (const [name, byArg] of Object.entries(ARG_ALLOWLIST)) {
      for (const arg of Object.keys(byArg)) {
        expect(fns.get(name) ?? [], `${name} no longer declares ${arg}; drop the exception`).toContain(arg);
      }
    }
  });

  it("every public function consults identity, or is public by design with a reason", async () => {
    const unguarded: string[] = [];
    for (const { name, fn } of await publicFunctions()) {
      const source = String(fn._handler ?? "");
      const consultsIdentity = /\b(requireUser|requireSubject|viewerUser|requireOwned\w+|viewOwned\w+)\b/.test(source);
      if (!consultsIdentity && !PUBLIC_BY_DESIGN[name]) unguarded.push(name);
    }
    expect(unguarded).toEqual([]);
  });

  it("every public-by-design entry still exists and is still public (no stale exceptions)", async () => {
    const names = new Set((await publicFunctions()).map((f) => f.name));
    for (const name of Object.keys(PUBLIC_BY_DESIGN)) expect(names.has(name), `${name} is gone or internal now`).toBe(true);
  });

  it("the sweeps, ingestion, cache writes and settlement are not public", async () => {
    const names = new Set((await publicFunctions()).map((f) => f.name));
    for (const internal of [
      "ticks:ingest",
      "ticks:recordTicks",
      "markets:sweep",
      "markets:sweepSnapshot",
      "markets:markChecked",
      "markets:openMarkets",
      "markets:markCrossed",
      "markets:recordSettlement",
      "markets:settlePositions",
      "nansen:readCache",
      "nansen:writeCache",
      "predictions:settlePrediction",
      "trades:recordEvaluation",
      "trades:finalizeTrade",
      "accounts:createAccount",
      "accounts:updateAccountLedger",
      "positions:createPosition",
      // Autopilot acts for a strategy's owner with nobody signed in. None of it is a client's to call.
      "autopilot:sweep",
      "autopilotData:snapshot",
      "autopilotData:context",
      "autopilotData:arm",
      "autopilotData:expire",
      "autopilotData:pending",
      "autopilotData:begin",
      "autopilotData:start",
      "autopilotData:report",
      // The keeper signs with the deployment's own key. Only its health is public.
      "keeper:tick",
      "keeperData:state",
      "keeperData:status",
      "keeperData:acquire",
      "keeperData:release",
      "keeperData:noteTick",
      "keeperData:recomputeFeeds",
    ]) {
      expect(names.has(internal), `${internal} must be internal`).toBe(false);
    }
  });
});
