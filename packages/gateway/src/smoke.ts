/**
 * Checks a running gateway from the outside, the way a browser tab on our site
 * would use it, and prints what it sees.
 *
 *   pnpm --filter @kanon/gateway smoke                          the local one
 *   pnpm --filter @kanon/gateway smoke https://<host>           a deployed one
 *   ... smoke <url> --origin https://kanon.example --seconds 30
 *
 * `--origin` is the site the pretend browser is on; it must be one the gateway
 * allows. Exits 0 if every check passed, 1 otherwise.
 */

import WebSocket from 'ws';
import { WS_PATH } from './server';
import { MT } from './streams';

const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const origin = flag('origin', 'http://localhost:3000');
const seconds = Number(flag('seconds', '15'));
const FOREIGN_ORIGIN = 'https://not-allowed.example';

let failed = 0;
const pass = (what: string) => console.log(`  ok    ${what}`);
const fail = (what: string) => {
  failed++;
  console.log(`  FAIL  ${what}`);
};
const check = (ok: boolean, what: string) => (ok ? pass(what) : fail(what));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(path: string, from: string | undefined = origin) {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, from ? { headers: { origin: from } } : {});
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Left null; the caller reports the status.
  }
  return { status: res.status, body, ms: Math.round(performance.now() - started), headers: res.headers };
}

const price = (scaled: number, decimals: number) => (scaled / 10 ** decimals).toFixed(decimals);

async function main() {
  console.log(`Gateway ${base}, as a page on ${origin}\n`);

  console.log('Venue connection');
  let health = await get('/healthz');
  for (let i = 0; i < 20 && health.status !== 200; i++) {
    if (i === 0) console.log('        not connected to the venue yet, waiting up to 40s');
    await sleep(2_000);
    health = await get('/healthz');
  }
  check(health.status === 200, `connected to Perpl ${health.body?.network ?? '?'} (/healthz ${health.status})`);
  if (health.status !== 200) return;

  console.log('\nMarkets');
  const context = await get('/v1/pub/context');
  const markets: Array<{ id: number; symbol: string; name: string; config: { price_decimals: number } }> =
    context.body?.markets ?? [];
  const chainId: number | undefined = context.body?.chain?.chain_id;
  check(context.status === 200 && markets.length > 0, `${markets.length} markets listed in ${context.ms}ms`);
  if (markets.length === 0 || chainId === undefined) return;
  const label = (m: (typeof markets)[number]) => m.symbol || m.name;
  console.log(`        ${markets.map((m) => `${label(m)}=${m.id}`).join('  ')}`);
  const market = markets.find((m) => label(m).startsWith('BTC')) ?? markets[0]!;
  const decimals = market.config.price_decimals;

  console.log(`\nHistory, ${label(market)} 15m candles`);
  const step = 900_000;
  // A window that ended a while ago, aligned to the candle size: every candle in it has closed.
  const to = Math.floor(Date.now() / step) * step - 4 * step;
  const closedPath = `/v1/market-data/${market.id}/candles/900/${to - 300 * step}-${to}`;
  const first = await get(closedPath);
  const candles: Array<{ t: number; c: number }> = first.body?.d ?? [];
  check(first.status === 200 && candles.length > 0, `${candles.length} closed candles in ${first.ms}ms`);
  const second = await get(closedPath);
  check(second.headers.get('x-kanon-cache') === 'hit', `same request again in ${second.ms}ms, answered from the gateway's memory`);
  check(first.headers.get('access-control-allow-origin') !== null, 'response carries a CORS header for this origin');
  const recent = await get(`/v1/market-data/${market.id}/candles/900/${Date.now() - 50 * step}-${Date.now()}`);
  const last = (recent.body?.d ?? []).at(-1) as { c: number } | undefined;
  check(recent.status === 200 && last !== undefined, `range up to now in ${recent.ms}ms, last close ${last ? price(last.c, decimals) : '?'}`);

  console.log(`\nLive socket, ${seconds}s`);
  const candleStream = `candles@${market.id}*60`;
  const stateStream = `market-state@${chainId}`;
  const tradeStream = `trades@${market.id}`;
  const counts = new Map<string, number>();
  const started = performance.now();
  const since = () => Math.round(performance.now() - started);
  let ackAt: number | null = null;
  let snapshotAt: number | null = null;
  let lastPrinted = 0;
  let wrongStream = 0;
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}${WS_PATH}`, { headers: { origin } });
  const opened = await new Promise<boolean>((resolve) => {
    ws.once('open', () => resolve(true));
    ws.once('error', (e) => {
      fail(`socket did not open: ${e.message}`);
      resolve(false);
    });
  });
  if (!opened) return;
  pass(`socket open in ${since()}ms`);
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.mt === MT.subscribeAck) {
      ackAt = since();
      const refused = (frame.subs as Array<{ stream: string; status: { code: number } }>).filter((s) => s.status.code !== 0);
      check(refused.length === 0, `subscribed to 3 streams, ack at ${ackAt}ms`);
      return;
    }
    counts.set(frame.stream, (counts.get(frame.stream) ?? 0) + 1);
    const expected: Record<string, number[]> = {
      [candleStream]: [MT.candlesSnapshot, MT.candlesUpdate],
      [stateStream]: [MT.marketState],
      [tradeStream]: [MT.tradesSnapshot, MT.tradesUpdate],
    };
    if (!expected[frame.stream]?.includes(frame.mt)) wrongStream++;
    if (frame.mt === MT.candlesSnapshot && snapshotAt === null) {
      snapshotAt = since();
      pass(`${frame.d.length} one-minute candles at ${snapshotAt}ms`);
    }
    const state = frame.mt === MT.marketState ? frame.d?.[market.id] : undefined;
    if (state && performance.now() - lastPrinted > 1_500) {
      lastPrinted = performance.now();
      console.log(`        ${label(market)} mark ${price(state.mrk, decimals)}  bid ${price(state.bid, decimals)}  ask ${price(state.ask, decimals)}`);
    }
  });
  ws.send(JSON.stringify({ mt: MT.subscribe, subs: [candleStream, stateStream, tradeStream].map((stream) => ({ stream, subscribe: true })) }));
  await sleep(seconds * 1000);
  ws.close();
  check(snapshotAt !== null, 'candle snapshot received');
  check((counts.get(stateStream) ?? 0) > 1, `${counts.get(stateStream) ?? 0} price updates`);
  check((counts.get(tradeStream) ?? 0) > 0, `recent trades received (${counts.get(tradeStream) ?? 0} frames)`);
  check(wrongStream === 0, 'every frame arrived on the stream it belongs to');

  console.log('\nWhat it must refuse');
  const foreign = await get('/v1/market-data/ticker', FOREIGN_ORIGIN);
  if (foreign.status === 200) {
    console.log('        this gateway allows any origin (GATEWAY_ALLOWED_ORIGINS=*), skipping the origin checks');
  } else {
    check(foreign.status === 403, `HTTP from ${FOREIGN_ORIGIN} refused (${foreign.status})`);
    const refusedSocket = await new Promise<string>((resolve) => {
      const other = new WebSocket(`${base.replace(/^http/, 'ws')}${WS_PATH}`, { headers: { origin: FOREIGN_ORIGIN } });
      other.once('open', () => {
        other.close();
        resolve('opened');
      });
      other.once('error', (e) => resolve(e.message));
    });
    check(/403/.test(refusedSocket), `socket from ${FOREIGN_ORIGIN} refused (${refusedSocket})`);
  }
  const trading = await get('/v1/trading/orders');
  check(trading.status === 404, `trading path not served (${trading.status})`);
}

main()
  .catch((e: unknown) => fail(e instanceof Error ? `${e.message}${e.cause instanceof Error ? `: ${e.cause.message}` : ''}` : String(e)))
  .finally(() => {
    console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
  });
