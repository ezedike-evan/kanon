/**
 * A typed client for Nansen's Smart Money net-flow endpoint.
 *
 *   POST https://api.nansen.ai/api/v1/smart-money/netflow      (5 credits a call)
 *   header  apikey: <NANSEN_API_KEY>
 *   docs    https://docs.nansen.ai/api/smart-money/netflows
 *
 * What it does and does not do:
 *
 *   - It reports Nansen's smart-money net flow, in USD, over 1h / 24h / 7d / 30d
 *     for the on-chain token that stands in for the asset on screen. It says
 *     which token that is. Nansen sees on-chain tokens, not "BTC/USD", so BTC is
 *     read through WBTC on Ethereum and ETH through WETH: a proxy, named as one.
 *   - It never invents a number. No key means `not_connected`; a failed call is
 *     an `error` with its kind; a token Nansen has no row for is `no_data`.
 *   - It is not an input to any predicate. The contract never sees it. It is
 *     context for a human reading the analytics screen and carries no weight in
 *     what the rule allows.
 *
 * `fetch` is injected so the whole path, including every failure, is tested
 * against a mock. Nansen returns flows as JSON numbers (USD, fractional). That
 * is the one place a float is unavoidable, so each is converted to integer cents
 * at the boundary and never handled as a float again.
 */

import { z } from 'zod';
import { dec, type NansenErrorKind, type NansenFlow, type NansenToken } from '@kanon/spec';

export const NANSEN_BASE_URL = 'https://api.nansen.ai';
export const NANSEN_NETFLOW_PATH = '/api/v1/smart-money/netflow';
export const NANSEN_DOCS_URL = 'https://docs.nansen.ai/api/smart-money/netflows';

// ---------------------------------------------------------------------------
// Which token stands in for which asset
// ---------------------------------------------------------------------------

/**
 * Nansen is asked about tokens by chain and address. These are the wrapped
 * on-chain forms of the assets the product trades. An asset not listed has no
 * honest proxy here and is reported `unsupported` rather than guessed at.
 */
export const NANSEN_TOKENS: Readonly<Record<string, NansenToken>> = {
  'BTC/USD': {
    chain: 'ethereum',
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    symbol: 'WBTC',
  },
  'ETH/USD': {
    chain: 'ethereum',
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    symbol: 'WETH',
  },
  'SOL/USD': {
    chain: 'solana',
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
  },
  'AVAX/USD': {
    chain: 'avalanche',
    address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    symbol: 'WAVAX',
  },
};

export const NANSEN_ASSETS = Object.keys(NANSEN_TOKENS);

export function nansenAssetKey(asset: string): string {
  return asset.replace(/\s+/g, '').toUpperCase();
}

export function nansenTokenFor(asset: string): NansenToken | null {
  return NANSEN_TOKENS[nansenAssetKey(asset)] ?? null;
}

// ---------------------------------------------------------------------------
// Boundary schemas
// ---------------------------------------------------------------------------

const usdNumber = z.number().finite();

/** One row of Nansen's `data` array. Only what is read is required; the rest is ignored. */
export const NansenNetflowRow = z.object({
  token_address: z.string(),
  token_symbol: z.string().nullish(),
  chain: z.string().nullish(),
  net_flow_1h_usd: usdNumber,
  net_flow_24h_usd: usdNumber,
  net_flow_7d_usd: usdNumber,
  net_flow_30d_usd: usdNumber,
  trader_count: z.number().int().nonnegative().nullish(),
});
export type NansenNetflowRow = z.infer<typeof NansenNetflowRow>;

export const NansenNetflowResponse = z.object({
  data: z.array(NansenNetflowRow),
});

/** The request body for one token. `per_page` is small: the filter names the token. */
export function buildNetflowRequest(token: NansenToken) {
  return {
    chains: [token.chain],
    filters: {
      token_address: token.address,
      // Solana's SOL and the like are tracked as native tokens; without this they are dropped.
      include_native_tokens: true,
    },
    pagination: { page: 1, per_page: 10 },
  };
}

/** Whole-dollar-and-cents from Nansen's JSON number, half away from zero. */
function centsOf(usd: number) {
  return dec(BigInt(Math.round(usd * 100)), 2);
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal | undefined;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface NansenClientOptions {
  /** `NANSEN_API_KEY`. Empty or absent is `not_connected`, and no request is made. */
  apiKey: string | undefined;
  fetch: FetchLike;
  /** Milliseconds. Stamped on the result so a cached flow says how old it is. */
  now: number;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

const err = (kind: NansenErrorKind, message: string): NansenFlow => ({
  status: 'error',
  kind,
  message,
});

/** What a non-2xx answer means, in words that do not blame the reader. */
export function classifyHttpStatus(status: number): { kind: NansenErrorKind; message: string } {
  if (status === 401 || status === 403) {
    return { kind: 'auth', message: 'Nansen did not accept the API key.' };
  }
  if (status === 402) {
    return { kind: 'credits', message: 'The Nansen account has no credits left for this call.' };
  }
  if (status === 429) {
    return { kind: 'rate_limited', message: 'Nansen is rate limiting this key. Try again shortly.' };
  }
  if (status >= 500) {
    return { kind: 'upstream', message: `Nansen answered with a server error (${status}).` };
  }
  return { kind: 'bad_request', message: `Nansen rejected the request (${status}).` };
}

const sameToken = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Smart-money net flow for `asset`.
 *
 * Reads only the row whose token address is the one asked for. If Nansen
 * returns other tokens, or none, that is not converted into a number.
 */
export async function fetchSmartMoneyFlow(
  asset: string,
  opts: NansenClientOptions,
): Promise<NansenFlow> {
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) return { status: 'not_connected' };

  const token = nansenTokenFor(asset);
  if (!token) return { status: 'unsupported', asset };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await opts.fetch(`${opts.baseUrl ?? NANSEN_BASE_URL}${NANSEN_NETFLOW_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        apikey: apiKey,
      },
      body: JSON.stringify(buildNetflowRequest(token)),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return err('network', aborted ? 'Nansen did not answer in time.' : 'Could not reach Nansen.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const { kind, message } = classifyHttpStatus(res.status);
    return err(kind, message);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return err('invalid_response', 'Nansen returned something that is not JSON.');
  }

  const parsed = NansenNetflowResponse.safeParse(body);
  if (!parsed.success) {
    return err('invalid_response', 'Nansen returned a response in a shape this client does not know.');
  }

  const row = parsed.data.data.find((r) => sameToken(r.token_address, token.address));
  if (!row) return { status: 'no_data', asset: nansenAssetKey(asset), token };

  return {
    status: 'ok',
    asset: nansenAssetKey(asset),
    token,
    flows: {
      h1: centsOf(row.net_flow_1h_usd),
      h24: centsOf(row.net_flow_24h_usd),
      d7: centsOf(row.net_flow_7d_usd),
      d30: centsOf(row.net_flow_30d_usd),
    },
    traderCount: row.trader_count ?? 0,
    fetchedAt: opts.now,
    requestId: res.headers.get('x-request-id'),
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * A call costs credits and Nansen's windows are rolling, so a flow read within
 * the last ten minutes is served again instead of bought again. Only an `ok`
 * result is cached: an error or an empty answer is retried on the next view.
 */
export const NANSEN_CACHE_TTL_MS = 10 * 60 * 1000;

export function isFresh(fetchedAt: number, now: number): boolean {
  return now >= fetchedAt && now - fetchedAt < NANSEN_CACHE_TTL_MS;
}
