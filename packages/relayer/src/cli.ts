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

  let ok = true;
  do {
    try {
      const report = await relayOnce(cfg, { port, fetchFn: fetch });
      print(report);
      ok = reportOk(report);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      ok = false;
    }
    if (args.watch) await new Promise((r) => setTimeout(r, args.interval * 1000));
  } while (args.watch);

  process.exit(ok ? 0 : 1);
}

void main();
