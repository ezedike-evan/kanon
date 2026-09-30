import { describe, expect, it } from 'vitest';
import { RULE_04, predicatesCommitment, specHash, type StrategySpec, stated } from '@kanon/spec';
import {
  PinError,
  buildPinTarget,
  normalizeAsset,
  pinAvailability,
  resolveRegistryAddress,
  resolveSeriesMap,
  unavailablePinClient,
  type PinTarget,
} from './pin';

const ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const SERIES_BTC = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';
const SERIES_ETH = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707';
const TARGET: PinTarget = {
  specHash: `0x${'ab'.repeat(32)}`,
  predicatesCommitment: `0x${'cd'.repeat(32)}`,
  series: SERIES_BTC,
};

describe('resolveRegistryAddress', () => {
  it('reads the env value when it is an address', () => {
    expect(resolveRegistryAddress({ env: ADDR })).toBe(ADDR);
  });

  it('never guesses: a malformed env value is absent', () => {
    expect(resolveRegistryAddress({ env: '0x123' })).toBeUndefined();
    expect(resolveRegistryAddress({ env: '' })).toBeUndefined();
    expect(resolveRegistryAddress({ env: undefined })).toBeUndefined();
    expect(resolveRegistryAddress({ env: 'not-an-address' })).toBeUndefined();
  });

  it('falls back to a deployments file, in either shape it may be written', () => {
    expect(resolveRegistryAddress({ deployments: { StrategyRegistry: ADDR } })).toBe(ADDR);
    expect(resolveRegistryAddress({ deployments: { contracts: { StrategyRegistry: ADDR } } })).toBe(ADDR);
    expect(resolveRegistryAddress({ deployments: { StrategyRegistry: { address: ADDR } } })).toBe(ADDR);
  });

  it('env wins over the deployments file', () => {
    expect(resolveRegistryAddress({ env: OTHER, deployments: { StrategyRegistry: ADDR } })).toBe(OTHER);
  });

  it('ignores a deployments file with no registry in it', () => {
    expect(resolveRegistryAddress({ deployments: { CanonicalSeries: ADDR } })).toBeUndefined();
    expect(resolveRegistryAddress({ deployments: null })).toBeUndefined();
  });
});

describe('pinAvailability', () => {
  it('is not deployed before anything else, and says the draft is saved', () => {
    const a = pinAvailability({ registryAddress: undefined, hasWallet: true });
    expect(a.state).toBe('not_deployed');
    expect('message' in a && a.message).toMatch(/not deployed/i);
  });

  it('needs a wallet once there is a registry', () => {
    expect(pinAvailability({ registryAddress: ADDR, hasWallet: false }).state).toBe('no_wallet');
  });

  it('is ready only with both', () => {
    expect(pinAvailability({ registryAddress: ADDR, hasWallet: true })).toEqual({ state: 'ready' });
  });
});

describe('unavailablePinClient', () => {
  it('reports the same state as the availability function', () => {
    const c = unavailablePinClient({ registryAddress: undefined, hasWallet: false });
    expect(c.availability().state).toBe('not_deployed');
    expect(c.chainId).toBe(143);
    expect(c.nativeSymbol).toBe('MON');
  });

  it('refuses to pin with a typed error, never returning a receipt', async () => {
    const c = unavailablePinClient({ registryAddress: undefined, hasWallet: false });
    await expect(c.pin(TARGET)).rejects.toBeInstanceOf(PinError);
    await expect(c.pin(TARGET)).rejects.toMatchObject({ code: 'not_deployed' });
    await expect(c.readMinBond()).rejects.toMatchObject({ code: 'not_deployed' });
  });

  it('names a missing wallet, when the registry exists', async () => {
    const c = unavailablePinClient({ registryAddress: ADDR, hasWallet: false });
    await expect(c.tighten('0', TARGET, { old: [], next: [] })).rejects.toMatchObject({ code: 'no_wallet' });
    await expect(c.finalizeLoosening('0')).rejects.toMatchObject({ code: 'no_wallet' });
  });
});

describe('resolveSeriesMap', () => {
  it('reads CanonicalSeries<BASE>USD keys from a deployments file', () => {
    const map = resolveSeriesMap({
      deployments: {
        CanonicalSeriesBTCUSD: SERIES_BTC,
        CanonicalSeriesETHUSD: SERIES_ETH,
        StrategyRegistry: OTHER,
        chainId: 143,
      },
    });
    expect(map['BTC/USD']).toEqual({ address: SERIES_BTC });
    expect(map['ETH/USD']).toEqual({ address: SERIES_ETH });
    expect(Object.keys(map)).toHaveLength(2);
  });

  it('keeps cadence and bucket where the deployment records them', () => {
    const map = resolveSeriesMap({
      deployments: { CanonicalSeriesBTCUSD: { address: SERIES_BTC, cadenceSeconds: 60, bucketSeconds: 900 } },
    });
    expect(map['BTC/USD']).toEqual({ address: SERIES_BTC, cadenceSeconds: 60, bucketSeconds: 900 });
  });

  it('env wins, keyed by normalised asset, and a malformed address is absent', () => {
    const map = resolveSeriesMap({
      env: { 'btc / usd': OTHER, 'ETH/USD': 'nope', 'SOL/USD': undefined },
      deployments: { CanonicalSeriesBTCUSD: SERIES_BTC },
    });
    expect(map['BTC/USD']?.address).toBe(OTHER);
    expect(map['ETH/USD']).toBeUndefined();
    expect(map['SOL/USD']).toBeUndefined();
  });

  it('is empty when nothing is configured', () => {
    expect(resolveSeriesMap({})).toEqual({});
    expect(normalizeAsset(' btc / usd ')).toBe('BTC/USD');
  });
});

describe('buildPinTarget', () => {
  it('derives the hash, the predicates commitment and the series address from the spec', async () => {
    const out = await buildPinTarget(RULE_04, { 'BTC/USD': { address: SERIES_BTC } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target.specHash).toBe(await specHash(RULE_04));
    expect(out.target.predicatesCommitment).toBe(predicatesCommitment(RULE_04));
    expect(out.target.predicatesCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.target.series).toBe(SERIES_BTC);
  });

  it('is not deployed when no series is configured for the spec asset', async () => {
    const out = await buildPinTarget(RULE_04, { 'ETH/USD': { address: SERIES_ETH } });
    expect(out).toMatchObject({ ok: false, reason: 'series_not_deployed' });
    expect(!out.ok && out.message).toMatch(/no canonical series is deployed for BTC\/USD/i);
    expect(await buildPinTarget(RULE_04, {})).toMatchObject({ ok: false, reason: 'series_not_deployed' });
  });

  it('is not deployed when the deployed series has a different cadence or bucket', async () => {
    const wrongBucket = await buildPinTarget(RULE_04, {
      'BTC/USD': { address: SERIES_BTC, cadenceSeconds: 60, bucketSeconds: 3600 },
    });
    expect(wrongBucket).toMatchObject({ ok: false, reason: 'series_not_deployed' });
    const wrongCadence = await buildPinTarget(RULE_04, {
      'BTC/USD': { address: SERIES_BTC, cadenceSeconds: 30 },
    });
    expect(wrongCadence).toMatchObject({ ok: false, reason: 'series_not_deployed' });
    const right = await buildPinTarget(RULE_04, {
      'BTC/USD': { address: SERIES_BTC, cadenceSeconds: 60, bucketSeconds: 900 },
    });
    expect(right.ok).toBe(true);
  });

  it('refuses a spec the gate cannot encode: a predicate on a timeframe other than the bucket', async () => {
    const mixed: StrategySpec = {
      ...RULE_04,
      predicates: [
        { ...RULE_04.predicates[0]!, timeframe: stated('1h') } as StrategySpec['predicates'][number],
        ...RULE_04.predicates.slice(1),
      ],
    };
    const out = await buildPinTarget(mixed, { 'BTC/USD': { address: SERIES_BTC } });
    expect(out).toMatchObject({ ok: false, reason: 'unencodable' });
    expect(!out.ok && out.message).toMatch(/does not match the series bucket/);
  });

  it('changing a parameter changes the commitment as well as the hash', async () => {
    const tighter: StrategySpec = {
      ...RULE_04,
      predicates: RULE_04.predicates.map((p) =>
        p.kind === 'fair_value_gap' ? { ...p, minGapBps: stated(30) } : p,
      ),
    };
    const a = await buildPinTarget(RULE_04, { 'BTC/USD': { address: SERIES_BTC } });
    const b = await buildPinTarget(tighter, { 'BTC/USD': { address: SERIES_BTC } });
    expect(a.ok && b.ok && a.target.predicatesCommitment !== b.target.predicatesCommitment).toBe(true);
    expect(a.ok && b.ok && a.target.specHash !== b.target.specHash).toBe(true);
  });
});
