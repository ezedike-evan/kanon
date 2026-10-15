import { internalAction } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import { AUTOPILOT_JUDGE_WINDOW_SECONDS } from "./autopilotLogic";
import { runAutopilotPass, type AutopilotPassReport } from "./autopilot";
import { createPythSource, createViemGatePort } from "./gatePort";
import { GATE_BUCKET_SECONDS } from "./gateLogic";
import { failedTick, runKeeperTick, sentence, spentToday, tickNote, type KeeperTickReport, type TickNote } from "./keeperLogic";
import { describeEnvProblem, parseGateEnv, parseKeeperSwitch, parseSignerEnv } from "./serverEnv";

/**
 * The keeper's tick, once a minute (`crons.ts`). It keeps the on-chain series
 * of every pair a pinned rule uses sampled once per 15-minute bucket; what it
 * does and in what order is `runKeeperTick` (`keeperLogic.ts`). Then, once per
 * bucket and inside its first five minutes, it hands the bucket to autopilot
 * (`autopilot.ts`), which judges each rule it is on for on the gate.
 *
 * Off unless `KEEPER_ENABLED=on`, so deploying this spends nothing. Switched
 * on, a minute with every in-use series already sampled reads one small row
 * and writes nothing. A misconfigured deployment logs the variables at fault
 * by name, and sends nothing.
 *
 * Functions are referenced by name because `_generated/api.d.ts` is stale until
 * `npx convex dev` regenerates it (see convex/README.md).
 */

const stateRef = makeFunctionReference<"query", Record<string, never>, Doc<"keeper"> | null>("keeperData:state");
const acquireRef = makeFunctionReference<"mutation", { holder: string }, { ok: boolean; leaseUntil: number }>(
  "keeperData:acquire",
);
const releaseRef = makeFunctionReference<"mutation", { holder: string; spentWei: string }, null>("keeperData:release");
const noteTickRef = makeFunctionReference<"mutation", TickNote, null>("keeperData:noteTick");
const noteJudgedRef = makeFunctionReference<"mutation", { bucket: number }, null>("keeperData:noteJudged");

export interface KeeperTickOutcome {
  status: "off" | "not_configured" | "idle" | "ran" | "busy" | "paused" | "failed";
  bucket?: number | null;
  sampled?: Array<{ feed: string; bucket: number }>;
  sent?: Array<{ feed: string; call: string; hash: string; costWei: string }>;
  paused?: string | null;
  errors?: string[];
  /** Present on the tick that handed a bucket to autopilot. */
  autopilot?: AutopilotPassReport;
}

/**
 * Whether this tick hands its bucket to autopilot: the bucket was read and
 * nothing is paused, the bucket is in its first five minutes, and it has not
 * been judged clean already.
 */
export function autopilotDue(report: Pick<KeeperTickReport, "bucket" | "blockTime" | "paused">, judgedBucket: number | undefined): boolean {
  if (report.bucket === null || report.blockTime === undefined || report.paused) return false;
  if (report.blockTime % GATE_BUCKET_SECONDS >= AUTOPILOT_JUDGE_WINDOW_SECONDS) return false;
  return judgedBucket === undefined || judgedBucket < report.bucket;
}

export const tick = internalAction({
  args: {},
  handler: async (ctx): Promise<KeeperTickOutcome> => {
    const on = parseKeeperSwitch(process.env);
    if (!on.ok) {
      console.error(describeEnvProblem("keeper:tick", on.invalid));
      return { status: "not_configured" };
    }
    if (!on.value) return { status: "off" };
    const signer = parseSignerEnv(process.env);
    const gate = parseGateEnv(process.env);
    if (!signer.ok || !gate.ok) {
      console.error(describeEnvProblem("keeper:tick", [...(signer.ok ? [] : signer.invalid), ...(gate.ok ? [] : gate.invalid)]));
      return { status: "not_configured" };
    }

    const row = await ctx.runQuery(stateRef, {});
    const feeds = row?.feeds ?? [];
    if (feeds.length === 0) return { status: "idle" };

    const { privateKey, ...limits } = signer.value;
    const secrets = [privateKey, gate.value.rpcUrl, gate.value.sourceRpcUrl];
    const port = createViemGatePort(gate.value, privateKey);
    const holder = `keeper:${crypto.randomUUID()}`;

    let report: KeeperTickReport;
    try {
      report = await runKeeperTick({
        port,
        source: createPythSource(gate.value.sourceRpcUrl),
        feeds,
        series: gate.value.series,
        mockPyth: gate.value.mockPythAddress,
        limits: { ...limits, maxGas: gate.value.keeperMaxGas, maxSourceAgeSeconds: gate.value.maxSourceAgeSeconds },
        spentTodayWei: spentToday(row, Date.now()),
        lease: {
          acquire: async () => (await ctx.runMutation(acquireRef, { holder })).ok,
          release: async (spentWei) => {
            await ctx.runMutation(releaseRef, { holder, spentWei: spentWei.toString() });
          },
        },
        log: (level, line) => console[level](line),
        secrets,
      });
    } catch (e) {
      const line = sentence(e, secrets);
      console.error(`keeper: the tick could not run: ${line}`);
      report = failedTick(line);
    }

    const note = tickNote(row, report, port.signer);
    if (note) await ctx.runMutation(noteTickRef, note);

    // Autopilot, after sampling, once per bucket: a pass that left nothing to try again is remembered.
    let autopilot: AutopilotPassReport | undefined;
    if (autopilotDue(report, row?.judgedBucket) && report.bucket !== null) {
      try {
        autopilot = await runAutopilotPass(ctx, report.bucket);
        if (autopilot.clean) await ctx.runMutation(noteJudgedRef, { bucket: report.bucket });
      } catch (e) {
        console.error(`keeper: the autopilot pass could not run: ${sentence(e, secrets)}`);
      }
    }

    return {
      status:
        report.bucket === null ? "failed" : report.paused ? "paused" : report.busy ? "busy" : "ran",
      bucket: report.bucket,
      sampled: report.sampled,
      sent: report.sent.map((s) => ({ ...s, costWei: s.costWei.toString() })),
      paused: report.paused,
      errors: report.errors,
      ...(autopilot ? { autopilot } : {}),
    };
  },
});
