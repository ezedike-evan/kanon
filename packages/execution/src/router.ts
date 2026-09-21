/**
 * `VenueRouter`: chooses Perpl (perps) or Kuru (spot) for an order, or
 * refuses it with a named reason. docs/ARCHITECTURE.md: "Perpl for perps,
 * Kuru for spot", decided here in client code, never inside the contract.
 *
 * Two properties matter more than the routing table:
 *
 * 1. Routing is identical in paper and live mode. Paper mode swaps the
 *    client, not the rules: an order Kuru could not fill (BTC spot, a short on
 *    spot) is refused in paper too, so a paper run can never approve
 *    something the live path would refuse.
 * 2. Nothing is guessed. An asset with no documented Perpl market id, or no
 *    known Kuru market address, is a refusal with the reason spelled out.
 *
 * Refusal is a success state of this class: `route` returns a decision, it
 * does not throw, and the reason is written to be shown to the user as is.
 */

import { resolveExecutionConfig, type ResolvedExecutionConfig } from './config';
import { KURU_MARKETS, createKuruLiveClient, type KuruNetwork } from './kuru';
import { PaperExecutionClient } from './paper';
import { PerplClient } from './perpl';
import { createEd25519Signer } from './perpl-auth';
import { PERPL_MARKET_IDS, type PerplNetwork } from './perpl-constants';
import { perplBaseSymbol } from './perpl-markets';
import type { ExecutionClient, OrderSide } from './types';

export type Instrument = 'perp' | 'spot';
export type ExecutionMode = 'paper' | 'live';
export type RoutedVenue = 'perpl' | 'kuru';

export type RefusalCode =
  | 'no_perp_market'
  | 'no_spot_market'
  | 'spot_short_unsupported'
  | 'unknown_instrument';

export interface RouteRequest {
  /** Kanon asset symbol, e.g. "BTC/USD". */
  asset: string;
  instrument: Instrument;
  side: OrderSide;
  /** A closing order. On spot a sell is a close; opening a short is not possible. */
  reduceOnly?: boolean;
}

export type RouteDecision =
  | {
      ok: true;
      venue: RoutedVenue;
      /** Whether the order will really hit the venue or be simulated. */
      mode: ExecutionMode;
      /** The client to send it to: the live venue client, or the paper client. */
      client: ExecutionClient;
      /** The asset symbol the client understands ("BTC/USD" for Perpl, "MON/AUSD" for Kuru). */
      venueAsset: string;
    }
  | { ok: false; code: RefusalCode; reason: string };

export interface VenueRouterOptions {
  paper: ExecutionClient;
  perpl: { network: PerplNetwork; mode: ExecutionMode; client?: ExecutionClient };
  kuru: {
    network: KuruNetwork;
    mode: ExecutionMode;
    client?: ExecutionClient;
    /** Which stablecoin a USD-quoted asset ("MON/USD") routes to. Default AUSD. */
    quote?: 'AUSD' | 'USDC';
    /** Overrides the documented market table with addresses you have verified. */
    markets?: Record<string, string>;
  };
}

export class VenueRouter {
  constructor(private readonly opts: VenueRouterOptions) {}

  /** The Kuru market symbol for a Kanon asset, or undefined. "MON/USD" maps to
   * the configured quote; an explicit "MON/AUSD" / "MON/USDC" maps to itself. */
  kuruSymbolFor(asset: string): string | undefined {
    const markets: Record<string, string> = this.opts.kuru.markets ?? KURU_MARKETS[this.opts.kuru.network];
    if (asset in markets) return asset;
    const usd = /^([A-Za-z0-9]+)\/USD$/.exec(asset);
    if (usd?.[1]) {
      const candidate = `${usd[1].toUpperCase()}/${this.opts.kuru.quote ?? 'AUSD'}`;
      if (candidate in markets) return candidate;
    }
    return undefined;
  }

  route(req: RouteRequest): RouteDecision {
    if (req.instrument === 'perp') return this.routePerp(req);
    if (req.instrument === 'spot') return this.routeSpot(req);
    return { ok: false, code: 'unknown_instrument', reason: `unknown instrument "${String(req.instrument)}": expected "perp" or "spot"` };
  }

  private routePerp(req: RouteRequest): RouteDecision {
    const { network, mode, client } = this.opts.perpl;
    const table: Record<string, number> = PERPL_MARKET_IDS[network];
    const symbol = perplBaseSymbol(req.asset);
    if (symbol === undefined || table[symbol] === undefined) {
      return {
        ok: false,
        code: 'no_perp_market',
        reason:
          `${req.asset} has no Perpl ${network} perpetual market. ` +
          `Perpl lists ${Object.keys(table).join(', ')} (all quoted in USD).`,
      };
    }
    return { ok: true, venue: 'perpl', mode, client: this.pick(mode, client), venueAsset: `${symbol}/USD` };
  }

  private routeSpot(req: RouteRequest): RouteDecision {
    const { network, mode, client } = this.opts.kuru;
    const symbol = this.kuruSymbolFor(req.asset);
    if (!symbol) {
      const listed = Object.keys(this.opts.kuru.markets ?? KURU_MARKETS[network]);
      return {
        ok: false,
        code: 'no_spot_market',
        reason:
          `${req.asset} has no Kuru ${network} spot market. Kuru's listed markets are ${listed.join(', ')}; ` +
          'a market address is never guessed. Trade it as a perpetual instead if Perpl lists it.',
      };
    }
    if (req.side === 'sell' && req.reduceOnly !== true) {
      return {
        ok: false,
        code: 'spot_short_unsupported',
        reason: 'spot cannot open a short: a Kuru sell is only accepted as the close of a held position. Use a perpetual to short.',
      };
    }
    return { ok: true, venue: 'kuru', mode, client: this.pick(mode, client), venueAsset: symbol };
  }

  private pick(mode: ExecutionMode, live: ExecutionClient | undefined): ExecutionClient {
    // A venue configured live with no client is a wiring bug. Falling back to
    // paper here would be a silent downgrade, so it is a loud failure.
    if (mode === 'live') {
      if (!live) throw new Error('venue is configured live but no live client was provided');
      return live;
    }
    return this.opts.paper;
  }

  /** Per-venue effective mode, for surfacing in the UI and in reports. */
  modes(): Record<RoutedVenue, ExecutionMode> {
    return { perpl: this.opts.perpl.mode, kuru: this.opts.kuru.mode };
  }
}

// ---------------------------------------------------------------------------
// Environment wiring
// ---------------------------------------------------------------------------

export interface RouterFactories {
  paper?: ExecutionClient;
  createPerplClient?: (cfg: ResolvedExecutionConfig) => ExecutionClient;
  createKuruClient?: (cfg: ResolvedExecutionConfig) => Promise<ExecutionClient>;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
}

export interface EnvRouter {
  router: VenueRouter;
  config: ResolvedExecutionConfig;
  paper: ExecutionClient;
}

/**
 * Builds a router from `process.env`-shaped input. Defaults to paper mode.
 * Live venue clients are constructed only for a venue whose credentials are
 * present and only when `KANON_EXECUTION_MODE=live`.
 */
export async function createVenueRouterFromEnv(
  env: Record<string, string | undefined>,
  factories: RouterFactories = {},
): Promise<EnvRouter> {
  const config = resolveExecutionConfig(env);
  const paper = factories.paper ?? new PaperExecutionClient();

  let perplClient: ExecutionClient | undefined;
  if (config.perpl.mode === 'live' && config.perpl.credentials) {
    const creds = config.perpl.credentials;
    perplClient = factories.createPerplClient
      ? factories.createPerplClient(config)
      : new PerplClient({
          network: config.perpl.network,
          apiKey: creds.apiKey,
          signer: createEd25519Signer(creds.secretKeyHex),
          accountId: creds.accountId,
          defaultLeverageX: config.perpl.defaultLeverageX,
          ...(config.defaultMaxSlippageBps !== undefined ? { defaultMaxSlippageBps: config.defaultMaxSlippageBps } : {}),
          ...(factories.fetchImpl ? { fetchImpl: factories.fetchImpl } : {}),
          ...(factories.WebSocketImpl ? { WebSocketImpl: factories.WebSocketImpl } : {}),
          ...(factories.now ? { now: factories.now } : {}),
        });
  }

  let kuruClient: ExecutionClient | undefined;
  if (config.kuru.mode === 'live' && config.kuru.privateKey) {
    kuruClient = factories.createKuruClient
      ? await factories.createKuruClient(config)
      : await createKuruLiveClient({
          network: config.kuru.network,
          privateKey: config.kuru.privateKey,
          useMargin: config.kuru.useMargin,
          ...(config.kuru.rpcUrl ? { rpcUrl: config.kuru.rpcUrl } : {}),
          ...(config.defaultMaxSlippageBps !== undefined ? { defaultMaxSlippageBps: config.defaultMaxSlippageBps } : {}),
        });
  }

  const router = new VenueRouter({
    paper,
    perpl: { network: config.perpl.network, mode: config.perpl.mode, ...(perplClient ? { client: perplClient } : {}) },
    kuru: {
      network: config.kuru.network,
      mode: config.kuru.mode,
      quote: config.kuru.quote,
      ...(kuruClient ? { client: kuruClient } : {}),
    },
  });
  return { router, config, paper };
}
