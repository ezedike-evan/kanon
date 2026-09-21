import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const MARGIN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const KEY = `0x${'cd'.repeat(32)}`;
const ok = { RPC_URL: 'https://rpc.example', MARGIN_ACCOUNT_ADDRESS: MARGIN };

describe('loadConfig', () => {
  it('applies defaults and is a dry run unless told otherwise', () => {
    const c = loadConfig(ok);
    expect(c.chainId).toBe(143);
    expect(c.broadcast).toBe(false);
    expect(c.marginAddress).toBe(MARGIN);
    expect(c.startBlock).toBe(0n);
    expect(c.logRangeBlocks).toBe(1000n);
    expect(c.reorgDepthBlocks).toBe(8n);
    expect(c.maxGasPriceWei).toBe(1_000_000_000_000n);
    expect(c.maxGasPerTx).toBe(1_500_000n);
    expect(c.maxTxsPerPass).toBe(20);
    expect(c.maxActionsPerAccount).toBe(8);
    expect(c.recordSamples).toBe(true);
    expect(c.extraAccounts).toEqual([]);
  });

  it('broadcasts only with the explicit flag and a key', () => {
    expect(loadConfig({ ...ok, KEEPER_BROADCAST: 'true', PRIVATE_KEY: KEY }).broadcast).toBe(true);
    expect(loadConfig({ ...ok, KEEPER_BROADCAST: 'false', PRIVATE_KEY: KEY }).broadcast).toBe(false);
    expect(loadConfig({ ...ok, PRIVATE_KEY: KEY }).broadcast).toBe(false);
  });

  it('lets --dry-run override the env flag', () => {
    expect(loadConfig({ ...ok, KEEPER_BROADCAST: 'true', PRIVATE_KEY: KEY }, { dryRun: true }).broadcast).toBe(false);
  });

  it('rejects anything but exactly true or false for the flag', () => {
    expect(() => loadConfig({ ...ok, KEEPER_BROADCAST: '1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ok, KEEPER_BROADCAST: 'TRUE' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ok, RECORD_SAMPLES: 'yes' })).toThrow(ConfigError);
  });

  it('requires a key to broadcast', () => {
    expect(() => loadConfig({ ...ok, KEEPER_BROADCAST: 'true' })).toThrow(/PRIVATE_KEY/);
  });

  it('rejects a malformed key without echoing it', () => {
    try {
      loadConfig({ ...ok, PRIVATE_KEY: '0xnothex-secret' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain('secret');
    }
  });

  it('rejects a missing or malformed RPC url and a missing or bad margin address', () => {
    expect(() => loadConfig({ MARGIN_ACCOUNT_ADDRESS: MARGIN })).toThrow(/RPC_URL/);
    expect(() => loadConfig({ ...ok, RPC_URL: 'not a url' })).toThrow(/RPC_URL/);
    expect(() => loadConfig({ RPC_URL: ok.RPC_URL })).toThrow(/MARGIN_ACCOUNT_ADDRESS/);
    expect(() => loadConfig({ ...ok, MARGIN_ACCOUNT_ADDRESS: '0x12' })).toThrow(/MARGIN_ACCOUNT_ADDRESS/);
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({ RPC_URL: 'nope', MAX_TXS_PER_PASS: '0' });
      expect.unreachable();
    } catch (e) {
      const issues = (e as ConfigError).issues.join('\n');
      expect(issues).toMatch(/RPC_URL/);
      expect(issues).toMatch(/MARGIN_ACCOUNT_ADDRESS/);
      expect(issues).toMatch(/MAX_TXS_PER_PASS/);
    }
  });

  it('treats blank env values as unset', () => {
    const c = loadConfig({ ...ok, CHAIN_ID: '', MAX_GAS_PER_TX: '  ', PRIVATE_KEY: '' });
    expect(c.chainId).toBe(143);
    expect(c.maxGasPerTx).toBe(1_500_000n);
    expect(c.privateKey).toBeUndefined();
  });

  it('parses caps as bigints and rejects fractional, negative or zero ones', () => {
    expect(loadConfig({ ...ok, MAX_GAS_PRICE_WEI: '123456789012345678901' }).maxGasPriceWei).toBe(123456789012345678901n);
    expect(() => loadConfig({ ...ok, MAX_GAS_PRICE_WEI: '1.5' })).toThrow(/MAX_GAS_PRICE_WEI/);
    expect(() => loadConfig({ ...ok, MAX_GAS_PRICE_WEI: '-1' })).toThrow(/MAX_GAS_PRICE_WEI/);
    expect(() => loadConfig({ ...ok, MAX_GAS_PRICE_WEI: '0' })).toThrow(/greater than zero/);
    expect(() => loadConfig({ ...ok, MAX_GAS_PER_TX: '0' })).toThrow(/greater than zero/);
  });

  it('parses START_BLOCK and the integer knobs', () => {
    const c = loadConfig({ ...ok, START_BLOCK: '12345', LOG_RANGE_BLOCKS: '100', REORG_DEPTH_BLOCKS: '0', MAX_TXS_PER_PASS: '3' });
    expect(c.startBlock).toBe(12345n);
    expect(c.logRangeBlocks).toBe(100n);
    expect(c.reorgDepthBlocks).toBe(0n);
    expect(c.maxTxsPerPass).toBe(3);
    expect(() => loadConfig({ ...ok, LOG_RANGE_BLOCKS: '0' })).toThrow(/LOG_RANGE_BLOCKS/);
    expect(() => loadConfig({ ...ok, START_BLOCK: '-5' })).toThrow(/START_BLOCK/);
  });

  it('parses and de-duplicates the extra account list, rejecting a bad entry', () => {
    const c = loadConfig({ ...ok, EXTRA_ACCOUNTS: ` ${OTHER}, ${OTHER.toUpperCase().replace('0X', '0x')} ,${MARGIN}` });
    expect(c.extraAccounts).toEqual([OTHER, MARGIN]);
    expect(() => loadConfig({ ...ok, EXTRA_ACCOUNTS: `${OTHER},0xbad` })).toThrow(/EXTRA_ACCOUNTS/);
  });
});
