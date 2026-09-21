import { describe, expect, it } from 'vitest';
import { PYTH_FEEDS } from '@kanon/spec';
import { ConfigError, PYTH_MONAD_ADDRESS, loadConfig } from './config';

const ADDR = '0x1111111111111111111111111111111111111111';
const KEY = `0x${'cd'.repeat(32)}`;
const ok = { RPC_URL: 'https://rpc.example', SERIES_ADDRESSES: `BTC/USD=${ADDR}` };

describe('loadConfig', () => {
  it('applies defaults and is a dry run unless told otherwise', () => {
    const c = loadConfig(ok);
    expect(c.chainId).toBe(143);
    expect(c.pythAddress).toBe(PYTH_MONAD_ADDRESS);
    expect(c.broadcast).toBe(false);
    expect(c.maxUpdateFeeWei).toBe(1_000_000_000_000_000n);
    expect(c.hermes.baseUrl).toBe('https://hermes.pyth.network');
    expect(c.series).toEqual([{ symbol: 'BTC/USD', feedId: PYTH_FEEDS['BTC/USD'], address: ADDR }]);
  });

  it('matches the Pyth address in PythMonad.sol', async () => {
    const { readFileSync } = await import('node:fs');
    const sol = readFileSync(new URL('../../contracts/script/PythMonad.sol', import.meta.url), 'utf8');
    expect(sol).toContain(PYTH_MONAD_ADDRESS);
  });

  it('parses several series, tolerating case and whitespace in the symbol', () => {
    const c = loadConfig({ ...ok, SERIES_ADDRESSES: ` btc/usd = ${ADDR} , ETH/USD=${ADDR}` });
    expect(c.series.map((s) => s.symbol)).toEqual(['BTC/USD', 'ETH/USD']);
  });

  it('broadcasts only with the explicit flag and a key', () => {
    expect(loadConfig({ ...ok, RELAYER_BROADCAST: 'true', PRIVATE_KEY: KEY }).broadcast).toBe(true);
    expect(loadConfig({ ...ok, RELAYER_BROADCAST: 'false', PRIVATE_KEY: KEY }).broadcast).toBe(false);
  });

  it('lets --dry-run override the env flag', () => {
    expect(loadConfig({ ...ok, RELAYER_BROADCAST: 'true', PRIVATE_KEY: KEY }, { dryRun: true }).broadcast).toBe(false);
  });

  it('rejects anything but exactly true or false for the flag', () => {
    expect(() => loadConfig({ ...ok, RELAYER_BROADCAST: '1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ok, RELAYER_BROADCAST: 'TRUE' })).toThrow(ConfigError);
  });

  it('requires a key to broadcast', () => {
    expect(() => loadConfig({ ...ok, RELAYER_BROADCAST: 'true' })).toThrow(/PRIVATE_KEY/);
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

  it('rejects a missing or malformed RPC url', () => {
    expect(() => loadConfig({ SERIES_ADDRESSES: `BTC/USD=${ADDR}` })).toThrow(/RPC_URL/);
    expect(() => loadConfig({ ...ok, RPC_URL: 'not a url' })).toThrow(/RPC_URL/);
  });

  it('rejects series with no feed, a bad address, a duplicate, or none at all', () => {
    expect(() => loadConfig({ ...ok, SERIES_ADDRESSES: `AVAX/USD=${ADDR}` })).toThrow(/no Pyth feed/);
    expect(() => loadConfig({ ...ok, SERIES_ADDRESSES: 'BTC/USD=0x12' })).toThrow(/BTC\/USD/);
    expect(() => loadConfig({ ...ok, SERIES_ADDRESSES: 'BTC/USD' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ok, SERIES_ADDRESSES: `BTC/USD=${ADDR},BTC/USD=${ADDR}` })).toThrow(/twice/);
    expect(() => loadConfig({ ...ok, SERIES_ADDRESSES: '' })).toThrow(ConfigError);
  });

  it('treats blank env values as unset', () => {
    const c = loadConfig({ ...ok, CHAIN_ID: '', HERMES_URL: '  ', PRIVATE_KEY: '' });
    expect(c.chainId).toBe(143);
    expect(c.privateKey).toBeUndefined();
  });

  it('parses the fee cap as a bigint and rejects a fractional one', () => {
    expect(loadConfig({ ...ok, MAX_UPDATE_FEE_WEI: '123456789012345678901' }).maxUpdateFeeWei).toBe(123456789012345678901n);
    expect(() => loadConfig({ ...ok, MAX_UPDATE_FEE_WEI: '1.5' })).toThrow(/MAX_UPDATE_FEE_WEI/);
  });

  it('passes the Hermes key and header through', () => {
    const c = loadConfig({ ...ok, HERMES_API_KEY: 'k', HERMES_API_KEY_HEADER: 'x-api-key', HERMES_URL: 'https://h.example' });
    expect(c.hermes).toEqual({ baseUrl: 'https://h.example', apiKey: 'k', apiKeyHeader: 'x-api-key' });
  });
});
