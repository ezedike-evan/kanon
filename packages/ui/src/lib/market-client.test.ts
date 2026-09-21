import { describe, expect, it } from 'vitest';
import {
  MarketError,
  firstMismatch,
  marketAvailability,
  resolveMarketAddress,
  stakeToWei,
  thresholdInSeriesUnits,
  unavailableMarketClient,
  type ChainMarketFields,
  type OnChainTerms,
} from './market-client';

const ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

describe('resolveMarketAddress', () => {
  it('reads the env value when it is an address', () => {
    expect(resolveMarketAddress({ env: ADDR })).toBe(ADDR);
  });

  it('never guesses: a malformed env value is absent', () => {
    expect(resolveMarketAddress({ env: '0x123' })).toBeUndefined();
    expect(resolveMarketAddress({ env: '' })).toBeUndefined();
    expect(resolveMarketAddress({ env: undefined })).toBeUndefined();
  });

  it('reads ThresholdMarket from a deployments file, flat or nested', () => {
    expect(resolveMarketAddress({ deployments: { ThresholdMarket: ADDR } })).toBe(ADDR);
    expect(resolveMarketAddress({ deployments: { contracts: { ThresholdMarket: ADDR } } })).toBe(ADDR);
    expect(resolveMarketAddress({ deployments: { ThresholdMarket: { address: ADDR } } })).toBe(ADDR);
  });

  it('env wins over the deployments file', () => {
    expect(resolveMarketAddress({ env: OTHER, deployments: { ThresholdMarket: ADDR } })).toBe(OTHER);
  });

  it('ignores a deployments file with no market in it, or the registry only', () => {
    expect(resolveMarketAddress({ deployments: { StrategyRegistry: ADDR } })).toBeUndefined();
    expect(resolveMarketAddress({ deployments: null })).toBeUndefined();
  });
});

describe('marketAvailability', () => {
  it('says not deployed before it says anything about a wallet', () => {
    const a = marketAvailability({ marketAddress: undefined, hasWallet: false });
    expect(a.state).toBe('not_deployed');
    expect('message' in a && a.message).toMatch(/not deployed/i);
  });
  it('says no wallet when there is a contract and no signer', () => {
    expect(marketAvailability({ marketAddress: ADDR, hasWallet: false }).state).toBe('no_wallet');
  });
  it('is ready only with both', () => {
    expect(marketAvailability({ marketAddress: ADDR, hasWallet: true })).toEqual({ state: 'ready' });
  });
});

describe('unavailableMarketClient', () => {
  it('refuses to stake, with a code the card can word honestly', async () => {
    const c = unavailableMarketClient({ marketAddress: undefined, hasWallet: true });
    expect(c.availability().state).toBe('not_deployed');
    await expect(c.takeSide({ chainMarketId: '0', yes: true, stake: { atoms: '1', decimals: 18 } })).rejects.toMatchObject({
      name: 'MarketError',
      code: 'not_deployed',
    });
    await expect(
      c.ensureMarket({
        asset: 'BTC/USD',
        direction: 'above',
        thresholdPrice: { atoms: '1', decimals: 0 },
        windowStart: 1,
        windowEnd: 2,
        bucketSeconds: 900,
      }),
    ).rejects.toBeInstanceOf(MarketError);
  });

  it('reports no_wallet when the contract exists but there is no signer', async () => {
    const c = unavailableMarketClient({ marketAddress: ADDR, hasWallet: false });
    await expect(c.takeSide({ chainMarketId: '0', yes: false, stake: { atoms: '1', decimals: 18 } })).rejects.toMatchObject({
      code: 'no_wallet',
    });
  });
});

describe('thresholdInSeriesUnits', () => {
  it('scales a threshold up to a series at 8 decimals, exactly', () => {
    expect(thresholdInSeriesUnits({ atoms: '68755', decimals: 0 }, -8)).toBe(6_875_500_000_000n);
    expect(thresholdInSeriesUnits({ atoms: '34342', decimals: 1 }, -8)).toBe(343_420_000_000n);
  });

  it('refuses a threshold the series cannot hold without rounding', () => {
    expect(thresholdInSeriesUnits({ atoms: '123456789', decimals: 9 }, -8)).toBeNull();
  });

  it('handles a series scaled in tens', () => {
    expect(thresholdInSeriesUnits({ atoms: '1240800', decimals: 0 }, 2)).toBe(12_408n);
    expect(thresholdInSeriesUnits({ atoms: '1240850', decimals: 0 }, 2)).toBeNull();
  });

  it('refuses zero, negative and a non-integer scale', () => {
    expect(thresholdInSeriesUnits({ atoms: '0', decimals: 2 }, -8)).toBeNull();
    expect(thresholdInSeriesUnits({ atoms: '-5', decimals: 0 }, -8)).toBeNull();
    expect(thresholdInSeriesUnits({ atoms: '5', decimals: 0 }, -8.5)).toBeNull();
  });
});

describe('stakeToWei', () => {
  it('is the native unit at 18 decimals', () => {
    expect(stakeToWei({ atoms: '10000000000000000', decimals: 18 })).toBe(10n ** 16n);
    expect(stakeToWei({ atoms: '1', decimals: 2 })).toBe(10n ** 16n);
  });
  it('refuses zero, negative and finer-than-a-wei', () => {
    expect(stakeToWei({ atoms: '0', decimals: 18 })).toBeNull();
    expect(stakeToWei({ atoms: '-1', decimals: 18 })).toBeNull();
  });
});

describe('firstMismatch', () => {
  const terms: OnChainTerms = {
    asset: 'BTC/USD',
    direction: 'above',
    thresholdPrice: { atoms: '68755', decimals: 0 },
    windowStart: 1_000,
    windowEnd: 5_000,
    bucketSeconds: 900,
  };
  const chain: ChainMarketFields = {
    seriesContract: ADDR,
    thresholdPrice: 6_875_500_000_000n,
    above: true,
    windowStart: 1_000n,
    windowEnd: 5_000n,
    settled: false,
  };
  const args = { terms, seriesAddress: ADDR.toUpperCase().replace('0X', '0x'), thresholdUnits: 6_875_500_000_000n };

  it('accepts a market that matches in every field, whatever the address casing', () => {
    expect(firstMismatch({ chain, ...args })).toBeNull();
  });

  it.each([
    ['series', { seriesContract: OTHER }],
    ['threshold', { thresholdPrice: 6_875_500_000_001n }],
    ['direction', { above: false }],
    ['start', { windowStart: 1_001n }],
    ['end', { windowEnd: 5_001n }],
    ['settled', { settled: true }],
  ])('refuses a market whose %s differs', (_name, change) => {
    expect(firstMismatch({ chain: { ...chain, ...change }, ...args })).not.toBeNull();
  });
});
