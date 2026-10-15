/**
 * Gateway entry point.
 *
 *   pnpm --filter @kanon/gateway start
 *
 * Configuration is read from the environment; see `config.ts`. A `.env.local`
 * beside this package's `package.json` is read first if there is one (it is
 * gitignored, and is where the trading key goes on a developer's machine); a
 * variable already set in the environment wins over it. Logs are one JSON
 * object per line. `GET /healthz` answers 200 while the venue connection is
 * open and has been heard from recently, 503 otherwise.
 */

import { setDefaultResultOrder } from 'node:dns';
import { existsSync } from 'node:fs';
import { setDefaultAutoSelectFamily } from 'node:net';
import { createKuruBookReader, kuruMarketView, readKuruListing } from '@kanon/execution/kuru-market-view';
import { ConfigError, loadConfig } from './config';
import { createKuruMarketRoute } from './kuru-market';
import { createJsonLogger } from './log';
import { createGateway } from './server';
import { connectTrade, type TradeRoutes } from './trade';

async function main() {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
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
  let trade: TradeRoutes | undefined;
  if (config.trade) {
    try {
      trade = await connectTrade(config.trade, log);
    } catch (e) {
      // Names the problem with the secret, never any part of it.
      console.error(`PERPL_API_KEY_SECRET: ${e instanceof Error ? e.message : 'could not be read'}`);
      process.exit(2);
    }
  }
  // The spot market Kanon listed on Kuru's testnet, read-only. It is served whatever network the
  // perps are on: the listing record says which chain it is, and no key is involved.
  const listing = readKuruListing();
  const readBook = listing ? createKuruBookReader({ listing }) : null;
  const kuru = createKuruMarketRoute({
    read: listing && readBook ? async () => kuruMarketView(listing, await readBook(), Date.now()) : null,
    log,
  });
  const gateway = createGateway({ config, log, kuru, ...(trade ? { trade } : {}) });
  const port = await gateway.listen();
  log({
    level: 'info',
    event: 'listening',
    port,
    network: config.network,
    origins: config.allowedOrigins,
    warm: config.warmStreams,
    // The network orders go to, or `off`. Never the key.
    trade: config.trade ? config.trade.network : 'off',
    kuru: listing ? listing.asset : 'not listed',
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
