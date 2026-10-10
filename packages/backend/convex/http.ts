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
import { checkRateLimit } from "./rateLimit";
import { describeEnvProblem, parseVenueRecorderEnv } from "./serverEnv";
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

const http = httpRouter();
http.route({ path: "/venue/admit", method: "POST", handler: admit });
http.route({ path: "/venue/begin", method: "POST", handler: begin });
http.route({ path: "/venue/settle", method: "POST", handler: settle });
http.route({ path: "/venue/amend", method: "POST", handler: amend });

export default http;
