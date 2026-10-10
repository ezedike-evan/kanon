/**
 * Gateway configuration, from environment variables, validated with Zod.
 *
 *   PERPL_NETWORK                     `testnet` (default) or `mainnet`.
 *   PERPL_REST_URL                    optional override of the venue REST base.
 *   PERPL_WS_URL                      optional override of the market-data socket URL.
 *   PORT                              default 8787.
 *   HOST                              default 0.0.0.0.
 *   GATEWAY_ALLOWED_ORIGINS           comma-separated browser origins allowed to
 *                                     connect, or `*` for any. Default: the two
 *                                     local dev servers. A request with no Origin
 *                                     header (a native app, a server) is always
 *                                     allowed: the data is public, and the header
 *                                     only exists to be checked in browsers.
 *   GATEWAY_WARM_STREAMS              comma-separated streams kept subscribed
 *                                     from start, e.g. `candles@16*900`.
 *   GATEWAY_MAX_UPSTREAM_CONNECTIONS  default 3. Each carries 15 streams.
 *   GATEWAY_LINGER_SECONDS            default 300. How long an unwatched stream
 *                                     stays subscribed.
 *   GATEWAY_MAX_CLIENTS               default 2000.
 *   FORCE_IPV4                        `true` to resolve and connect over IPv4
 *                                     only, for hosts with broken IPv6.
 *
 * Trading (`/trade`, see `trade.ts`) is off unless all four of these are set.
 * Some but not all of them is a fault, never a half-connected service.
 *
 *   PERPL_API_KEY                     the API key of the one exchange account
 *   PERPL_API_KEY_SECRET              orders go to, and its Ed25519 secret (hex,
 *                                     base64url or PEM).
 *   CONVEX_SITE_URL                   the backend's `.convex.site` address, which
 *                                     checks who is asking and records each order.
 *   VENUE_RECORDER_KEY                the key that backend expects from this
 *                                     service. The same value is set there.
 *   PERPL_TRADE_NETWORK               `testnet` (default) or `mainnet`. Separate
 *                                     from PERPL_NETWORK: the charts may read one
 *                                     network while orders go to the other.
 */

import { z } from 'zod';
import { parseStream } from './streams';

// Copied, not imported, from `@kanon/execution` (perpl-constants.ts), which pulls
// in signing and chain libraries this service has no use for. Keep them in step.
const NETWORKS = {
  mainnet: {
    restUrl: 'https://app.perpl.xyz/api',
    wsUrl: 'wss://app.perpl.xyz/ws/v1/market-data',
    chainId: 143,
  },
  testnet: {
    restUrl: 'https://testnet.perpl.xyz/api',
    wsUrl: 'wss://testnet.perpl.xyz/ws/v1/market-data',
    chainId: 10143,
  },
} as const;

export class ConfigError extends Error {}

/** What the gateway needs to place orders. Never logged. */
export interface TradeConfig {
  apiKey: string;
  secret: string;
  network: keyof typeof NETWORKS;
  convexSiteUrl: string;
  recorderKey: string;
}

export interface GatewayConfig {
  network: keyof typeof NETWORKS;
  chainId: number;
  restUrl: string;
  wsUrl: string;
  port: number;
  host: string;
  /** `'*'`, or the exact origins allowed. */
  allowedOrigins: '*' | readonly string[];
  warmStreams: readonly string[];
  maxUpstreamConnections: number;
  lingerMs: number;
  maxClients: number;
  forceIpv4: boolean;
  /** Null when trading is not configured: the gateway then serves market data only and holds no key. */
  trade: TradeConfig | null;
}

const list = (raw: string): string[] =>
  raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const Env = z.object({
  PERPL_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
  PERPL_REST_URL: z.url({ protocol: /^https?$/ }).optional(),
  PERPL_WS_URL: z.url({ protocol: /^wss?$/ }).optional(),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  HOST: z.string().min(1).default('0.0.0.0'),
  GATEWAY_ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:8081'),
  GATEWAY_WARM_STREAMS: z.string().default(''),
  GATEWAY_MAX_UPSTREAM_CONNECTIONS: z.coerce.number().int().min(1).max(8).default(3),
  GATEWAY_LINGER_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  GATEWAY_MAX_CLIENTS: z.coerce.number().int().min(1).max(100_000).default(2000),
  FORCE_IPV4: z.enum(['true', 'false']).default('false'),
  PERPL_API_KEY: z.string().min(8).optional(),
  PERPL_API_KEY_SECRET: z.string().min(32).optional(),
  CONVEX_SITE_URL: z.url({ protocol: /^https?$/ }).optional(),
  VENUE_RECORDER_KEY: z.string().min(32).optional(),
  PERPL_TRADE_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
});

const TRADE_VARIABLES = ['PERPL_API_KEY', 'PERPL_API_KEY_SECRET', 'CONVEX_SITE_URL', 'VENUE_RECORDER_KEY'] as const;

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  // An empty variable means unset, so a blank line in an env file takes the default.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = Env.safeParse(present);
  if (!parsed.success) {
    // Names and what is wrong with them. Never a value: some of these are keys.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  const e = parsed.data;
  const network = NETWORKS[e.PERPL_NETWORK];

  const origins = list(e.GATEWAY_ALLOWED_ORIGINS);
  for (const origin of origins) {
    if (origin !== '*' && !/^https?:\/\/[^/\s]+$/.test(origin)) {
      throw new ConfigError(`GATEWAY_ALLOWED_ORIGINS: "${origin}" is not an origin (scheme://host[:port], no path)`);
    }
  }

  const warmStreams = list(e.GATEWAY_WARM_STREAMS).map((raw) => {
    const stream = parseStream(raw, network.chainId);
    if (!stream) throw new ConfigError(`GATEWAY_WARM_STREAMS: "${raw}" is not a stream on chain ${network.chainId}`);
    return stream.name;
  });

  const missing = TRADE_VARIABLES.filter((name) => e[name] === undefined);
  if (missing.length > 0 && missing.length < TRADE_VARIABLES.length) {
    throw new ConfigError(`Trading needs all of ${TRADE_VARIABLES.join(', ')}. Not set: ${missing.join(', ')}`);
  }
  const trade: TradeConfig | null =
    e.PERPL_API_KEY && e.PERPL_API_KEY_SECRET && e.CONVEX_SITE_URL && e.VENUE_RECORDER_KEY
      ? {
          apiKey: e.PERPL_API_KEY,
          secret: e.PERPL_API_KEY_SECRET,
          network: e.PERPL_TRADE_NETWORK,
          convexSiteUrl: e.CONVEX_SITE_URL.replace(/\/+$/, ''),
          recorderKey: e.VENUE_RECORDER_KEY,
        }
      : null;

  return {
    network: e.PERPL_NETWORK,
    chainId: network.chainId,
    restUrl: (e.PERPL_REST_URL ?? network.restUrl).replace(/\/+$/, ''),
    wsUrl: e.PERPL_WS_URL ?? network.wsUrl,
    port: e.PORT,
    host: e.HOST,
    allowedOrigins: origins.includes('*') ? '*' : origins,
    warmStreams,
    maxUpstreamConnections: e.GATEWAY_MAX_UPSTREAM_CONNECTIONS,
    lingerMs: e.GATEWAY_LINGER_SECONDS * 1000,
    maxClients: e.GATEWAY_MAX_CLIENTS,
    forceIpv4: e.FORCE_IPV4 === 'true',
    trade,
  };
}

/**
 * A request with no Origin header is not from a browser page and is allowed.
 * This guards nothing secret: market data is public, and `/trade` is held by
 * the caller's own sign-in token, not by where the request came from.
 */
export function originAllowed(origin: string | undefined, allowed: GatewayConfig['allowedOrigins']): boolean {
  if (origin === undefined || allowed === '*') return true;
  return allowed.includes(origin);
}
