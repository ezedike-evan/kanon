/**
 * Gateway entry point.
 *
 *   pnpm --filter @kanon/gateway start
 *
 * Configuration is read from the environment; see `config.ts`. Logs are one
 * JSON object per line. `GET /healthz` answers 200 while the venue connection
 * is open and has been heard from recently, 503 otherwise.
 */

import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';
import { ConfigError, loadConfig } from './config';
import { createJsonLogger } from './log';
import { createGateway } from './server';

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  if (config.forceIpv4) {
    setDefaultResultOrder('ipv4first');
    setDefaultAutoSelectFamily(false);
  }

  const log = createJsonLogger();
  const gateway = createGateway({ config, log });
  const port = await gateway.listen();
  log({
    level: 'info',
    event: 'listening',
    port,
    network: config.network,
    origins: config.allowedOrigins,
    warm: config.warmStreams,
  });

  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      log({ level: 'info', event: 'stopping', signal });
      void gateway.close().then(() => process.exit(0));
    });
  }
}

void main();
