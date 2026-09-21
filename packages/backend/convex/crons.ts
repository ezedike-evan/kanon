import { cronJobs, makeFunctionReference } from "convex/server";

// Referenced by name: `_generated/api.d.ts` is stale until `npx convex dev`
// regenerates it, and `internal.ticks.ingest` would not type-check before then.
const ingestTicks = makeFunctionReference<"action", Record<string, never>>("ticks:ingest");

const crons = cronJobs();

// Cadence in minutes. The production default is 1 (one tick per asset per
// minute is the canonical series' resolution). A free-tier dev deployment can
// set CRON_INTERVAL_MINUTES (e.g. 5) to cut function calls about fivefold: the
// sponsored feeds only update on-chain hourly or on a 0.02% move, so polling
// faster mostly re-reads the same price.
const minutes = Math.max(1, Math.floor(Number(process.env.CRON_INTERVAL_MINUTES ?? 1)) || 1);

crons.interval("ingest pyth ticks", { minutes }, ingestTicks, {});

// Predict markets: settle what has ended, open what is missing, from the ticks above.
const sweepMarkets = makeFunctionReference<"action", Record<string, never>>("markets:sweep");
crons.interval("sweep predict markets", { minutes }, sweepMarkets, {});

export default crons;
