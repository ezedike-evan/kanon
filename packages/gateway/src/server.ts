/**
 * The gateway process: one HTTP server that answers the public REST paths from
 * a cache and upgrades `/ws/v1/market-data` to a socket fed by the hub.
 *
 * Market data is public data that Perpl publishes; the gateway exists because a
 * browser on our origin cannot reach Perpl directly, and so that many viewers
 * cost the venue one connection. For that half it holds no key.
 *
 * `/trade` is the other half and is off unless a key is configured (`trade.ts`,
 * `config.ts`). With it on, this process holds one Perpl API key and places
 * orders for signed-in callers.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { originAllowed, type GatewayConfig } from './config';
import { Hub, type HubClient } from './hub';
import type { Logger } from './log';
import { RestProxy } from './rest';
import { MT } from './streams';
import { TRADE_PREFIX, disconnectedTrade, type TradeRoutes } from './trade';
import { UpstreamPool, type SocketFactory } from './upstream';
import { wsSocketFactory } from './ws-socket';

export const WS_PATH = '/ws/v1/market-data';

/** A subscribe frame is small; anything larger is not one. */
const MAX_CLIENT_FRAME_BYTES = 4096;
/** A client this far behind is dropped rather than buffered for. */
const MAX_BUFFERED_BYTES = 1_000_000;
const CLIENT_MESSAGES_PER_WINDOW = 20;
const CLIENT_WINDOW_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const MARKETS_REFRESH_MS = 60_000;
const MARKETS_RETRY_MS = 5_000;

export interface GatewayDeps {
  config: GatewayConfig;
  log: Logger;
  socketFactory?: SocketFactory;
  fetchImpl?: typeof fetch;
  /** The order routes, when a key is configured. Without them `/trade` says trading is not connected. */
  trade?: TradeRoutes;
}

export interface Gateway {
  /** Starts listening and connects upstream. Resolves with the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createGateway(deps: GatewayDeps): Gateway {
  const { config, log } = deps;
  const trade = deps.trade ?? disconnectedTrade;

  let markets: Set<number> | null = null;
  const isKnownMarket = (id: number): boolean | null => (markets === null ? null : markets.has(id));

  const pool: UpstreamPool = new UpstreamPool({
    url: config.wsUrl,
    chainId: config.chainId,
    socketFactory: deps.socketFactory ?? wsSocketFactory,
    log,
    maxConnections: config.maxUpstreamConnections,
    onFrame: (stream, frame, raw) => hub.onFrame(stream, frame, raw),
    onRejected: (stream, code, error) => hub.onRejected(stream, code, error),
  });
  const hub: Hub = new Hub({
    chainId: config.chainId,
    source: pool,
    log,
    isKnownMarket,
    pinned: [`heartbeat@${config.chainId}`, `market-state@${config.chainId}`, ...config.warmStreams],
    lingerMs: config.lingerMs,
  });
  const rest = new RestProxy({
    baseUrl: config.restUrl,
    log,
    isKnownMarket,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  /** The venue's market list decides which market ids a client may name. False if it could not be read. */
  async function refreshMarkets(): Promise<boolean> {
    const res = await rest.get('/v1/pub/context', new URLSearchParams());
    if (res.status !== 200) return false;
    try {
      const parsed = JSON.parse(res.body) as { markets?: Array<{ id?: unknown }> };
      const ids = (parsed.markets ?? []).map((m) => m.id).filter((id): id is number => typeof id === 'number');
      if (ids.length === 0) return false;
      if (markets === null) log({ level: 'info', event: 'markets_loaded', count: ids.length });
      markets = new Set(ids);
      return true;
    } catch {
      log({ level: 'warn', event: 'markets_unreadable' });
      return false;
    }
  }

  const corsHeaders = (origin: string | undefined): Record<string, string> =>
    origin === undefined
      ? {}
      : { 'access-control-allow-origin': config.allowedOrigins === '*' ? '*' : origin, vary: 'origin' };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders(origin), ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (!originAllowed(origin, config.allowedOrigins)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"origin not allowed"}');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://gateway');
    const isTrade = url.pathname.startsWith(TRADE_PREFIX);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders(origin),
        // An order is a POST that carries the caller's sign-in token, so a browser asks first.
        ...(isTrade
          ? { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type' }
          : { 'access-control-allow-methods': 'GET' }),
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }
    if (isTrade) {
      const answer = await trade.handle(req, url.pathname);
      send(answer.status, JSON.stringify(answer.body), {
        'cache-control': 'no-store',
        ...(answer.allow ? { allow: answer.allow } : {}),
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, '{"error":"method not allowed"}', { allow: 'GET' });
      return;
    }
    // Liveness for the host: the process is up and answering. It stays 200 through a
    // venue outage, when restarting the gateway would only throw its cache away.
    if (url.pathname === '/livez') {
      send(200, '{"ok":true}', { 'cache-control': 'no-store' });
      return;
    }
    if (url.pathname === '/healthz') {
      const ok = pool.healthy();
      send(
        ok ? 200 : 503,
        JSON.stringify({ ok, network: config.network, clients: wss.clients.size, ...hub.stats(), upstream: pool.status() }),
        { 'cache-control': 'no-store' },
      );
      return;
    }
    const answer = await rest.get(url.pathname, url.searchParams);
    send(answer.status, answer.body, {
      'cache-control': answer.cacheControl,
      'x-kanon-cache': answer.cached ? 'hit' : 'miss',
    });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log({ level: 'error', event: 'request_failed', error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  const refuse = (socket: Duplex, status: number, reason: string) => {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://gateway');
    if (pathname !== WS_PATH) return refuse(socket, 404, 'Not Found');
    if (!originAllowed(req.headers.origin, config.allowedOrigins)) return refuse(socket, 403, 'Forbidden');
    if (wss.clients.size >= config.maxClients) return refuse(socket, 503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
  });

  function attach(ws: WebSocket): void {
    alive.set(ws, true);
    const client: HubClient = {
      send(text) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          ws.terminate();
          return;
        }
        ws.send(text);
      },
    };
    let windowStart = Date.now();
    let inWindow = 0;

    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', () => ws.terminate());
    ws.on('close', () => hub.remove(client));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'text frames only');
      const now = Date.now();
      if (now - windowStart > CLIENT_WINDOW_MS) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > CLIENT_MESSAGES_PER_WINDOW) return ws.close(1008, 'too many requests');
      let frame: { mt?: unknown; subs?: unknown };
      try {
        frame = JSON.parse(data.toString()) as typeof frame;
      } catch {
        return ws.close(1007, 'not JSON');
      }
      if (frame?.mt === MT.subscribe) hub.request(client, frame.subs);
      else if (frame?.mt === MT.ping) client.send(`{"mt":${MT.pong}}`);
    });
  }

  let pinger: ReturnType<typeof setInterval> | null = null;
  let refresher: ReturnType<typeof setTimeout> | null = null;
  let closing = false;
  const keepMarketsFresh = async (): Promise<void> => {
    const ok = await refreshMarkets();
    if (closing) return;
    refresher = setTimeout(() => void keepMarketsFresh(), ok ? MARKETS_REFRESH_MS : MARKETS_RETRY_MS);
  };

  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      pool.start();
      void keepMarketsFresh();
      pinger = setInterval(() => {
        for (const ws of wss.clients) {
          if (alive.get(ws) === false) {
            ws.terminate();
            continue;
          }
          alive.set(ws, false);
          ws.ping();
        }
      }, PING_INTERVAL_MS);
      return (server.address() as AddressInfo).port;
    },
    async close() {
      closing = true;
      if (pinger) clearInterval(pinger);
      if (refresher) clearTimeout(refresher);
      for (const ws of wss.clients) ws.terminate();
      pool.close();
      hub.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
