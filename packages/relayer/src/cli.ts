/**
 * Relayer entry point.
 *
 *   pnpm --filter @kanon/relayer relay:dry     one pass, read-only
 *   pnpm --filter @kanon/relayer relay         one pass; sends only if
 *                                              RELAYER_BROADCAST=true
 *   ... relay -- --watch [--interval 60]       repeat forever
 *
 * `--dry-run` always wins over the env flag. Logs are one JSON object per line.
 *
 * HEALTH_PORT (optional) serves `GET /healthz`: 200 while a pass has succeeded
 * within three intervals, 503 once it has not.
 */

import { CliArgError, parseHealthPort, parseIntervalArg } from './cli-args';
import { ConfigError, loadConfig } from './config';
import { createHealth, startHealthServer } from './health';
import { withTimeout } from './http';
import { createJsonLogger } from './log';
import { createViemPort } from './viem-port';
import { relayOnce, reportOk } from './relay';

const HERMES_TIMEOUT_MS = 15_000;
/** A watching relayer that fails this many passes in a row exits non-zero so its supervisor alerts. */
const MAX_CONSECUTIVE_FAILURES = 5;

function parseArgs(argv: string[]) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const interval = parseIntervalArg(argv, 60);
  return { dryRun: flags.has('--dry-run'), watch: flags.has('--watch'), interval };
}

async function main() {
  let args;
  let healthPort;
  let cfg;
  try {
    args = parseArgs(process.argv.slice(2));
    healthPort = parseHealthPort(process.env.HEALTH_PORT);
    cfg = loadConfig(process.env, { dryRun: args.dryRun });
  } catch (e) {
    if (e instanceof ConfigError || e instanceof CliArgError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }

  const log = createJsonLogger();
  log({ level: 'info', event: 'start', mode: cfg.broadcast ? 'broadcast' : 'dry-run', chainId: cfg.chainId, watch: args.watch });
  const port = createViemPort(cfg);

  // Every Hermes request gets a hard timeout so one hung connection cannot stall the loop.
  const timedFetch = withTimeout(fetch, HERMES_TIMEOUT_MS);

  const health = createHealth(args.interval);
  if (healthPort !== undefined) {
    startHealthServer(health, healthPort);
    log({ level: 'info', event: 'health_listening', port: healthPort });
  }

  let stopping = false;
  let wake: (() => void) | undefined;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stopping = true;
      wake?.();
    });
  }

  let ok = true;
  let failures = 0;
  do {
    try {
      const report = await relayOnce(cfg, { port, fetchFn: timedFetch });
      log({ level: 'info', event: 'report', report });
      ok = reportOk(report);
    } catch (e) {
      log({ level: 'error', event: 'pass_failed', error: e instanceof Error ? e.message : String(e) });
      ok = false;
    }
    health.pass(ok);
    if (!args.watch) break;
    failures = ok ? 0 : failures + 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      log({ level: 'error', event: 'fatal', error: `${failures} failed passes in a row, exiting` });
      process.exit(1);
    }
    await new Promise<void>((r) => {
      wake = r;
      setTimeout(r, args.interval * 1000);
    });
  } while (!stopping);

  process.exit(ok ? 0 : 1);
}

void main();
