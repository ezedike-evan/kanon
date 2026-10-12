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

  it('takes the gateway address as optional, and as an http or https URL when set', () => {
    expect(validatePublicEnv({ ...good, gatewayUrl: undefined }, web)).toEqual([]);
    expect(validatePublicEnv({ ...good, gatewayUrl: '  ' }, web)).toEqual([]);
    expect(validatePublicEnv({ ...good, gatewayUrl: 'http://localhost:8787' }, web)).toEqual([]);
    expect(validatePublicEnv({ ...good, gatewayUrl: 'https://gateway.kanon.example/' }, mobile)).toEqual([]);
    // A build with no browser env still checks an address that was set.
    expect(validatePublicEnv({ ...empty, gatewayUrl: 'http://localhost:8787' }, { platform: 'web', requireCore: false })).toEqual([]);
    for (const bad of ['ws://localhost:8787', 'localhost:8787', '8787', 'not a url']) {
      expect(validatePublicEnv({ ...good, gatewayUrl: bad }, web), bad).toEqual([
        { name: 'NEXT_PUBLIC_GATEWAY_URL', expected: 'an http(s) URL' },
      ]);
      expect(validatePublicEnv({ ...empty, gatewayUrl: bad }, { platform: 'web', requireCore: false }), bad).toHaveLength(1);
    }
    expect(validatePublicEnv({ ...good, gatewayUrl: 'wss://x' }, mobile).map((p) => p.name)).toEqual(['EXPO_PUBLIC_GATEWAY_URL']);
  });

  it('takes the indexer address the same way: unset is fine, and a set one is an http or https URL', () => {
    expect(validatePublicEnv({ ...good, indexerUrl: undefined }, web)).toEqual([]);
    expect(validatePublicEnv({ ...good, indexerUrl: '' }, mobile)).toEqual([]);
    expect(validatePublicEnv({ ...good, indexerUrl: 'http://localhost:8080/v1/graphql' }, web)).toEqual([]);
    expect(validatePublicEnv({ ...good, indexerUrl: 'https://indexer.kanon.example/v1/graphql' }, mobile)).toEqual([]);
    expect(validatePublicEnv({ ...empty, indexerUrl: 'https://indexer.kanon.example/v1/graphql' }, { platform: 'web', requireCore: false })).toEqual([]);
    for (const bad of ['indexer.kanon.example/v1/graphql', 'wss://indexer.kanon.example', 'not a url']) {
      expect(validatePublicEnv({ ...good, indexerUrl: bad }, web), bad).toEqual([
        { name: 'NEXT_PUBLIC_INDEXER_URL', expected: 'an http(s) URL' },
      ]);
    }
    expect(validatePublicEnv({ ...good, indexerUrl: 'ftp://x' }, mobile).map((p) => p.name)).toEqual(['EXPO_PUBLIC_INDEXER_URL']);
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
    expect(() => assertPublicEnv({ ...good, gatewayUrl: 'ftp://user:hunter2@host' }, web)).toThrow(/NEXT_PUBLIC_GATEWAY_URL: expected an http\(s\) URL/);
    expect(() => assertPublicEnv({ ...good, gatewayUrl: 'ftp://user:hunter2@host' }, web)).not.toThrow(/hunter2/);
  });

  it('does not throw for a good env', () => {
    expect(() => assertPublicEnv(good, web)).not.toThrow();
  });

  it('formats a list', () => {
    expect(describePublicEnvProblems([{ name: 'A', expected: 'x' }])).toContain('A: expected x');
  });
});
