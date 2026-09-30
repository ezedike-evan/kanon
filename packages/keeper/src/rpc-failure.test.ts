import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createKeeper, passOk } from './keeper';
import type { LogRecord } from './log';
import type { ChainPort } from './port';
import type { AccountSource } from './source';

const MARGIN = '0x1111111111111111111111111111111111111111' as const;
const cfg = () => loadConfig({ RPC_URL: 'http://rpc.example', MARGIN_ACCOUNT_ADDRESS: MARGIN });

const timeout = () => Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' });

function port(over: Partial<ChainPort>): ChainPort {
  return {
    chainId: async () => 143,
    blockNumber: async () => 1000n,
    gasPrice: async () => 1n,
    read: async () => 10n ** 18n,
    simulate: async () => ({ gas: 1n }),
    getLogs: async () => [],
    send: async () => ({ hash: `0x${'0'.repeat(64)}`, success: true }),
    ...over,
  };
}
const noAccounts: AccountSource = { poll: async () => ({ accounts: [] }) };

describe('RPC failure paths', () => {
  it('a timed-out chain id read fails the pass loudly, and the next pass recovers', async () => {
    let down = true;
    const keeper = createKeeper(cfg(), {
      port: port({
        chainId: async () => {
          if (down) throw timeout();
          return 143;
        },
      }),
      source: noAccounts,
    });
    await expect(keeper.runPass()).rejects.toThrow(/took too long/);
    down = false;
    expect(passOk(await keeper.runPass())).toBe(true);
  });

  it('unreadable risk thresholds (RPC timeout) throw with a named cause and log it', async () => {
    const logs: LogRecord[] = [];
    const keeper = createKeeper(cfg(), {
      port: port({
        read: async () => {
          throw timeout();
        },
      }),
      source: noAccounts,
      log: (l) => logs.push(l),
    });
    await expect(keeper.runPass()).rejects.toThrow(/cannot read the risk thresholds/);
    expect(logs.some((l) => l.event === 'thresholds_unreadable')).toBe(true);
  });

  it('a discovery outage is reported as not ok but does not stop the pass', async () => {
    const keeper = createKeeper(cfg(), {
      port: port({}),
      source: {
        poll: async () => {
          throw timeout();
        },
      },
    });
    const report = await keeper.runPass();
    expect(report.discovery.error).toBeTruthy();
    expect(passOk(report)).toBe(false);
  });
});
