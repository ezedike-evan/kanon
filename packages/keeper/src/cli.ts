/**
 * Keeper entry point.
 *
 *   pnpm --filter @kanon/keeper keep:dry      one pass, read-only
 *   pnpm --filter @kanon/keeper keep          one pass; sends only if
 *                                             KEEPER_BROADCAST=true
 *   ... keep -- --watch [--interval 15]       repeat forever
 *
 * `--dry-run` always wins over the env flag. Logs are one JSON object per line
 * on stdout; the final line of a one-shot run is the full pass report.
 */

import { ConfigError, loadConfig } from './config';
import { ChainMismatchError, createKeeper, passOk } from './keeper';
import { createJsonLogger } from './log';
import { createLogSource } from './source';
import { createViemPort } from './viem-port';

function parseArgs(argv: string[]) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const at = argv.indexOf('--interval');
  const interval = at === -1 ? 15 : Number(argv[at + 1]);
  if (!Number.isInteger(interval) || interval < 1) throw new Error('--interval needs a positive integer of seconds');
  return { dryRun: flags.has('--dry-run'), watch: flags.has('--watch'), interval };
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

  const log = createJsonLogger();
  log({
    level: 'info',
    event: 'start',
    mode: cfg.broadcast ? 'broadcast' : 'dry-run',
    chainId: cfg.chainId,
    margin: cfg.marginAddress,
    watch: args.watch,
  });

  const port = createViemPort(cfg);
  const source = createLogSource({
    marginAddress: cfg.marginAddress,
    startBlock: cfg.startBlock,
    rangeBlocks: cfg.logRangeBlocks,
    reorgDepth: cfg.reorgDepthBlocks,
  });
  const keeper = createKeeper(cfg, { port, source, log });

  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stop = true));

  let ok = true;
  do {
    try {
      const report = await keeper.runPass();
      log({ level: 'info', event: 'report', report });
      ok = passOk(report);
    } catch (e) {
      if (e instanceof ChainMismatchError) {
        // Wrong chain is a misconfiguration, not an outage: never retry it.
        log({ level: 'error', event: 'fatal', error: e.message });
        process.exit(1);
      }
      log({ level: 'error', event: 'pass_failed', error: e instanceof Error ? e.message : String(e) });
      ok = false;
    }
    if (args.watch && !stop) await new Promise((r) => setTimeout(r, args.interval * 1000));
  } while (args.watch && !stop);

  process.exit(ok ? 0 : 1);
}

void main();
