import { describe, expect, it } from 'vitest';
import { assertPublicEnv, describePublicEnvProblems, validatePublicEnv, type PublicEnvInput } from './public-env';

const ADDR = '0x' + 'ab'.repeat(20);
const good: PublicEnvInput = {
  convexUrl: 'https://happy-otter-123.convex.cloud',
  privyAppId: 'clx1234567890',
  privyClientId: 'client-1234567',
  chainId: '10143',
  registryAddress: ADDR,
  thresholdMarketAddress: ADDR,
  vaultChainId: '10143',
  vaultRpcUrl: 'https://testnet-rpc.monad.xyz',
  vaultFactoryAddress: ADDR,
  vaultCollateralAddress: ADDR,
  vaultStartBlock: '12345',
  vaultCollateralDecimals: '6',
};
const empty: PublicEnvInput = Object.fromEntries(Object.keys(good).map((k) => [k, undefined])) as unknown as PublicEnvInput;
const web = { platform: 'web', requireCore: true } as const;
const mobile = { platform: 'mobile', requireCore: true } as const;

describe('validatePublicEnv', () => {
  it('accepts a complete env', () => {
    expect(validatePublicEnv(good, web)).toEqual([]);
    expect(validatePublicEnv(good, mobile)).toEqual([]);
  });

  it('needs only the core values; the rest are optional features', () => {
    const r = validatePublicEnv({ ...empty, convexUrl: good.convexUrl, privyAppId: good.privyAppId }, web);
    expect(r).toEqual([]);
  });

  it('names every missing core variable for the platform', () => {
    expect(validatePublicEnv(empty, web).map((p) => p.name)).toEqual(['NEXT_PUBLIC_CONVEX_URL', 'NEXT_PUBLIC_PRIVY_APP_ID']);
    expect(validatePublicEnv(empty, mobile).map((p) => p.name)).toEqual([
      'EXPO_PUBLIC_CONVEX_URL',
      'EXPO_PUBLIC_PRIVY_APP_ID',
      'EXPO_PUBLIC_PRIVY_CLIENT_ID',
    ]);
  });

  it('skips the core requirement for a server-side build but still checks what is set', () => {
    expect(validatePublicEnv(empty, { platform: 'web', requireCore: false })).toEqual([]);
    expect(validatePublicEnv({ ...empty, convexUrl: 'nope' }, { platform: 'web', requireCore: false })).toHaveLength(1);
  });

  it('rejects malformed optional values by name', () => {
    const r = validatePublicEnv(
      { ...good, chainId: 'mainnet', registryAddress: '0x12', vaultRpcUrl: 'ftp://x', vaultStartBlock: '-1', vaultCollateralDecimals: '99' },
      web,
    );
    expect(r.map((p) => p.name)).toEqual([
      'NEXT_PUBLIC_CHAIN_ID',
      'NEXT_PUBLIC_REGISTRY_ADDRESS',
      'NEXT_PUBLIC_VAULT_RPC_URL',
      'NEXT_PUBLIC_VAULT_START_BLOCK',
      'NEXT_PUBLIC_VAULT_COLLATERAL_DECIMALS',
    ]);
  });

  it('treats blank as unset', () => {
    expect(validatePublicEnv({ ...good, chainId: '  ', registryAddress: '' }, web)).toEqual([]);
  });
});

describe('assertPublicEnv', () => {
  it('throws one readable error and never includes a value', () => {
    let message = '';
    try {
      assertPublicEnv({ ...good, convexUrl: 'https://user:hunter2@host', chainId: 'hunter2' }, web);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('NEXT_PUBLIC_CHAIN_ID');
    expect(message).not.toContain('hunter2');
  });

  it('does not throw for a good env', () => {
    expect(() => assertPublicEnv(good, web)).not.toThrow();
  });

  it('formats a list', () => {
    expect(describePublicEnvProblems([{ name: 'A', expected: 'x' }])).toContain('A: expected x');
  });
});
