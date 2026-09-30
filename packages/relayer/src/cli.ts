/**
 * Relayer entry point.
 *
 *   pnpm --filter @kanon/relayer relay:dry     one pass, read-only
 *   pnpm --filter @kanon/relayer relay         one pass; sends only if
 *                                              RELAYER_BROADCAST=true
 *   ... relay -- --watch [--interval 60]       repeat forever
 *
 * `--dry-run` always wins over the env flag.
 */

import { ConfigError, loadConfig } from './config';
import { createViemPort } from './viem-port';
import { relayOnce, reportOk, type RelayReport } from './relay';

const HERMES_TIMEOUT_MS = 15_000;
/** A watching relayer that fails this many passes in a row exits non-zero so its supervisor alerts. */
const MAX_CONSECUTIVE_FAILURES = 5;

function parseArgs(argv: string[]) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const at = argv.indexOf('--interval');
  const interval = at === -1 ? 60 : Number(argv[at + 1]);
  if (!Number.isInteger(interval) || interval < 1) throw new Error('--interval needs a positive integer of seconds');
  return { dryRun: flags.has('--dry-run'), watch: flags.has('--watch'), interval };
}

function print(report: RelayReport) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cfg;
  try {
    cfg = loadConfig(process.env, { dryRun: args.dryRun });
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }

  console.error(cfg.broadcast ? 'relayer: BROADCAST mode, transactions will be sent' : 'relayer: dry run, nothing will be sent');
  const port = createViemPort(cfg);

  // Every Hermes request gets a hard timeout so one hung connection cannot stall the loop.
  const timedFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(HERMES_TIMEOUT_MS) });

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
      print(report);
      ok = reportOk(report);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      ok = false;
    }
    if (!args.watch) break;
    failures = ok ? 0 : failures + 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`relayer: ${failures} failed passes in a row, exiting`);
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
