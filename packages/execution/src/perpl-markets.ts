/**
 * Perpl market registry: asset symbol -> market id (static, documented) and
 * market id -> integer scaling (dynamic, from `GET /v1/pub/context`).
 *
 * Perpl's `p` (price) and `s` (size) on the wire are integers "scaled by
 * price_decimals / size_decimals" of the market (websocket.md). Those counts
 * are per market and can change, so they are read from the public context
 * endpoint and never hard-coded. If the context cannot be loaded, or lists no
 * such market, or the market is closed, the asset is refused with a reason:
 * a wrong guess at decimals would place an order 10x or 1000x off size.
 */

import { z } from 'zod';
import { PERPL_MARKET_IDS, PERPL_REST_BASE_URL, type PerplNetwork } from './perpl-constants';

const ContextSchema = z.looseObject({
  markets: z.array(
    z.looseObject({
      id: z.number().int(),
      symbol: z.string().optional(),
      name: z.string().optional(),
      config: z.looseObject({
        price_decimals: z.number().int().min(0).max(18),
        size_decimals: z.number().int().min(0).max(18),
        is_open: z.boolean().optional(),
      }),
    }),
  ),
});
export type PerplContext = z.infer<typeof ContextSchema>;

export interface PerplMarketInfo {
  id: number;
  /** Perpl's own symbol, e.g. "BTC". */
  symbol: string;
  priceDecimals: number;
  sizeDecimals: number;
  isOpen: boolean;
}

export type PerplMarketResolution = { ok: true; market: PerplMarketInfo } | { ok: false; reason: string };

/** "BTC/USD" or "BTC" -> "BTC". Perpl margins in AUSD and quotes in USD, so
 * only a USD quote is accepted; "BTC/EUR" is not a Perpl market. */
export function perplBaseSymbol(asset: string): string | undefined {
  const m = /^([A-Za-z0-9]+)(?:\/USD)?$/.exec(asset.trim());
  return m?.[1]?.toUpperCase();
}

export interface PerplMarketRegistryOptions {
  network: PerplNetwork;
  restBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Pre-seeded context (tests, or a cached copy). Skips the network call. */
  context?: unknown;
}

export class PerplMarketRegistry {
  private readonly network: PerplNetwork;
  private readonly restBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private byId = new Map<number, PerplMarketInfo>();
  private loaded: Promise<void> | null = null;
  private loadError: string | null = null;

  constructor(opts: PerplMarketRegistryOptions) {
    this.network = opts.network;
    this.restBaseUrl = opts.restBaseUrl ?? PERPL_REST_BASE_URL[opts.network];
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.context !== undefined) {
      this.ingest(ContextSchema.parse(opts.context));
      this.loaded = Promise.resolve();
    }
  }

  private ingest(ctx: PerplContext): void {
    this.byId = new Map(
      ctx.markets.map((m) => [
        m.id,
        {
          id: m.id,
          symbol: (m.symbol ?? m.name ?? String(m.id)).toUpperCase(),
          priceDecimals: m.config.price_decimals,
          sizeDecimals: m.config.size_decimals,
          isOpen: m.config.is_open ?? true,
        },
      ]),
    );
  }

  /** Loads (once) `GET {base}/v1/pub/context`. A failed load is retried on the next call. */
  async load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const res = await this.fetchImpl(`${this.restBaseUrl}/v1/pub/context`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.ingest(ContextSchema.parse(await res.json()));
          this.loadError = null;
        } catch (err) {
          this.loaded = null;
          this.loadError = err instanceof Error ? err.message : String(err);
        }
      })();
    }
    await this.loaded;
  }

  async resolve(asset: string): Promise<PerplMarketResolution> {
    const symbol = perplBaseSymbol(asset);
    const table: Record<string, number> = PERPL_MARKET_IDS[this.network];
    const id = symbol ? table[symbol] : undefined;
    if (symbol === undefined || id === undefined) {
      return { ok: false, reason: `"${asset}" is not a Perpl ${this.network} market` };
    }
    await this.load();
    if (this.loadError) {
      return { ok: false, reason: `could not load Perpl market context, refusing rather than guess decimals: ${this.loadError}` };
    }
    const market = this.byId.get(id);
    if (!market) return { ok: false, reason: `Perpl context lists no market with id ${id} (${symbol})` };
    if (!market.isOpen) return { ok: false, reason: `Perpl market ${symbol} is not open for trading` };
    return { ok: true, market };
  }

  /** Synchronous lookup once loaded; used to interpret venue frames. */
  get(id: number): PerplMarketInfo | undefined {
    return this.byId.get(id);
  }
}
