import { cronJobs, makeFunctionReference } from "convex/server";

// Referenced by name: `_generated/api.d.ts` is stale until `npx convex dev`
// regenerates it, and `internal.ticks.ingest` would not type-check before then.
const ingestTicks = makeFunctionReference<"action", Record<string, never>>("ticks:ingest");

const crons = cronJobs();

// Cadence in minutes. Defaults: ingest every 2, sweep every 5. The sponsored
// Pyth feeds only update on-chain hourly or on a 0.02% move, so polling faster
// mostly re-reads the same price, and every minute of cadence is billed
// function calls. The sweep only decides on recorded ticks (publish times), so
// a slower sweep delays a settlement or a new market by at most one interval
// and never changes an outcome.
//
// CRON_INTERVAL_MINUTES, when set on the deployment, overrides BOTH (e.g. 1 for
// the old per-minute cadence, 10 for a free-tier dev deployment).
const override = Math.floor(Number(process.env.CRON_INTERVAL_MINUTES ?? 0)) || 0;
const ingestMinutes = Math.max(1, override || 2);
const sweepMinutes = Math.max(1, override || 5);

crons.interval("ingest pyth ticks", { minutes: ingestMinutes }, ingestTicks, {});

// The price-threshold markets Predict used to show: settle what has ended, open what is missing,
// from the ticks above. Predict is timed trades on the gateway now and nothing reads these, while
// the sweep was most of the deployment's database I/O. Off unless PREDICT_MARKETS_SWEEP=on.
if (process.env.PREDICT_MARKETS_SWEEP === "on") {
  const sweepMarkets = makeFunctionReference<"action", Record<string, never>>("markets:sweep");
  crons.interval("sweep predict markets", { minutes: sweepMinutes }, sweepMarkets, {});
}

// Autopilot: judge each strategy it is on for once per closed candle of its own timeframe
// (`autopilot.ts`). Every minute whatever the override above says, because the shortest candle
// a spec can be written on closes every minute. With autopilot on for nothing it is one read.
const sweepAutopilot = makeFunctionReference<"action", Record<string, never>>("autopilot:sweep");
crons.interval("sweep autopilot", { minutes: 1 }, sweepAutopilot, {});

// Retention: drop ticks past `TICK_RETENTION_DAYS` (candles are kept).
const pruneTicks = makeFunctionReference<"mutation", Record<string, never>>("ticks:pruneTicks");
crons.daily("prune old ticks", { hourUTC: 3, minuteUTC: 17 }, pruneTicks, {});

// The gateway has timed trades to close whether or not anybody is on the app, and a host may
// put an idle service to sleep. Does nothing unless GATEWAY_URL is set (`gateway.ts`).
const pingGateway = makeFunctionReference<"action", Record<string, never>>("gateway:ping");
crons.interval("keep the gateway awake", { minutes: 5 }, pingGateway, {});

export default crons;
