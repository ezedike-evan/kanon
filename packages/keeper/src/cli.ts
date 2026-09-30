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
 *
 * HEALTH_PORT (optional) serves `GET /healthz`: 200 while a pass has succeeded
 * within three intervals, 503 once it has not.
 */

import { CliArgError, parseHealthPort, parseIntervalArg } from './cli-args';
import { ConfigError, loadConfig } from './config';
import { createHealth, startHealthServer } from './health';
import { ChainMismatchError, createKeeper, passOk } from './keeper';
import { createJsonLogger } from './log';
import { createLogSource } from './source';
import { createViemPort } from './viem-port';

function parseArgs(argv: string[]) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const interval = parseIntervalArg(argv, 15);
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

  const health = createHealth(args.interval);
  if (healthPort !== undefined) {
    startHealthServer(health, healthPort);
    log({ level: 'info', event: 'health_listening', port: healthPort });
  }

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
    health.pass(ok);
    if (args.watch && !stop) await new Promise((r) => setTimeout(r, args.interval * 1000));
  } while (args.watch && !stop);

  process.exit(ok ? 0 : 1);
}

void main();
