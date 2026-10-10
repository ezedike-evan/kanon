/**
 * One real order on Perpl, end to end: open a small long at market, wait for
 * the fill, close it, and print the transactions.
 *
 *   pnpm --filter @kanon/execution perpl:order            look only: account, price, the order it would send
 *   pnpm --filter @kanon/execution perpl:order --send     place it, then close it
 *   pnpm --filter @kanon/execution perpl:order --close    close a position an earlier run left open
 *   ... perpl:order --market ETH --usd 25 --leverage 2
 *
 * Testnet only: it refuses any other network.
 *
 * It needs an API key, and nothing else. The key is created in Perpl's own UI
 * (testnet.perpl.xyz/apikeys) by the wallet that owns the exchange account, and
 * read here from `packages/execution/.env.local` (gitignored):
 *
 *   PERPL_API_KEY=...            the token
 *   PERPL_API_KEY_SECRET=...     the Ed25519 secret: the hex or the base64url form
 *
 * No wallet key is involved. An API key cannot withdraw, whatever its scope.
 * Neither value is ever printed.
 */

import { existsSync } from 'node:fs';
import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';
import { createEd25519Signer, normalizeEd25519Secret } from './perpl-auth';
import { PERPL_FLAG, PERPL_ORDER_TYPE, PERPL_REST_BASE_URL } from './perpl-constants';
import {
  PerplRestError,
  createPerplRest,
  isOpenPosition,
  sizeForNotional,
  type PerplAccount,
  type PerplFill,
  type PerplOrderSpec,
  type PerplPosition,
  type PerplRest,
} from './perpl-rest';

const NETWORK = 'testnet' as const;
const EXPLORER_TX = 'https://testnet.monadscan.com/tx/';
const COLLATERAL_DECIMALS = 6;
const MAX_SLIPPAGE_BPS = 100;
const SETTLE_TIMEOUT_MS = 60_000;
const POLL_MS = 2_000;

const args = process.argv.slice(2).filter((a) => a !== '--');
const has = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const human = (scaled: number, decimals: number) => (scaled / 10 ** decimals).toFixed(decimals);
const usd = (atoms: string) => (Number(atoms) / 10 ** COLLATERAL_DECIMALS).toFixed(2);
const txLink = (txid: string | undefined) => (txid ? `${EXPLORER_TX}${txid.startsWith('0x') ? txid : `0x${txid}`}` : '(no transaction id reported)');

function stop(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

interface Market {
  id: number;
  symbol: string;
  priceDecimals: number;
  sizeDecimals: number;
  /** Highest leverage the market opens at, in hundredths. */
  maxLeverage: number;
}

async function loadMarket(base: string, symbol: string): Promise<Market> {
  const res = await fetch(`${base}/v1/pub/context`);
  if (!res.ok) stop(`Could not load the market list (HTTP ${res.status}).`);
  const context = (await res.json()) as {
    markets: Array<{
      id: number;
      symbol: string;
      name: string;
      config: { price_decimals: number; size_decimals: number; is_open: boolean; initial_margin: number };
    }>;
  };
  // Some markets have an empty symbol and carry it in the name ("BTC" or "BTC Perp").
  const label = (m: { symbol: string; name: string }) => (m.symbol || m.name.replace(/ Perp$/i, '')).toUpperCase();
  const market = context.markets.find((m) => label(m) === symbol.toUpperCase());
  if (!market) stop(`Perpl ${NETWORK} lists no ${symbol} market. Listed: ${context.markets.map(label).join(', ')}.`);
  if (!market.config.is_open) stop(`The ${symbol} market is not open.`);
  return {
    id: market.id,
    symbol: label(market),
    priceDecimals: market.config.price_decimals,
    sizeDecimals: market.config.size_decimals,
    maxLeverage: market.config.initial_margin,
  };
}

async function markPrice(base: string, marketId: number): Promise<number> {
  const res = await fetch(`${base}/v1/market-data/${marketId}/ticker`);
  if (!res.ok) stop(`Could not read the price (HTTP ${res.status}).`);
  const ticker = (await res.json()) as { d: Record<string, { mrk: number }> };
  const state = ticker.d[String(marketId)];
  if (!state || !(state.mrk > 0)) stop('The venue returned no mark price for this market.');
  return state.mrk;
}

async function main() {
  // This repo is developed on a link with broken IPv6; harmless elsewhere.
  if (process.env.FORCE_IPV4 === 'true') {
    setDefaultResultOrder('ipv4first');
    setDefaultAutoSelectFamily(false);
  }
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  if ((process.env.PERPL_NETWORK ?? NETWORK) !== NETWORK) stop(`This script only trades on ${NETWORK}. Unset PERPL_NETWORK.`);

  const apiKey = process.env.PERPL_API_KEY;
  const secret = process.env.PERPL_API_KEY_SECRET;
  if (!apiKey || !secret) {
    stop(
      [
        'No API key found. Create one and save it:',
        '  1. Open https://testnet.perpl.xyz with the wallet that will trade, and deposit to open an account.',
        '  2. Turn on One-Click Trading in settings.',
        '  3. Create a key with trade scope at https://testnet.perpl.xyz/apikeys.',
        '  4. Put the two values in packages/execution/.env.local as PERPL_API_KEY and PERPL_API_KEY_SECRET.',
      ].join('\n'),
    );
  }

  const send = has('send');
  const closeOnly = has('close');
  const symbol = option('market', 'BTC');
  const notional = Number(option('usd', '25'));
  const leverage = Number(option('leverage', '2'));
  if (!Number.isInteger(notional) || notional < 1) stop('--usd must be a whole number of dollars, at least 1.');
  if (!Number.isInteger(leverage) || leverage < 1) stop('--leverage must be a whole number, at least 1.');

  const base = PERPL_REST_BASE_URL[NETWORK];
  const seed = await normalizeEd25519Secret(secret).catch((e: unknown) =>
    stop(`PERPL_API_KEY_SECRET could not be read: ${e instanceof Error ? e.message : 'unknown form'}. Paste the hex or the base64url value.`),
  );
  const rest = createPerplRest({ network: NETWORK, apiKey: apiKey.trim(), signer: createEd25519Signer(seed) });
  const market = await loadMarket(base, symbol);
  if (leverage * 100 > market.maxLeverage) stop(`${market.symbol} opens at up to ${market.maxLeverage / 100}x; asked for ${leverage}x.`);

  console.log(`Perpl ${NETWORK}, ${market.symbol} perp (market ${market.id})\n`);

  let wallet;
  try {
    wallet = await rest.wallet();
  } catch (e) {
    if (e instanceof PerplRestError && e.status === 404) {
      stop('This wallet has no exchange account yet. Deposit at https://testnet.perpl.xyz to open one.');
    }
    if (e instanceof PerplRestError && (e.status === 401 || e.status === 403)) {
      stop(`Perpl refused the API key (HTTP ${e.status}). Check both values in .env.local, and that the key is not revoked.`);
    }
    throw e;
  }
  const account = wallet.as[0];
  if (!account) stop('This wallet has no exchange account yet. Deposit at https://testnet.perpl.xyz to open one.');
  console.log(`Wallet    ${wallet.addr}`);
  console.log(`Account   ${account.id}, balance ${usd(account.b)} AUSD, one-click trading ${account.fw ? 'on' : 'OFF'}`);
  if (account.fr) stop('The account is frozen.');

  const held = (await rest.positions()).find((p) => p.mkt === market.id && p.acc === account.id && isOpenPosition(p));
  if (held) {
    console.log(
      `Position  ${held.sd === 2 ? 'short' : 'long'} ${human(held.s, market.sizeDecimals)} ${market.symbol} ` +
        `at ${human(held.ep, market.priceDecimals)}, ${held.lv / 100}x, collateral ${usd(held.c)} AUSD`,
    );
  }

  if (closeOnly) {
    if (!held) {
      console.log(`\nNo open ${market.symbol} position on this account. Nothing to close.`);
      return;
    }
    if (!account.fw) stop(ONE_CLICK_OFF);
    const seen = new Set((await rest.fills(20)).map(fillKey));
    await closePosition(rest, market, held, (account.lfr ?? 0) + 1, seen);
    await reportBalance(rest, account);
    console.log(`\nDone: the ${market.symbol} position is closed.`);
    return;
  }

  const price = await markPrice(base, market.id);
  const size = sizeForNotional({
    usdNotional: notional,
    scaledPrice: price,
    priceDecimals: market.priceDecimals,
    sizeDecimals: market.sizeDecimals,
  });
  if (size < 1) stop(`$${notional} is below the smallest ${market.symbol} size at this price. Raise --usd.`);
  console.log(`Mark      ${human(price, market.priceDecimals)}`);

  const open: PerplOrderSpec = {
    rq: (account.lfr ?? 0) + 1,
    mkt: market.id,
    acc: account.id,
    t: PERPL_ORDER_TYPE.openLong,
    p: 0,
    s: size,
    ms: MAX_SLIPPAGE_BPS,
    fl: PERPL_FLAG.ioc,
    lv: leverage * 100,
    lb: 0,
  };
  console.log(
    `Order     open long ${human(size, market.sizeDecimals)} ${market.symbol} at market ` +
      `(about $${notional}), ${leverage}x, max slippage ${MAX_SLIPPAGE_BPS / 100}%`,
  );

  const ALREADY_OPEN = `There is already an open ${market.symbol} position on this account. Run again with --close to close it.`;
  if (!send) {
    console.log(held ? `\nNothing sent. ${ALREADY_OPEN}` : '\nNothing sent. Run again with --send to place it and then close it.');
    return;
  }
  if (!account.fw) stop(ONE_CLICK_OFF);
  if (held) stop(ALREADY_OPEN);

  const seenBefore = new Set((await rest.fills(20)).map(fillKey));

  console.log('\nOpening');
  await submitOne(rest, open);
  const position = await waitFor('the position to open', async () =>
    (await rest.positions()).find((p) => p.mkt === market.id && p.acc === account.id && isOpenPosition(p)),
  );
  const openFill = await newFill(rest, seenBefore, market.id);
  report('opened', position, openFill, market);
  if (openFill) seenBefore.add(fillKey(openFill));

  await closePosition(rest, market, position, open.rq + 1, seenBefore);
  await reportBalance(rest, account);
  console.log('\nDone: one order opened and closed on Perpl testnet.');
}

const ONE_CLICK_OFF =
  'One-Click Trading is off, so Perpl would refuse the order. Turn it on in settings at https://testnet.perpl.xyz.';

/** Closes the whole of `position` at market and waits until the venue no longer reports it open. */
async function closePosition(rest: PerplRest, market: Market, position: PerplPosition, rq: number, seen: Set<string>) {
  console.log('\nClosing');
  const close: PerplOrderSpec = {
    rq,
    mkt: market.id,
    acc: position.acc,
    t: position.sd === 2 ? PERPL_ORDER_TYPE.closeShort : PERPL_ORDER_TYPE.closeLong,
    p: 0,
    s: position.s,
    ms: MAX_SLIPPAGE_BPS,
    fl: PERPL_FLAG.ioc,
    lv: position.lv,
    lb: 0,
  };
  await submitOne(rest, close);
  await waitFor('the position to close', async () =>
    (await rest.positions()).some((p) => p.pid === position.pid && isOpenPosition(p)) ? undefined : true,
  );
  report('closed', null, await newFill(rest, seen, market.id), market);
}

async function reportBalance(rest: PerplRest, before: PerplAccount) {
  const after = (await rest.wallet()).as.find((a) => a.id === before.id);
  if (after) console.log(`\nBalance   ${usd(after.b)} AUSD (was ${usd(before.b)})`);
}

const fillKey = (f: PerplFill) => `${f.at.b}:${f.oid}:${f.s}:${f.t}`;

async function submitOne(rest: PerplRest, order: PerplOrderSpec) {
  const [status] = await rest.submit([order]);
  if (!status || status.code !== 0) stop(`Perpl refused the order: ${status?.error ?? 'no status returned'} (code ${status?.code ?? '?'}).`);
  console.log(`  accepted for forwarding (request ${order.rq})`);
}

/** Polls until `probe` returns something. The venue settles an accepted order a block or two later. */
async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = await probe();
    if (found !== undefined) return found;
    await sleep(POLL_MS);
  }
  return stop(
    `Timed out after ${SETTLE_TIMEOUT_MS / 1000}s waiting for ${what}. The order was accepted but did not settle as expected. ` +
      'Check the account at https://testnet.perpl.xyz before running this again.',
  );
}

/** The fill this run produced: the newest one on the market that was not there before. */
async function newFill(rest: PerplRest, seen: Set<string>, marketId: number): Promise<PerplFill | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const fresh = (await rest.fills(20)).filter((f) => f.mkt === marketId && !seen.has(fillKey(f)));
    if (fresh.length > 0) return fresh.sort((a, b) => b.at.b - a.at.b)[0];
    await sleep(POLL_MS);
  }
  return undefined;
}

function report(verb: string, position: PerplPosition | null, fill: PerplFill | undefined, market: Market) {
  if (position) {
    console.log(`  ${verb} ${human(position.s, market.sizeDecimals)} ${market.symbol} at ${human(position.ep, market.priceDecimals)}, position ${position.pid}`);
  }
  if (!fill) {
    console.log(`  ${verb}, but the fill has not appeared in the history yet`);
    return;
  }
  const at = fill.p === undefined ? '' : ` at ${human(fill.p, market.priceDecimals)}`;
  console.log(`  fill ${human(fill.s, market.sizeDecimals)} ${market.symbol}${at}, fee ${usd(fill.f)} AUSD, block ${fill.at.b}`);
  console.log(`  ${txLink(fill.at.txid)}`);
}

main().catch((e: unknown) => {
  // Errors here carry a path and a status, never a key.
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
  stop(e instanceof Error ? `${e.message}${cause}` : String(e));
});
