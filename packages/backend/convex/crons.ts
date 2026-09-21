import { cronJobs, makeFunctionReference } from "convex/server";

// Referenced by name: `_generated/api.d.ts` is stale until `npx convex dev`
// regenerates it, and `internal.ticks.ingest` would not type-check before then.
const ingestTicks = makeFunctionReference<"action", Record<string, never>>("ticks:ingest");

const crons = cronJobs();

// One tick per asset per minute is the canonical series' resolution.
crons.interval("ingest pyth ticks", { minutes: 1 }, ingestTicks, {});

// Predict markets: settle what has ended, open what is missing, from the ticks above.
const sweepMarkets = makeFunctionReference<"action", Record<string, never>>("markets:sweep");
crons.interval("sweep predict markets", { minutes: 1 }, sweepMarkets, {});

export default crons;
