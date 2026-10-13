/**
 * HTTP routes, served at this deployment's `.convex.site` address.
 *
 * `/venue/*` is what the gateway calls around an order on the venue. The
 * gateway sends the order; this backend cannot, because the venue's trading
 * API answers HTTP 451 from the region Convex runs in. What it keeps is the
 * part that must not live in a process a client talks to directly:
 *
 *   POST /venue/admit   may this caller read the trading account now?
 *   POST /venue/begin   may this caller send an order now? If so the row is
 *                       written and the one-order-at-a-time lock is taken.
 *   POST /venue/settle  what became of that order. Releases the lock.
 *   POST /venue/amend   a fill's price, fee and transaction, once the venue lists them.
 *
 * `/timed/*` is the same arrangement for Predict's timed trades: the gateway
 * opens a position when somebody calls a direction and closes it when the time
 * is up, and this backend keeps whose trade it is and what became of it.
 *
 *   POST /timed/start        a trade has opened: write its row (caller's token)
 *   POST /timed/begin-close  the lock and the order row for its closing order
 *   POST /timed/update       how it ended, and the figures that follow
 *   POST /timed/running      every trade that has not ended (read on gateway start)
 *   POST /timed/owns         is this running trade the caller's? (caller's token)
 *
 * The closing order is sent by the gateway when the time is up, so
 * `begin-close` is vouched for by the trade's id and the recorder key, not by a
 * sign-in token: the person may have left by then.
 *
 * `/autopilot/*` is how a proposal the rule passed with nobody there becomes a
 * timed trade (`autopilot.ts`). Nobody signs in for one, so none of these takes
 * a token: the proposal vouches for its owner, as a timed trade does for the
 * owner of its closing order. The gateway asks what is waiting, opens each
 * through the same runner a person's timed trade goes through, and says what
 * became of it.
 *
 *   POST /autopilot/pending  the proposals not yet handed to the venue, and the trade each asks for
 *   POST /autopilot/begin    the lock and the order row for a proposal's own order
 *   POST /autopilot/start    a trade has opened for a proposal: write its row
 *   POST /autopilot/report   what became of a proposal. After it, the proposal is finished.
 *
 * Anyone on the internet can reach these addresses, so each is held by two
 * things. `X-Kanon-Recorder` must carry `VENUE_RECORDER_KEY`, which only the
 * gateway has: without it a signed-in user could write fills into their own
 * order list or hold the lock against everybody. And `admit` and `begin` need
 * the caller's own Privy token in `Authorization`, which Convex verifies: who
 * the order is for comes from that token, never from the body. `settle` and
 * `amend` name a row by the id `begin` returned and need only the key, so a
 * token that lapsed mid-order does not leave an order unrecorded.
 */

import { httpRouter, makeFunctionReference } from "convex/server";
import { httpAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { Decimal } from "@kanon/spec";
import { requireSubject, type AuthCtx } from "./authz";
import {
  BeginBody as AutopilotBeginBody,
  ReportBody as AutopilotReportBody,
  StartBody as AutopilotStartBody,
} from "./autopilotLogic";
import { checkRateLimit } from "./rateLimit";
import { describeEnvProblem, parseVenueRecorderEnv } from "./serverEnv";
import { BeginCloseBody, OwnsBody, StartBody, UpdateBody } from "./timedLogic";
import { AmendBody, BeginBody, RECORDER_HEADER, SettleBody, recorderKeyMatches } from "./venueLogic";

type Side = "long" | "short";

const beginRef = makeFunctionReference<
  "mutation",
  {
    subject: string;
    network: "testnet" | "mainnet";
    asset: string;
    action: "open" | "close";
    side?: Side;
    notionalUsd?: number;
    leverage?: number;
  },
  { ok: true; orderId: Id<"venueOrders"> } | { ok: false; code: "no_user" | "busy" }
>("venueData:begin");

const settleRef = makeFunctionReference<
  "mutation",
  {
    orderId: Id<"venueOrders">;
    status: "filled" | "unfilled" | "refused" | "failed";
    side?: Side;
    requestId?: number;
    size?: Decimal;
    fillPrice?: Decimal;
    fee?: Decimal;
    block?: number;
    txHash?: string;
    reason?: string;
  },
  null
>("venueData:settle");

const amendRef = makeFunctionReference<
  "mutation",
  { orderId: Id<"venueOrders">; size?: Decimal; fillPrice?: Decimal; fee?: Decimal; block?: number; txHash?: string },
  null
>("venueData:amend");

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Null when the caller holds the recorder key. Otherwise the answer to send. Logs variable names, never values. */
function gate(request: Request, scope: string): Response | null {
  const env = parseVenueRecorderEnv(process.env);
  if (!env.ok) {
    console.error(describeEnvProblem(scope, env.invalid));
    return json(503, { ok: false, code: "not_configured" });
  }
  if (!recorderKeyMatches(request.headers.get(RECORDER_HEADER), env.value.key)) {
    return json(403, { ok: false, code: "forbidden" });
  }
  return null;
}

/** The token's Privy DID, or null with no valid token. */
async function subjectOf(ctx: AuthCtx): Promise<string | null> {
  try {
    return await requireSubject(ctx);
  } catch {
    return null;
  }
}

async function bodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

const admit = httpAction(async (ctx, request) => {
  const refused = gate(request, "venue.admit");
  if (refused) return refused;
  const subject = await subjectOf(ctx);
  if (!subject) return json(401, { ok: false, code: "unauthenticated" });
  const limited = await checkRateLimit(ctx, subject, "venueAccount");
  if (limited) return json(200, { ok: false, code: "rate_limited", retryAfterMs: limited.retryAfterMs, message: limited.message });
  return json(200, { ok: true });
});

const begin = httpAction(async (ctx, request) => {
  const refused = gate(request, "venue.begin");
  if (refused) return refused;
  const subject = await subjectOf(ctx);
  if (!subject) return json(401, { ok: false, code: "unauthenticated" });
  const body = BeginBody.safeParse(await bodyOf(request));
  if (!body.success) return json(400, { ok: false, code: "bad_request" });
  const limited = await checkRateLimit(ctx, subject, "venueOrder");
  if (limited) return json(200, { ok: false, code: "rate_limited", retryAfterMs: limited.retryAfterMs, message: limited.message });

  const { network, asset, action, side, notionalUsd, leverage } = body.data;
  const begun = await ctx.runMutation(beginRef, {
    subject,
    network,
    asset,
    action,
    ...(side !== undefined ? { side } : {}),
    ...(notionalUsd !== undefined ? { notionalUsd } : {}),
    ...(leverage !== undefined ? { leverage } : {}),
  });
  return json(200, begun);
});

const settle = httpAction(async (ctx, request) => {
  const refused = gate(request, "venue.settle");
  if (refused) return refused;
  const body = SettleBody.safeParse(await bodyOf(request));
  if (!body.success) return json(400, { ok: false, code: "bad_request" });

  const { orderId, status, side, requestId, size, fillPrice, fee, block, txHash, reason } = body.data;
  try {
    await ctx.runMutation(settleRef, {
      // Checked as an id of this table by the mutation's own validator.
      orderId: orderId as Id<"venueOrders">,
      status,
      ...(side !== undefined ? { side } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(fillPrice !== undefined ? { fillPrice } : {}),
      ...(fee !== undefined ? { fee } : {}),
      ...(block !== undefined ? { block } : {}),
      ...(txHash !== undefined ? { txHash } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  } catch (err) {
    console.error("venue.settle: the outcome could not be written", err);
    return json(500, { ok: false, code: "failed" });
  }
  return json(200, { ok: true });
});

const amend = httpAction(async (ctx, request) => {
  const refused = gate(request, "venue.amend");
  if (refused) return refused;
  const body = AmendBody.safeParse(await bodyOf(request));
  if (!body.success) return json(400, { ok: false, code: "bad_request" });

  const { orderId, size, fillPrice, fee, block, txHash } = body.data;
  try {
    await ctx.runMutation(amendRef, {
      orderId: orderId as Id<"venueOrders">,
      ...(size !== undefined ? { size } : {}),
      ...(fillPrice !== undefined ? { fillPrice } : {}),
      ...(fee !== undefined ? { fee } : {}),
      ...(block !== undefined ? { block } : {}),
      ...(txHash !== undefined ? { txHash } : {}),
    });
  } catch (err) {
    console.error("venue.amend: the fill's figures could not be written", err);
    return json(500, { ok: false, code: "failed" });
  }
  return json(200, { ok: true });
});

// ---------------------------------------------------------------------------
// Timed trades
// ---------------------------------------------------------------------------

const timedStartRef = makeFunctionReference<
  "mutation",
  StartBody & { subject: string },
  { ok: true; tradeId: string } | { ok: false; code: "no_user" }
>("timedData:start");

const timedBeginCloseRef = makeFunctionReference<
  "mutation",
  { tradeId: Id<"timedTrades">; network: "testnet" | "mainnet"; asset: string },
  { ok: true; orderId: string } | { ok: false; code: "no_user" | "busy" }
>("timedData:beginClose");

const timedUpdateRef = makeFunctionReference<"mutation", Omit<UpdateBody, "tradeId"> & { tradeId: Id<"timedTrades"> }, null>(
  "timedData:update",
);

const timedRunningRef = makeFunctionReference<"query", Record<string, never>, unknown[]>("timedData:running");

const timedOwnsRef = makeFunctionReference<"query", { subject: string; tradeId: Id<"timedTrades"> }, boolean>(
  "timedData:owns",
);

/** A body as the mutation takes it: every field the gateway left out is left out, not passed as undefined. */
function present<T extends Record<string, unknown>>(body: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

const timedStart = httpAction(async (ctx, request) => {
  const refused = gate(request, "timed.start");
  if (refused) return refused;
  const subject = await subjectOf(ctx);
  if (!subject) return json(401, { ok: false, code: "unauthenticated" });
  const body = StartBody.safeParse(await bodyOf(request));
  if (!body.success) return json(400, { ok: false, code: "bad_request" });
  return json(200, await ctx.runMutation(timedStartRef, { subject, ...present(body.data) }));
});

const timedBeginClose = httpAction(async (ctx, request) => {
  const refused = gate(request, "timed.beginClose");
  if (refused) return refused;
  const body = BeginCloseBody.safeParse(await bodyOf(request));
  if (!body.success) return json(400, { ok: false, code: "bad_request" });
  try {
    const { tradeId, network, asset } = body.data;
    return json(200, await ctx.runMutation(timedBeginCloseRef, { tradeId: tradeId as Id<"timedTrades">, network, asset }));
  } catch (err) {
    console.error("timed.beginClose: the closing order could not be recorded", err);
    return json(500, { ok: false, code: "failed" });
  }
});

const timedUpdate = httpAction(async (ctx, request) => {
  const refused = gate(request, "timed.update");
  if (refused) return refused;
  const body = UpdateBody.safeParse(await bodyOf(request));
  if (!body.success) return json(400, { ok: false, code: "bad_request" });
  try {
    const { tradeId, ...rest } = present(body.data);
    await ctx.runMutation(timedUpdateRef, { tradeId: tradeId as Id<"timedTrades">, ...rest });
  } catch (err) {
    console.error("timed.update: the trade could not be written", err);
    return json(500, { ok: false, code: "failed" });
  }
  return json(200, { ok: true });
});

const timedRunning = httpAction(async (ctx, request) => {
  const refused = gate(request, "timed.running");
  if (refused) return refused;
  return json(200, { ok: true, trades: await ctx.runQuery(timedRunningRef, {}) });
});

const timedOwns = httpAction(async (ctx, request) => {
  const refused = gate(request, "timed.owns");
  if (refused) return refused;
  const subject = await subjectOf(ctx);
  if (!subject) return json(401, { ok: false, code: "unauthenticated" });
  const body = OwnsBody.safeParse(await bodyOf(request));
  if (!body.success) return json(400, { ok: false, code: "bad_request" });
  try {
    const owns = await ctx.runQuery(timedOwnsRef, { subject, tradeId: body.data.tradeId as Id<"timedTrades"> });
    return json(200, { ok: true, owns });
  } catch {
    // An id that is not a trade's is nobody's trade.
    return json(200, { ok: true, owns: false });
  }
});

// ---------------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------------

const autopilotPendingRef = makeFunctionReference<"query", { nowMs: number }, unknown[]>("autopilotData:pending");

const autopilotBeginRef = makeFunctionReference<
  "mutation",
  Omit<AutopilotBeginBody, "proposalId"> & { proposalId: Id<"trades"> },
  { ok: true; orderId: string } | { ok: false; code: "not_pending" | "no_user" | "busy" }
>("autopilotData:begin");

const autopilotStartRef = makeFunctionReference<
  "mutation",
  Omit<AutopilotStartBody, "proposalId"> & { proposalId: Id<"trades"> },
  { ok: true; tradeId: string } | { ok: false; code: "not_pending" | "no_user" }
>("autopilotData:start");

const autopilotReportRef = makeFunctionReference<
  "mutation",
  { proposalId: Id<"trades">; outcome: "opened" | "not_opened"; timedTradeId?: Id<"timedTrades">; reason?: string },
  { ok: true } | { ok: false; code: "not_found" }
>("autopilotData:report");

const autopilotPending = httpAction(async (ctx, request) => {
  const refused = gate(request, "autopilot.pending");
  if (refused) return refused;
  return json(200, { ok: true, proposals: await ctx.runQuery(autopilotPendingRef, { nowMs: Date.now() }) });
});

const autopilotBegin = httpAction(async (ctx, request) => {
  const refused = gate(request, "autopilot.begin");
  if (refused) return refused;
  const body = AutopilotBeginBody.safeParse(await bodyOf(request));
  if (!body.success) return json(400, { ok: false, code: "bad_request" });
  try {
    const { proposalId, ...order } = present(body.data);
    // Checked as an id of this table by the mutation's own validator.
    return json(200, await ctx.runMutation(autopilotBeginRef, { proposalId: proposalId as Id<"trades">, ...order }));
  } catch (err) {
    console.error("autopilot.begin: the order could not be recorded", err);
    return json(500, { ok: false, code: "failed" });
  }
});

const autopilotStart = httpAction(async (ctx, request) => {
  const refused = gate(request, "autopilot.start");
  if (refused) return refused;
  const body = AutopilotStartBody.safeParse(await bodyOf(request));
  if (!body.success) return json(400, { ok: false, code: "bad_request" });
  try {
    const { proposalId, ...trade } = present(body.data);
    return json(200, await ctx.runMutation(autopilotStartRef, { proposalId: proposalId as Id<"trades">, ...trade }));
  } catch (err) {
    console.error("autopilot.start: the trade could not be written", err);
    return json(500, { ok: false, code: "failed" });
  }
});

const autopilotReport = httpAction(async (ctx, request) => {
  const refused = gate(request, "autopilot.report");
  if (refused) return refused;
  const body = AutopilotReportBody.safeParse(await bodyOf(request));
  if (!body.success) return json(400, { ok: false, code: "bad_request" });
  try {
    const proposalId = body.data.proposalId as Id<"trades">;
    const said =
      body.data.outcome === "opened"
        ? { proposalId, outcome: body.data.outcome, timedTradeId: body.data.timedTradeId as Id<"timedTrades"> }
        : { proposalId, outcome: body.data.outcome, reason: body.data.reason };
    return json(200, await ctx.runMutation(autopilotReportRef, said));
  } catch (err) {
    console.error("autopilot.report: the outcome could not be written", err);
    return json(500, { ok: false, code: "failed" });
  }
});

const http = httpRouter();
http.route({ path: "/venue/admit", method: "POST", handler: admit });
http.route({ path: "/venue/begin", method: "POST", handler: begin });
http.route({ path: "/venue/settle", method: "POST", handler: settle });
http.route({ path: "/venue/amend", method: "POST", handler: amend });
http.route({ path: "/timed/start", method: "POST", handler: timedStart });
http.route({ path: "/timed/begin-close", method: "POST", handler: timedBeginClose });
http.route({ path: "/timed/update", method: "POST", handler: timedUpdate });
http.route({ path: "/timed/running", method: "POST", handler: timedRunning });
http.route({ path: "/timed/owns", method: "POST", handler: timedOwns });
http.route({ path: "/autopilot/pending", method: "POST", handler: autopilotPending });
http.route({ path: "/autopilot/begin", method: "POST", handler: autopilotBegin });
http.route({ path: "/autopilot/start", method: "POST", handler: autopilotStart });
http.route({ path: "/autopilot/report", method: "POST", handler: autopilotReport });

export default http;
