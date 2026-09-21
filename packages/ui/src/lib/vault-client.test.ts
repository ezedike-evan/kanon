import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Address } from 'viem';
import { VAULT_ASSET_UNIVERSE } from '@kanon/spec';
import {
  assetIdOf,
  copyVaultAbi,
  createVaultClient,
  erc20Abi,
  factoryAbi,
  guardedVaultAbi,
  isUserRejection,
  refusalGateAbi,
  registryAbi,
  seriesAbi,
  symbolOfAssetId,
  type ChainCall,
  type ChainIO,
  type ChainLog,
} from './vault-client';
import { envFromDeployment, resolveVaultConfig } from './vault-config';

const A = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const FACTORY = A(0xfac);
const TOKEN = A(0x7ec);
const BTC_SERIES = A(0x5e1);
const OWNER = A(0xa11ce);
const VAULT = A(0xba1);
const REGISTRY = A(0x5e6);

const config = {
  chainId: 31337,
  rpcUrl: 'http://127.0.0.1:8545',
  factory: FACTORY,
  collateralToken: TOKEN,
  startBlock: 0n,
  collateralDecimals: 6,
  collateralSymbol: 'USDC',
};

/* ------------------------------ ABI drift ------------------------------ */

const jsonAbi = (name: string): Array<{ type: string; name?: string; inputs?: Array<{ type: string }>; outputs?: Array<{ type: string }> }> =>
  JSON.parse(readFileSync(resolve(__dirname, `../../../contracts/abi/${name}.json`), 'utf8'));

describe('ABI slices match packages/contracts/abi', () => {
  const check = (slice: Abi, file: string) => {
    const real = jsonAbi(file);
    for (const item of slice) {
      if (item.type !== 'function' && item.type !== 'event') continue;
      const match = real.find(
        (r) =>
          r.type === item.type &&
          r.name === item.name &&
          JSON.stringify((r.inputs ?? []).map((i) => i.type)) ===
            JSON.stringify(item.inputs.map((i) => i.type)) &&
          (item.type !== 'function' ||
            JSON.stringify((r.outputs ?? []).map((o) => o.type)) ===
              JSON.stringify(item.outputs.map((o) => o.type))),
      );
      expect(match, `${file}.${item.name}`).toBeDefined();
    }
  };
  it('VaultFactory', () => check(factoryAbi, 'VaultFactory'));
  it('GuardedVault', () => check(guardedVaultAbi, 'GuardedVault'));
  it('CopyVault', () => check(copyVaultAbi, 'CopyVault'));
  it('RefusalGate', () => check(refusalGateAbi, 'RefusalGate'));
  it('CanonicalSeries', () => check(seriesAbi, 'CanonicalSeries'));
  it('StrategyRegistry', () => check(registryAbi, 'StrategyRegistry'));

  it('the vault factory no longer takes a series, and the vault no longer exposes one', () => {
    const create = factoryAbi.find((i) => i.type === 'function' && i.name === 'createGuardedVault');
    expect(create && create.type === 'function' && create.inputs.map((i) => i.name)).toEqual([
      'strategyExecutor', 'strategyId', 'whitelistedAssetIds', 'maxDailyDrawdownBps',
    ]);
    expect(guardedVaultAbi.some((i) => i.type === 'function' && (i.name as string) === 'series')).toBe(false);
  });
  it('erc20 is only what MockERC20 and USDC share', () => {
    expect(erc20Abi.map((i) => (i.type === 'function' ? i.name : ''))).toEqual([
      'approve', 'allowance', 'balanceOf', 'decimals',
    ]);
  });
});

/* ------------------------------ asset ids ------------------------------ */

describe('asset ids', () => {
  it('matches keccak256("BTC-USD") as computed by cast', () => {
    expect(assetIdOf('BTC/USD')).toBe('0xb39c402b9bd8428ba7a4cc2d1aca1432756cddeb60941a9175541a819095269e');
  });
  it('round-trips every listed asset, and does not invent a symbol for an unknown id', () => {
    for (const s of VAULT_ASSET_UNIVERSE) expect(symbolOfAssetId(assetIdOf(s))).toBe(s);
    expect(symbolOfAssetId(assetIdOf('DOGE/USD'))).toBeUndefined();
  });
});

/* ------------------------------- config -------------------------------- */

describe('resolveVaultConfig', () => {
  it('is not_deployed with no factory, no chain or no rpc', () => {
    expect(resolveVaultConfig({}).status).toBe('not_deployed');
    expect(resolveVaultConfig({ chainId: '1', rpcUrl: 'x' }).status).toBe('not_deployed');
    expect(resolveVaultConfig({ chainId: '1', factory: FACTORY }).status).toBe('not_deployed');
    expect(resolveVaultConfig({ chainId: '1', rpcUrl: 'x', factory: 'nope' }).status).toBe('not_deployed');
  });
  it('is ready with a chain, an rpc and a factory, with the collateral defaults stated', () => {
    const r = resolveVaultConfig({ chainId: '31337', rpcUrl: 'x', factory: FACTORY });
    expect(r.status).toBe('ready');
    if (r.status === 'ready') {
      expect(r.config.collateralDecimals).toBe(6);
      expect(r.config.collateralSymbol).toBe('USDC');
      expect('series' in r.config).toBe(false); // a vault's series is its strategy's pinned series
    }
  });
  it('reads a deployments json', () => {
    const env = envFromDeployment(
      { chainId: 31337, startBlock: 7, VaultFactory: FACTORY, CollateralToken: TOKEN, CanonicalSeriesBTCUSD: BTC_SERIES },
      'http://127.0.0.1:8545',
    );
    const r = resolveVaultConfig(env);
    expect(r.status).toBe('ready');
    if (r.status === 'ready') {
      expect(r.config.startBlock).toBe(7n);
    }
  });
});

/* -------------------------------- client -------------------------------- */

interface Fake {
  io: ChainIO;
  writes: ChainCall[];
  setAccount(a: Address | null): void;
  reads: Map<string, unknown>;
  failNextWrite(err: unknown): void;
  revertNextWrite(): void;
  logsByEvent: Map<string, ChainLog[]>;
}

function fakeIO(): Fake {
  let account: Address | null = OWNER;
  const writes: ChainCall[] = [];
  const reads = new Map<string, unknown>();
  const logsByEvent = new Map<string, ChainLog[]>();
  let nextErr: unknown;
  let revert = false;

  const io: ChainIO = {
    chainId: 31337,
    account: async () => account,
    read: async (c) => {
      const key = `${c.address.toLowerCase()}:${c.functionName}${c.args ? ':' + c.args.map(String).join(',') : ''}`;
      if (!reads.has(key)) throw new Error(`unexpected read ${key}`);
      return reads.get(key);
    },
    write: async (c) => {
      if (nextErr) {
        const e = nextErr;
        nextErr = undefined;
        throw e;
      }
      writes.push(c);
      if (revert) {
        revert = false;
        return { hash: '0xdead', success: false, logs: [] };
      }
      if (c.functionName === 'createGuardedVault') {
        const args = { vault: VAULT, owner: OWNER, strategyId: 3n };
        const topics = encodeEventTopics({ abi: factoryAbi, eventName: 'GuardedVaultCreated', args });
        const data = encodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32[]' }],
          [A(1), BTC_SERIES, 200n, [assetIdOf('BTC/USD')]],
        );
        return { hash: '0xabc', success: true, logs: [{ address: FACTORY, topics: topics as unknown as string[], data }] };
      }
      if (c.functionName === 'createCopyVault') {
        const topics = encodeEventTopics({
          abi: factoryAbi,
          eventName: 'CopyVaultCreated',
          args: { vault: VAULT, follower: OWNER, leaderStrategyId: 9n },
        });
        const data = encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
          [A(1), 2500n, 1000n, A(2)],
        );
        return { hash: '0xdef', success: true, logs: [{ address: FACTORY, topics: topics as unknown as string[], data }] };
      }
      return { hash: '0x123', success: true, logs: [] };
    },
    logs: async (q) => logsByEvent.get(`${q.address.toLowerCase()}:${q.eventName}`) ?? [],
    now: async () => 20_000 * 86_400 + 500,
  };
  return {
    io, writes, reads, logsByEvent,
    setAccount: (a) => { account = a; },
    failNextWrite: (e) => { nextErr = e; },
    revertNextWrite: () => { revert = true; },
  };
}

const bytes32Text = (t: string) => '0x' + Buffer.from(t).toString('hex').padEnd(64, '0');

describe('VaultClient writes', () => {
  it('createGuardedVault sends the whitelist as asset ids, with no series argument, and returns the vault and its series from the receipt', async () => {
    const f = fakeIO();
    const c = createVaultClient(config, f.io);
    const r = await c.createGuardedVault({
      strategyChainId: 3n,
      executor: A(0xe),
      limits: { assets: ['BTC/USD', 'ETH/USD'], maxDailyDrawdownBps: 200 },
    });
    expect(r).toMatchObject({ ok: true, txHash: '0xabc' });
    expect(r.ok && r.vault.toLowerCase()).toBe(VAULT.toLowerCase()); // viem checksums decoded addresses
    expect(r.ok && r.series.toLowerCase()).toBe(BTC_SERIES.toLowerCase());
    expect(f.writes[0]).toMatchObject({ address: FACTORY, functionName: 'createGuardedVault' });
    expect(f.writes[0]!.args).toEqual([A(0xe), 3n, [assetIdOf('BTC/USD'), assetIdOf('ETH/USD')], 200n]);
  });

  it('reports no_wallet with nothing sent when no signer exists', async () => {
    const f = fakeIO();
    f.setAccount(null);
    const c = createVaultClient(config, f.io);
    expect(await c.deposit({ vault: VAULT, amount: 5n })).toMatchObject({ ok: false, reason: 'no_wallet' });
    expect(await c.withdraw({ vault: VAULT, amount: 5n })).toMatchObject({ ok: false, reason: 'no_wallet' });
    expect(await c.setFollowing({ vault: VAULT, active: false })).toMatchObject({ ok: false, reason: 'no_wallet' });
    expect(await c.createCopyVault({ leaderExecutor: A(1), leaderStrategyChainId: 1n, allocationBps: 1, feeShareBps: 0, feeRecipient: A(2) }))
      .toMatchObject({ ok: false, reason: 'no_wallet' });
    expect(f.writes).toHaveLength(0);
  });

  it('a declined signature is "rejected", not a failure', async () => {
    const f = fakeIO();
    f.failNextWrite(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
    const r = await createVaultClient(config, f.io).setFollowing({ vault: VAULT, active: false });
    expect(r).toMatchObject({ ok: false, reason: 'rejected' });
    expect(isUserRejection({ cause: { name: 'UserRejectedRequestError' } })).toBe(true);
    expect(isUserRejection(new Error('boom'))).toBe(false);
  });

  it('a reverted transaction is never reported as success', async () => {
    const f = fakeIO();
    f.revertNextWrite();
    const r = await createVaultClient(config, f.io).setFollowing({ vault: VAULT, active: false });
    expect(r).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('deposit approves only when the allowance is short, for exactly the amount, then deposits', async () => {
    const f = fakeIO();
    f.reads.set(`${TOKEN.toLowerCase()}:allowance:${OWNER},${VAULT}`, 0n);
    const c = createVaultClient(config, f.io);
    expect(await c.deposit({ vault: VAULT, amount: 5_000_000n })).toMatchObject({ ok: true });
    expect(f.writes.map((w) => w.functionName)).toEqual(['approve', 'deposit']);
    expect(f.writes[0]!.args).toEqual([VAULT, 5_000_000n]);

    const g = fakeIO();
    g.reads.set(`${TOKEN.toLowerCase()}:allowance:${OWNER},${VAULT}`, 9_000_000n);
    await createVaultClient(config, g.io).deposit({ vault: VAULT, amount: 5_000_000n });
    expect(g.writes.map((w) => w.functionName)).toEqual(['deposit']);
  });

  it('refuses a zero amount before touching the chain', async () => {
    const f = fakeIO();
    const c = createVaultClient(config, f.io);
    expect(await c.deposit({ vault: VAULT, amount: 0n })).toMatchObject({ ok: false });
    expect(await c.withdraw({ vault: VAULT, amount: 0n })).toMatchObject({ ok: false });
    expect(f.writes).toHaveLength(0);
  });

  it('unfollow is a single setActive(false) with no other call', async () => {
    const f = fakeIO();
    await createVaultClient(config, f.io).setFollowing({ vault: VAULT, active: false });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ address: VAULT, functionName: 'setActive', args: [false] });
  });

  it('createCopyVault returns the vault from the receipt', async () => {
    const f = fakeIO();
    const r = await createVaultClient(config, f.io).createCopyVault({
      leaderExecutor: A(1), leaderStrategyChainId: 9n, allocationBps: 2500, feeShareBps: 1000, feeRecipient: A(2),
    });
    expect(r).toMatchObject({ ok: true, txHash: '0xdef' });
    expect(r.ok && r.vault.toLowerCase()).toBe(VAULT.toLowerCase());
    expect(f.writes[0]!.args).toEqual([A(1), 9n, 2500n, 1000n, A(2)]);
  });
});

describe('VaultClient reads', () => {
  it('reads a guarded vault, resolving asset ids and falling back to the live balance before the day is snapshotted', async () => {
    const f = fakeIO();
    const v = VAULT.toLowerCase();
    const day = 20_000n;
    const set = (fn: string, val: unknown, args = '') => f.reads.set(`${v}:${fn}${args}`, val);
    set('owner', OWNER); set('strategyExecutor', A(0xe)); set('strategyId', 3n); set('registry', REGISTRY);
    f.reads.set(`${REGISTRY.toLowerCase()}:strategies:3`, [OWNER, '0x0', 0n, 0n, '0x0', 0n, '0x0', BTC_SERIES, '0x0', A(0)]);
    set('maxDailyDrawdownBps', 200n); set('totalCollateral', 1_000_000_000n); set('whitelistLength', 3n);
    set('whitelistedAssetIds', assetIdOf('BTC/USD'), ':0');
    set('whitelistedAssetIds', assetIdOf('ETH/USD'), ':1');
    set('whitelistedAssetIds', assetIdOf('DOGE/USD'), ':2');
    set('dailyRealizedPnL', -5_000_000n, `:${day}`);
    set('dailyReferenceBalance', 0n, `:${day}`);
    const s = await createVaultClient(config, f.io).readGuardedVault(VAULT);
    expect(s.limits).toEqual({ assets: ['BTC/USD', 'ETH/USD'], maxDailyDrawdownBps: 200 });
    expect(s.unknownAssetIds).toEqual([assetIdOf('DOGE/USD')]);
    expect(s.balance).toBe(1_000_000_000n);
    expect(s.today).toEqual({ utcDay: 20_000, referenceBalance: 1_000_000_000n, realizedPnl: -5_000_000n });
    expect(s.strategyChainId).toBe('3');
    expect(s.series).toBe(BTC_SERIES); // read from the registry's pinned series, not from the vault
  });

  it('joins a predicate refusal to the RefusalGate log in the same transaction', async () => {
    const f = fakeIO();
    f.reads.set(`${FACTORY.toLowerCase()}:refusalGate`, A(0x6a7e));
    f.logsByEvent.set(`${VAULT.toLowerCase()}:TradeRefused`, [
      { transactionHash: '0x1', blockNumber: 5n, args: { assetId: assetIdOf('BTC/USD'), reason: bytes32Text('PREDICATE_NOT_SATISFIED'), decidingValue: 0n } },
      { transactionHash: '0x2', blockNumber: 9n, args: { assetId: assetIdOf('DOGE/USD'), reason: bytes32Text('ASSET_NOT_WHITELISTED'), decidingValue: 0n } },
    ]);
    f.logsByEvent.set(`${A(0x6a7e).toLowerCase()}:TradeRefused`, [
      { transactionHash: '0x1', blockNumber: 5n, args: { predicateSymbol: bytes32Text('BOS_CONFIRMATION'), decidingValue: 6_820_730_000_000n } },
      { transactionHash: '0x9', blockNumber: 6n, args: { predicateSymbol: bytes32Text('OTHER'), decidingValue: 1n } },
    ]);
    const r = await createVaultClient(config, f.io).readRefusals(VAULT);
    expect(r.map((x) => x.reason)).toEqual(['ASSET_NOT_WHITELISTED', 'PREDICATE_NOT_SATISFIED']); // newest first
    expect(r[0]!.gate).toBeUndefined();
    expect(r[1]!.gate).toEqual({ symbol: 'BOS_CONFIRMATION', decidingValue: 6_820_730_000_000n });
  });

  it('does not query the gate at all when nothing was a predicate refusal', async () => {
    const f = fakeIO(); // no refusalGate read registered: a read would throw
    f.logsByEvent.set(`${VAULT.toLowerCase()}:TradeRefused`, [
      { transactionHash: '0x2', blockNumber: 9n, args: { assetId: assetIdOf('DOGE/USD'), reason: bytes32Text('DAILY_DRAWDOWN_EXCEEDED'), decidingValue: -25_000_000n } },
    ]);
    const r = await createVaultClient(config, f.io).readRefusals(VAULT);
    expect(r).toHaveLength(1);
    expect(r[0]!.decidingValue).toBe(-25_000_000n);
  });

  it('turns a series exponent into decimals', async () => {
    const f = fakeIO();
    f.reads.set(`${BTC_SERIES.toLowerCase()}:priceExpo`, -8);
    expect(await createVaultClient(config, f.io).seriesDecimals(BTC_SERIES)).toBe(8);
  });
});
