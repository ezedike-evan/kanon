import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { resolveExecutionConfig } from './config';
import { PaperExecutionClient } from './paper';
import { PerplClient } from './perpl';
import { VenueRouter, createVenueRouterFromEnv } from './router';
import type { ExecutionClient } from './types';

const HEX32 = 'ab'.repeat(32);
const EVM_KEY = '0x' + 'cd'.repeat(32);

function stubClient(venue: 'perpl' | 'kuru'): ExecutionClient {
  return {
    venue,
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getPosition: vi.fn(),
    subscribeMarketData: vi.fn(),
  } as unknown as ExecutionClient;
}

describe('VenueRouter', () => {
  const paper = new PaperExecutionClient();
  const perpl = stubClient('perpl');
  const kuru = stubClient('kuru');

  function router(mode: 'paper' | 'live') {
    return new VenueRouter({
      paper,
      perpl: { network: 'mainnet', mode, client: perpl },
      kuru: { network: 'mainnet', mode, client: kuru },
    });
  }

  it('routes perps to Perpl for every documented market', () => {
    for (const asset of ['BTC/USD', 'ETH/USD', 'SOL/USD', 'MON/USD']) {
      const d = router('live').route({ asset, instrument: 'perp', side: 'buy' });
      expect(d).toMatchObject({ ok: true, venue: 'perpl', mode: 'live', client: perpl });
    }
  });

  it('routes spot to Kuru: MON/USD to the AUSD market by default', () => {
    const d = router('live').route({ asset: 'MON/USD', instrument: 'spot', side: 'buy' });
    expect(d).toMatchObject({ ok: true, venue: 'kuru', venueAsset: 'MON/AUSD', client: kuru });
  });

  it('honours the configured Kuru quote and an explicit market symbol', () => {
    const r = new VenueRouter({
      paper,
      perpl: { network: 'mainnet', mode: 'paper' },
      kuru: { network: 'mainnet', mode: 'paper', quote: 'USDC' },
    });
    expect(r.route({ asset: 'MON/USD', instrument: 'spot', side: 'buy' })).toMatchObject({ ok: true, venueAsset: 'MON/USDC' });
    expect(r.route({ asset: 'MON/AUSD', instrument: 'spot', side: 'buy' })).toMatchObject({ ok: true, venueAsset: 'MON/AUSD' });
  });

  it('refuses an asset with no Perpl market, naming what Perpl does list', () => {
    const d = router('live').route({ asset: 'AVAX/USD', instrument: 'perp', side: 'buy' });
    expect(d).toMatchObject({ ok: false, code: 'no_perp_market' });
    if (!d.ok) expect(d.reason).toContain('BTC, MON, ETH, SOL, HYPE, ZEC');
  });

  it('refuses BTC spot: Kuru has no such market and none is guessed', () => {
    const d = router('live').route({ asset: 'BTC/USD', instrument: 'spot', side: 'buy' });
    expect(d).toMatchObject({ ok: false, code: 'no_spot_market' });
    if (!d.ok) expect(d.reason).toContain('never guessed');
  });

  it('refuses opening a short on spot but accepts a spot sell that closes', () => {
    const open = router('live').route({ asset: 'MON/USD', instrument: 'spot', side: 'sell' });
    expect(open).toMatchObject({ ok: false, code: 'spot_short_unsupported' });
    const close = router('live').route({ asset: 'MON/USD', instrument: 'spot', side: 'sell', reduceOnly: true });
    expect(close.ok).toBe(true);
  });

  it('refuses an unknown instrument', () => {
    // @ts-expect-error deliberately invalid
    expect(router('live').route({ asset: 'BTC/USD', instrument: 'option', side: 'buy' })).toMatchObject({ ok: false, code: 'unknown_instrument' });
  });

  it('applies identical rules in paper mode, only the client differs', () => {
    const r = router('paper');
    expect(r.route({ asset: 'BTC/USD', instrument: 'spot', side: 'buy' }).ok).toBe(false);
    expect(r.route({ asset: 'AVAX/USD', instrument: 'perp', side: 'buy' }).ok).toBe(false);
    const ok = r.route({ asset: 'BTC/USD', instrument: 'perp', side: 'buy' });
    expect(ok).toMatchObject({ ok: true, venue: 'perpl', mode: 'paper', client: paper });
  });

  it('fails loudly, not silently to paper, when a live venue has no client', () => {
    const r = new VenueRouter({ paper, perpl: { network: 'mainnet', mode: 'live' }, kuru: { network: 'mainnet', mode: 'paper' } });
    expect(() => r.route({ asset: 'BTC/USD', instrument: 'perp', side: 'buy' })).toThrow(/no live client/);
  });

  it('uses the testnet market table on testnet', () => {
    const r = new VenueRouter({ paper, perpl: { network: 'testnet', mode: 'paper' }, kuru: { network: 'testnet', mode: 'paper' } });
    expect(r.route({ asset: 'HYPE/USD', instrument: 'perp', side: 'buy' }).ok).toBe(false); // HYPE is mainnet-only
    expect(r.route({ asset: 'BTC/USD', instrument: 'perp', side: 'buy' }).ok).toBe(true);
    expect(r.route({ asset: 'MON/USD', instrument: 'spot', side: 'buy' }).ok).toBe(false); // testnet Kuru has only MON/USDC
  });
});

describe('resolveExecutionConfig', () => {
  it('defaults to paper with nothing set', () => {
    const cfg = resolveExecutionConfig({});
    expect(cfg.requestedMode).toBe('paper');
    expect(cfg.perpl.mode).toBe('paper');
    expect(cfg.kuru.mode).toBe('paper');
    expect(cfg.perpl.network).toBe('testnet');
    expect(cfg.warnings).toEqual([]);
  });

  it('stays paper when credentials exist but live was not requested', () => {
    const cfg = resolveExecutionConfig({ PERPL_API_KEY: 'k', PERPL_API_KEY_SECRET: HEX32, PERPL_ACCOUNT_ID: '7', KANON_KURU_PRIVATE_KEY: EVM_KEY });
    expect(cfg.perpl.mode).toBe('paper');
    expect(cfg.kuru.mode).toBe('paper');
    expect(cfg.perpl.credentials).toBeUndefined();
  });

  it('goes live per venue only when live is requested AND that venue has credentials', () => {
    const cfg = resolveExecutionConfig({
      KANON_EXECUTION_MODE: 'live',
      KANON_PERPL_NETWORK: 'mainnet',
      PERPL_API_KEY: 'k',
      PERPL_API_KEY_SECRET: HEX32,
      PERPL_ACCOUNT_ID: '7',
    });
    expect(cfg.perpl.mode).toBe('live');
    expect(cfg.perpl.credentials).toEqual({ apiKey: 'k', secretKeyHex: HEX32, accountId: 7 });
    expect(cfg.kuru.mode).toBe('paper');
    expect(cfg.warnings.join(' ')).toContain('spot stays in paper mode');
  });

  it('downgrades a live request with no credentials to paper and says so', () => {
    const cfg = resolveExecutionConfig({ KANON_EXECUTION_MODE: 'live' });
    expect(cfg.perpl.mode).toBe('paper');
    expect(cfg.kuru.mode).toBe('paper');
    expect(cfg.warnings).toHaveLength(2);
  });

  it('rejects half-set Perpl credentials instead of guessing', () => {
    expect(() => resolveExecutionConfig({ PERPL_API_KEY: 'k' })).toThrow(ZodError);
  });

  it('validates shapes: bad mode, bad secret, bad account id, bad private key', () => {
    expect(() => resolveExecutionConfig({ KANON_EXECUTION_MODE: 'yolo' })).toThrow(ZodError);
    expect(() => resolveExecutionConfig({ PERPL_API_KEY: 'k', PERPL_API_KEY_SECRET: 'nothex', PERPL_ACCOUNT_ID: '7' })).toThrow(ZodError);
    expect(() => resolveExecutionConfig({ PERPL_API_KEY: 'k', PERPL_API_KEY_SECRET: HEX32, PERPL_ACCOUNT_ID: '-3' })).toThrow(ZodError);
    expect(() => resolveExecutionConfig({ KANON_KURU_PRIVATE_KEY: '0x1234' })).toThrow(ZodError);
  });

  it('does not leak a secret into a validation error', () => {
    try {
      resolveExecutionConfig({ PERPL_API_KEY: 'k', PERPL_API_KEY_SECRET: 'super-secret-not-hex', PERPL_ACCOUNT_ID: '7' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(String(JSON.stringify((e as ZodError).issues))).not.toContain('super-secret-not-hex');
    }
  });

  it('reads the Kuru quote, margin flag, and slippage', () => {
    const cfg = resolveExecutionConfig({ KANON_KURU_QUOTE: 'USDC', KANON_KURU_USE_MARGIN: 'false', KANON_DEFAULT_MAX_SLIPPAGE_BPS: '25' });
    expect(cfg.kuru).toMatchObject({ quote: 'USDC', useMargin: false });
    expect(cfg.defaultMaxSlippageBps).toBe(25);
  });
});

describe('createVenueRouterFromEnv', () => {
  it('builds a paper router by default and never constructs a live client', async () => {
    const createPerplClient = vi.fn();
    const createKuruClient = vi.fn();
    const { router, config } = await createVenueRouterFromEnv({}, { createPerplClient, createKuruClient });
    expect(createPerplClient).not.toHaveBeenCalled();
    expect(createKuruClient).not.toHaveBeenCalled();
    expect(router.modes()).toEqual({ perpl: 'paper', kuru: 'paper' });
    expect(config.warnings).toEqual([]);
  });

  it('builds a live Perpl client from env credentials and leaves Kuru on paper', async () => {
    const { router } = await createVenueRouterFromEnv(
      {
        KANON_EXECUTION_MODE: 'live',
        PERPL_API_KEY: 'k',
        PERPL_API_KEY_SECRET: HEX32,
        PERPL_ACCOUNT_ID: '7',
      },
      { WebSocketImpl: class {} as unknown as typeof WebSocket },
    );
    expect(router.modes()).toEqual({ perpl: 'live', kuru: 'paper' });
    const d = router.route({ asset: 'BTC/USD', instrument: 'perp', side: 'buy' });
    expect(d.ok && d.client instanceof PerplClient).toBe(true);
  });

  it('builds a live Kuru client through the injected factory only when a key is present', async () => {
    const live = stubClient('kuru');
    const createKuruClient = vi.fn(async () => live);
    const { router } = await createVenueRouterFromEnv({ KANON_EXECUTION_MODE: 'live', KANON_KURU_NETWORK: 'mainnet', KANON_KURU_PRIVATE_KEY: EVM_KEY }, { createKuruClient });
    expect(createKuruClient).toHaveBeenCalledOnce();
    const d = router.route({ asset: 'MON/USD', instrument: 'spot', side: 'buy' });
    expect(d).toMatchObject({ ok: true, mode: 'live', client: live });
  });
});
