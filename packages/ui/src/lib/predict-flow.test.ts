import { describe, expect, it, vi } from 'vitest';
import { parseDecimal, type MarketSide } from '@kanon/spec';
import {
  MarketError,
  type EnsuredMarket,
  type MarketClient,
  type OnChainTerms,
} from './market-client';
import { onChainTerms, takeMarketSide, type PredictActions } from './predict-flow';
import type { PredictMarket } from './predict-types';

const NOW = 1_800_000_000;
const TX = `0x${'cd'.repeat(32)}`;
const OPEN_TX = `0x${'ef'.repeat(32)}`;
const MARKET_ADDR = '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6';
const STAKE = { atoms: '10000000000000000', decimals: 18 };

const market = (over: Partial<PredictMarket> = {}): PredictMarket => ({
  id: 'm1',
  asset: 'BTC/USD',
  assetClass: 'CRYPTO',
  timeframe: '4H',
  direction: 'above',
  target: { atoms: '68755', decimals: 0 },
  price: parseDecimal('68412.34', 8),
  priceAt: NOW - 60,
  windowStart: NOW + 600,
  windowEnd: NOW + 15_000,
  status: 'open',
  crossed: null,
  terms: {
    offsetBps: 50,
    distanceBps: 50,
    significantDigits: 5,
    referencePrice: parseDecimal('68412.34', 8),
    referenceAt: NOW - 60,
    windowSeconds: 14_400,
    bucketSeconds: 900,
    feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  },
  termsHash: `0x${'aa'.repeat(32)}`,
  settlement: null,
  positions: [],
  chain: null,
  demo: false,
  ...over,
});

function harness(opts: {
  availability?: MarketClient['availability'];
  ensure?: (t: OnChainTerms, linked?: unknown) => Promise<EnsuredMarket>;
  take?: MarketClient['takeSide'];
  link?: PredictActions['linkChainMarket'];
  record?: PredictActions['recordPosition'];
} = {}) {
  const ensureMarket = vi.fn(
    opts.ensure ??
      (async () => ({ chainId: 143, address: MARKET_ADDR, marketId: '7', txHash: OPEN_TX, opened: true })),
  );
  const takeSide = vi.fn(opts.take ?? (async () => ({ txHash: TX })));
  const client: MarketClient = {
    chainId: 143,
    marketAddress: MARKET_ADDR,
    nativeSymbol: 'MON',
    availability: opts.availability ?? (() => ({ state: 'ready' })),
    ensureMarket: ensureMarket as never,
    takeSide,
    hasCrossed: async () => false,
  };
  const linkChainMarket = vi.fn(
    opts.link ??
      (async (a: { chainMarketId: string; txHash: string }) => ({
        linked: true,
        chain: { chainId: 143, address: MARKET_ADDR, marketId: a.chainMarketId, txHash: a.txHash },
      })),
  );
  const recordPosition = vi.fn(opts.record ?? (async () => 'p1'));
  const actions: PredictActions = { linkChainMarket, recordPosition };
  return { client, actions, ensureMarket, takeSide, linkChainMarket, recordPosition };
}

const run = (h: ReturnType<typeof harness>, over: Partial<Parameters<typeof takeMarketSide>[0]> = {}) =>
  takeMarketSide({
    market: market(),
    side: 'above',
    stake: STAKE,
    nowSeconds: NOW,
    userId: 'u1',
    client: h.client,
    actions: h.actions,
    ...over,
  });

describe('onChainTerms', () => {
  it('hands the chain exactly what the card shows', () => {
    expect(onChainTerms(market())).toEqual({
      asset: 'BTC/USD',
      direction: 'above',
      thresholdPrice: { atoms: '68755', decimals: 0 },
      windowStart: NOW + 600,
      windowEnd: NOW + 15_000,
      bucketSeconds: 900,
    });
  });
});

describe('takeMarketSide', () => {
  it('opens the market, links it, stakes, and records the position, in that order', async () => {
    const order: string[] = [];
    const h = harness({
      ensure: async () => {
        order.push('ensure');
        return { chainId: 143, address: MARKET_ADDR, marketId: '7', txHash: OPEN_TX, opened: true };
      },
      link: async (a) => {
        order.push('link');
        return { linked: true, chain: { chainId: 143, address: MARKET_ADDR, marketId: a.chainMarketId, txHash: a.txHash } };
      },
      take: async () => {
        order.push('take');
        return { txHash: TX };
      },
      record: async () => {
        order.push('record');
      },
    });
    const r = await run(h);
    expect(r).toEqual({ ok: true, txHash: TX, recorded: true });
    expect(order).toEqual(['ensure', 'link', 'take', 'record']);
    expect(h.recordPosition).toHaveBeenCalledWith({ marketId: 'm1', side: 'above', stake: STAKE, txHash: TX });
  });

  it('does not link a market it did not open', async () => {
    const h = harness({
      ensure: async () => ({ chainId: 143, address: MARKET_ADDR, marketId: '3', txHash: OPEN_TX, opened: false }),
    });
    const linked = { chainId: 143, address: MARKET_ADDR, marketId: '3', txHash: OPEN_TX };
    const r = await run(h, { market: market({ chain: linked }) });
    expect(r.ok).toBe(true);
    expect(h.linkChainMarket).not.toHaveBeenCalled();
    expect(h.ensureMarket).toHaveBeenCalledWith(expect.anything(), linked);
  });

  describe('sides', () => {
    it.each([
      ['above', 'above', true],
      ['above', 'below', false],
      ['below', 'below', true],
      ['below', 'above', false],
    ] as const)('on a %s market, side %s stakes YES=%s', async (direction, side, yes) => {
      const h = harness();
      await run(h, { market: market({ direction }), side: side as MarketSide });
      expect(h.takeSide).toHaveBeenCalledWith({ chainMarketId: '7', yes, stake: STAKE });
    });
  });

  describe('closed and unavailable, before any wallet is asked', () => {
    it('refuses a demo card', async () => {
      const h = harness();
      const r = await run(h, { market: market({ demo: true }) });
      expect(r).toMatchObject({ ok: false, reason: 'demo' });
      expect(h.ensureMarket).not.toHaveBeenCalled();
    });

    it('refuses without a signed-in user', async () => {
      const h = harness();
      expect(await run(h, { userId: undefined })).toMatchObject({ ok: false, reason: 'no_user' });
      expect(h.ensureMarket).not.toHaveBeenCalled();
    });

    it('refuses a market that is missing', async () => {
      const h = harness();
      expect(await run(h, { market: undefined })).toMatchObject({ ok: false, reason: 'closed' });
    });

    it('refuses a stake of zero or one finer than a wei', async () => {
      const h = harness();
      expect(await run(h, { stake: { atoms: '0', decimals: 18 } })).toMatchObject({ ok: false, reason: 'invalid_stake' });
      expect(await run(h, { stake: { atoms: '-1', decimals: 18 } })).toMatchObject({ ok: false, reason: 'invalid_stake' });
      expect(h.ensureMarket).not.toHaveBeenCalled();
    });

    it('refuses at the second the window ends, as the contract does', async () => {
      const h = harness();
      const m = market({ windowEnd: NOW });
      expect(await run(h, { market: m })).toMatchObject({ ok: false, reason: 'closed' });
      expect(await run(h, { market: market({ windowEnd: NOW + 1 }) })).toMatchObject({ ok: true });
    });

    it('refuses a market whose threshold has already been touched', async () => {
      const h = harness();
      const m = market({ crossed: { price: parseDecimal('68801.00', 2), at: NOW - 100 } });
      expect(await run(h, { market: m })).toMatchObject({ ok: false, reason: 'closed' });
    });

    it('refuses a settled market', async () => {
      const h = harness();
      expect(await run(h, { market: market({ status: 'settled' }) })).toMatchObject({ ok: false, reason: 'closed' });
      expect(h.ensureMarket).not.toHaveBeenCalled();
    });

    it('carries the honest reason when nothing is deployed', async () => {
      const h = harness({
        availability: () => ({ state: 'not_deployed', message: 'The ThresholdMarket contract is not deployed on this network yet.' }),
      });
      const r = await run(h);
      expect(r).toMatchObject({ ok: false, reason: 'not_deployed' });
      expect('message' in r && r.message).toMatch(/not deployed/);
      expect(h.ensureMarket).not.toHaveBeenCalled();
    });

    it('carries no_wallet as its own reason', async () => {
      const h = harness({ availability: () => ({ state: 'no_wallet', message: 'No wallet.' }) });
      expect(await run(h)).toMatchObject({ ok: false, reason: 'no_wallet' });
    });
  });

  describe('when the chain or the wallet says no', () => {
    it('reports a mismatch and stakes nothing', async () => {
      const h = harness({
        ensure: async () => {
          throw new MarketError('mismatch', 'The on-chain market does not match the card.');
        },
      });
      const r = await run(h, {
        market: market({ chain: { chainId: 143, address: MARKET_ADDR, marketId: '3', txHash: OPEN_TX } }),
      });
      expect(r).toMatchObject({ ok: false, reason: 'mismatch' });
      expect(h.takeSide).not.toHaveBeenCalled();
      expect(h.recordPosition).not.toHaveBeenCalled();
    });

    it('reports a declined signature and records nothing', async () => {
      const h = harness({
        take: async () => {
          throw new MarketError('rejected', 'The signature was declined. Nothing was staked.');
        },
      });
      expect(await run(h)).toMatchObject({ ok: false, reason: 'rejected' });
      expect(h.recordPosition).not.toHaveBeenCalled();
    });

    it('carries a crossed market as closed, in plain words, not as a failure', async () => {
      const h = harness({
        take: async () => {
          throw new MarketError('crossed', 'Closed: threshold already crossed');
        },
      });
      expect(await run(h)).toEqual({ ok: false, reason: 'crossed', message: 'Closed: threshold already crossed' });
      expect(h.recordPosition).not.toHaveBeenCalled();
    });

    it('carries a stale series as a wait for a fresh price', async () => {
      const h = harness({
        take: async () => {
          throw new MarketError('stale', 'Waiting for a fresh price');
        },
      });
      expect(await run(h)).toEqual({ ok: false, reason: 'stale', message: 'Waiting for a fresh price' });
      expect(h.recordPosition).not.toHaveBeenCalled();
    });

    it('words an unknown error as failed', async () => {
      const h = harness({
        take: async () => {
          throw new Error('nonce too low');
        },
      });
      expect(await run(h)).toMatchObject({ ok: false, reason: 'failed', message: 'nonce too low' });
    });
  });

  describe('linking races', () => {
    it('stakes on the winner\'s market, after checking it, when someone linked first', async () => {
      const winner = { chainId: 143, address: MARKET_ADDR, marketId: '4', txHash: OPEN_TX };
      let calls = 0;
      const h = harness({
        ensure: async (_t, linked) => {
          calls += 1;
          if (calls === 1) return { chainId: 143, address: MARKET_ADDR, marketId: '7', txHash: OPEN_TX, opened: true };
          expect(linked).toEqual(winner);
          return { ...winner, opened: false };
        },
        link: async () => ({ linked: false, chain: winner }),
      });
      const r = await run(h);
      expect(r).toMatchObject({ ok: true });
      expect(h.takeSide).toHaveBeenCalledWith(expect.objectContaining({ chainMarketId: '4' }));
    });

    it('refuses when the winner\'s market does not match the terms', async () => {
      const h = harness({
        ensure: async (_t, linked) => {
          if (!linked) return { chainId: 143, address: MARKET_ADDR, marketId: '7', txHash: OPEN_TX, opened: true };
          throw new MarketError('mismatch', 'The on-chain market does not match the card.');
        },
        link: async () => ({
          linked: false,
          chain: { chainId: 143, address: MARKET_ADDR, marketId: '4', txHash: OPEN_TX },
        }),
      });
      expect(await run(h)).toMatchObject({ ok: false, reason: 'mismatch' });
      expect(h.takeSide).not.toHaveBeenCalled();
    });

    it('still stakes on its own market when the link could not be saved', async () => {
      const h = harness({
        link: async () => {
          throw new Error('offline');
        },
      });
      const r = await run(h);
      expect(r).toMatchObject({ ok: true });
      expect(h.takeSide).toHaveBeenCalledWith(expect.objectContaining({ chainMarketId: '7' }));
    });
  });

  it('says so when the chain took the stake but the app could not save it', async () => {
    const h = harness({
      record: async () => {
        throw new Error('convex down');
      },
    });
    expect(await run(h)).toEqual({ ok: true, txHash: TX, recorded: false });
  });
});
