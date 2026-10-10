/**
 * One real order on Perpl, end to end: open a small long at market, wait for
 * the fill, close it, and print the transactions.
 *
 *   pnpm --filter @kanon/execution perpl:order            look only: account, price, the order it would send
 *   pnpm --filter @kanon/execution perpl:order --send     place it, then close it
 *   pnpm --filter @kanon/execution perpl:order --close    close a position an earlier run left open
 *   ... perpl:order --market ETH --usd 25 --leverage 2 --side short
 *
 * Testnet only: it refuses any other network.
 *
 * The order itself is placed by `perpl-trade.ts`, the same code the backend
 * runs for an order from the app, so a run of this script is a live check of
 * that path.
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
import { PERPL_REST_BASE_URL } from './perpl-constants';
import {
  PerplRestError,
  createPerplRest,
  isOpenPosition,
  sizeForNotional,
  type PerplAccount,
  type PerplPosition,
  type PerplRest,
} from './perpl-rest';
import { closeAtMarket, openAtMarket, readPerplAccount, type MarketOrderOutcome, type VenueFill } from './perpl-trade';

const NETWORK = 'testnet' as const;
const EXPLORER_TX = 'https://testnet.monadscan.com/tx/';
const COLLATERAL_DECIMALS = 6;
const MAX_SLIPPAGE_BPS = 100;
const SETTLE_TIMEOUT_MS = 60_000;

const args = process.argv.slice(2).filter((a) => a !== '--');
const has = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};

const human = (scaled: number, decimals: number) => (scaled / 10 ** decimals).toFixed(decimals);
const usd = (atoms: string) => (Number(atoms) / 10 ** COLLATERAL_DECIMALS).toFixed(2);
const txLink = (txHash: string | null) => (txHash ? `${EXPLORER_TX}${txHash}` : '(no transaction id reported)');

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
  open: boolean;
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
    open: market.config.is_open,
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
  const side = option('side', 'long');
  if (side !== 'long' && side !== 'short') stop('--side is long or short.');
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
    await close(rest, market, account, held);
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
  console.log(
    `Order     open ${side} ${human(size, market.sizeDecimals)} ${market.symbol} at market ` +
      `(about $${notional}), ${leverage}x, max slippage ${MAX_SLIPPAGE_BPS / 100}%`,
  );

  const ALREADY_OPEN = `There is already an open ${market.symbol} position on this account. Run again with --close to close it.`;
  if (!send) {
    console.log(held ? `\nNothing sent. ${ALREADY_OPEN}` : '\nNothing sent. Run again with --send to place it and then close it.');
    return;
  }
  if (!account.fw) stop(ONE_CLICK_OFF);
  if (held) stop(ALREADY_OPEN);

  console.log('\nOpening');
  const opened = await openAtMarket(
    { rest, settleTimeoutMs: SETTLE_TIMEOUT_MS },
    { market, account, side, size, leverage: leverage * 100, slippageBps: MAX_SLIPPAGE_BPS },
  );
  report(await settled(opened), market);

  // Read back, not assumed: the close is sized from what the venue says is held, and numbered after its last request.
  const now = await readPerplAccount(rest);
  const position = now?.positions.find((p) => p.mkt === market.id);
  if (!now || !position) stop('The order filled, but the venue reports no open position. Check the account at https://testnet.perpl.xyz.');
  console.log(`  position ${position.pid}: ${human(position.s, market.sizeDecimals)} ${market.symbol} at ${human(position.ep, market.priceDecimals)}`);

  await close(rest, market, now.account, position);
  await reportBalance(rest, account);
  console.log('\nDone: one order opened and closed on Perpl testnet.');
}

const ONE_CLICK_OFF =
  'One-Click Trading is off, so Perpl would refuse the order. Turn it on in settings at https://testnet.perpl.xyz.';

/** Closes the whole of `position` at market and prints the fill. */
async function close(rest: PerplRest, market: Market, account: PerplAccount, position: PerplPosition) {
  console.log('\nClosing');
  const closed = await closeAtMarket(
    { rest, settleTimeoutMs: SETTLE_TIMEOUT_MS },
    { account, position, slippageBps: MAX_SLIPPAGE_BPS },
  );
  report(await settled(closed), market);
}

/** How long to keep asking the venue's history for a fill it has not reported yet. */
const FILL_RECORD_WAIT_MS = 45_000;

/** The fill of an order that settled. Anything else ends the run with what the venue said. */
async function settled(outcome: MarketOrderOutcome): Promise<VenueFill> {
  if (outcome.status === 'refused') stop(`Perpl refused the order: ${outcome.reason} (code ${outcome.code}).`);
  if (outcome.status === 'unfilled') {
    stop(
      `Request ${outcome.requestId} was forwarded and the position did not change: nothing filled. ` +
        'Check the account at https://testnet.perpl.xyz before running this again.',
    );
  }
  if (outcome.status === 'pending') {
    stop(
      `Request ${outcome.requestId} was accepted, and Perpl had not reported its result after ${SETTLE_TIMEOUT_MS / 1000}s. ` +
        'It may still fill. Check the account at https://testnet.perpl.xyz before running this again.',
    );
  }
  console.log(`  accepted for forwarding (request ${outcome.requestId}); the position has changed`);
  // The position moves first; the history that carries the price and the transaction follows.
  let fill = outcome.fill;
  const deadline = Date.now() + FILL_RECORD_WAIT_MS;
  while (!fill && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    fill = await outcome.findFill();
  }
  if (!fill) {
    stop(
      `The order filled, but Perpl's history had not listed the fill after ${FILL_RECORD_WAIT_MS / 1000}s, ` +
        'so there is no transaction to print. Check the account at https://testnet.perpl.xyz.',
    );
  }
  return fill;
}

function report(fill: VenueFill, market: Market) {
  const at = fill.price === null ? '' : ` at ${human(fill.price, market.priceDecimals)}`;
  console.log(`  fill ${human(fill.size, market.sizeDecimals)} ${market.symbol}${at}, fee ${usd(fill.fee)} AUSD, block ${fill.block}`);
  console.log(`  ${txLink(fill.txHash)}`);
}

async function reportBalance(rest: PerplRest, before: PerplAccount) {
  const after = (await rest.wallet()).as.find((a) => a.id === before.id);
  if (after) console.log(`\nBalance   ${usd(after.b)} AUSD (was ${usd(before.b)})`);
}

main().catch((e: unknown) => {
  // Errors here carry a path and a status, never a key.
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
  stop(e instanceof Error ? `${e.message}${cause}` : String(e));
});
