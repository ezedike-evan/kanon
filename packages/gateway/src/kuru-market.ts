/**
 * `GET /kuru/market`: the spot market Kanon listed on Kuru's testnet, with its
 * book, for the app's spot screen. Public, like the venue's own market data:
 * no sign-in, nothing per-user.
 *
 * This process only reads. An order on that market is a transaction the
 * person's own wallet signs and sends; no key for it lives here.
 *
 * What the market is comes from the record the listing script wrote
 * (`@kanon/execution`, `kuru-listing.testnet.json`). With no record there is
 * no market, and the route says so: it never serves a guessed address or an
 * invented book. One read of the chain answers every caller for a few seconds.
 *
 * Like the order routes, every answer the screen is meant to show is HTTP 200
 * with a typed body, "not listed" and "could not be read" included.
 */

import type { KuruMarketView } from '@kanon/execution/kuru-market-view';
import type { Logger } from './log';

export const KURU_MARKET_PATH = '/kuru/market';

/** How long one read of the book answers for. */
export const KURU_BOOK_TTL_MS = 3_000;

export const KURU_MESSAGES = {
  notListed: 'No market is listed on Kuru from this deployment yet.',
  unreachable: "Kuru's order book could not be read just now. Trying again.",
} as const;

export type KuruMarketAnswer = KuruMarketView | { ok: false; code: 'not_listed' | 'unreachable'; message: string };

export interface KuruMarketRoute {
  get(): Promise<KuruMarketAnswer>;
}

export function createKuruMarketRoute(deps: {
  /** One read of the listed market, or null when nothing is listed. Rejects when the chain could not be read. */
  read: (() => Promise<KuruMarketView>) | null;
  log: Logger;
  ttlMs?: number;
  now?: () => number;
}): KuruMarketRoute {
  const { read, log } = deps;
  const ttlMs = deps.ttlMs ?? KURU_BOOK_TTL_MS;
  const now = deps.now ?? Date.now;
  let held: { at: number; view: KuruMarketView } | null = null;
  /** The read in flight, shared by every caller that arrives while it is out. */
  let reading: Promise<KuruMarketAnswer> | null = null;

  return {
    async get() {
      if (!read) return { ok: false, code: 'not_listed', message: KURU_MESSAGES.notListed };
      if (held && now() - held.at < ttlMs) return held.view;
      reading ??= read()
        .then((view): KuruMarketAnswer => {
          held = { at: now(), view };
          return view;
        })
        .catch((err: unknown): KuruMarketAnswer => {
          log({ level: 'warn', event: 'kuru_market_unreadable', error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
          // Not the last good book: a price that may have moved is not shown as the price.
          return { ok: false, code: 'unreachable', message: KURU_MESSAGES.unreachable };
        })
        .finally(() => {
          reading = null;
        });
      return await reading;
    },
  };
}
