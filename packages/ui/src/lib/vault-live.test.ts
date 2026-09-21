import { describe, expect, it } from 'vitest';
import { VAULT_LOOSENING_HOLD_SECONDS } from '@kanon/spec';
import { createVaultActions, type Snapshot, type VaultBackendActions, type VaultChangeWire, type VaultLiveDeps } from './vault-live';
import type { GuardedVaultState, VaultClient } from './vault-client';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const VAULT = A(0xba1);
const COPY = A(0xc0c);
const EXEC = A(0xe0e);
const LEAD_EXEC = A(0x1ead);
const config = { chainId: 31337, rpcUrl: 'x', factory: A(0xfac), collateralToken: A(0x7ec), startBlock: 0n, collateralDecimals: 6, collateralSymbol: 'USDC' };

interface Calls { name: string; args: unknown }
function harness(opts: { decision?: VaultChangeWire; createOk?: boolean; hasWallet?: boolean } = {}) {
  const chain: Calls[] = [];
  const backend: Calls[] = [];
  const client = {
    config,
    createGuardedVault: async (a: unknown) => {
      chain.push({ name: 'createGuardedVault', args: a });
      return opts.createOk === false
        ? { ok: false as const, reason: 'rejected' as const, message: 'Signature declined. Nothing was sent.' }
        : { ok: true as const, vault: A(0xba2), txHash: '0x' + 'a'.repeat(64), series: A(0x5e1) };
    },
    createCopyVault: async (a: unknown) => {
      chain.push({ name: 'createCopyVault', args: a });
      return { ok: true as const, vault: COPY, txHash: '0x' + 'b'.repeat(64) };
    },
    deposit: async (a: unknown) => { chain.push({ name: 'deposit', args: a }); return { ok: true as const, txHash: '0x1' }; },
    withdraw: async (a: unknown) => { chain.push({ name: 'withdraw', args: a }); return { ok: true as const, txHash: '0x2' }; },
    setFollowing: async (a: unknown) => { chain.push({ name: 'setFollowing', args: a }); return { ok: true as const, txHash: '0x3' }; },
  } as unknown as VaultClient;

  const actions: VaultBackendActions = {
    recordVault: async (a) => { backend.push({ name: 'recordVault', args: a }); },
    recordBalance: async (a) => { backend.push({ name: 'recordBalance', args: a }); },
    requestVaultChange: async (a) => { backend.push({ name: 'requestVaultChange', args: a }); return opts.decision ?? { action: 'none' }; },
    withdrawVaultChange: async (a) => { backend.push({ name: 'withdrawVaultChange', args: a }); },
    recordFollow: async (a) => { backend.push({ name: 'recordFollow', args: a }); },
    setCopyRelationshipActive: async (a) => { backend.push({ name: 'setCopyRelationshipActive', args: a }); },
  };

  const state: GuardedVaultState = {
    address: VAULT, owner: A(1), executor: EXEC, strategyChainId: '3', series: A(0x5e1),
    limits: { assets: ['BTC/USD', 'ETH/USD'], maxDailyDrawdownBps: 300 }, unknownAssetIds: [],
    balance: 1_000_000_000n, today: { utcDay: 1, referenceBalance: 1_000_000_000n, realizedPnl: 0n },
  };
  const snap: Snapshot = {
    loading: false, account: A(1), wallet: 5_000_000_000n, guarded: [{ state, refusals: [], seriesDecimals: 8 }],
    copies: [{ address: COPY, follower: A(1), leaderExecutor: LEAD_EXEC, leaderStrategyChainId: '9', allocationBps: 2500, feeShareBps: 1000, feeRecipient: A(0xfee), active: true, balance: 250_000_000n, mirroredPositions: 2 }],
  };
  const deps: VaultLiveDeps = {
    session: { pending: false, userId: 'u1' },
    config: { status: 'ready', config },
    client: opts.hasWallet === false ? client : client,
    hasWallet: opts.hasWallet !== false,
    strategy: { id: 's1', chainStrategyId: '3', symbol: 'BTC/USD', name: 'BOS' },
    rows: {
      vaults: [{ _id: 'v1', strategyId: 's1', address: VAULT }],
      leads: [{ leadId: 'l1', strategyId: 's9', chainStrategyId: '9', specHash: null, spec: null, profitShareBps: 1000, leaderExecutor: LEAD_EXEC, feeRecipient: A(0xfee), taken: 0, blocked: 0 }],
      follows: [{ _id: 'f1', leaderStrategyId: 's9', address: COPY, active: true }],
    },
    actions,
  };
  let refreshes = 0;
  const acts = createVaultActions({ deps: () => deps, snap: () => snap, refresh: () => { refreshes++; } });
  return { acts, chain, backend, refreshes: () => refreshes };
}

const input = (bps: number, assets = ['BTC/USD', 'ETH/USD']) => ({ assets, maxDailyDrawdownBps: bps, executor: EXEC });

describe('availability gates every write', () => {
  it('with no wallet nothing is sent and the reason is named', async () => {
    const h = harness({ hasWallet: false });
    const r = await h.acts.createVault(input(200));
    expect(r).toMatchObject({ ok: false, reason: 'no_wallet' });
    expect(h.chain).toHaveLength(0);
    expect(h.backend).toHaveLength(0);
  });
});

describe('createVault', () => {
  it('sends the normalised whitelist and the executor, then records the vault it got back', async () => {
    const h = harness();
    const r = await h.acts.createVault(input(200, ['eth/usd', 'BTC/USD', 'BTC/USD']));
    expect(r.ok).toBe(true);
    expect(h.chain[0]).toMatchObject({ name: 'createGuardedVault' });
    expect((h.chain[0]!.args as { limits: unknown }).limits).toEqual({ assets: ['BTC/USD', 'ETH/USD'], maxDailyDrawdownBps: 200 });
    expect(h.backend.map((b) => b.name)).toEqual(['recordVault']);
    expect(h.refreshes()).toBeGreaterThan(0);
  });

  it('records nothing when the wallet declines', async () => {
    const h = harness({ createOk: false });
    expect(await h.acts.createVault(input(200))).toMatchObject({ ok: false, reason: 'rejected' });
    expect(h.backend).toHaveLength(0);
  });

  it('refuses invalid limits and a bad executor before signing', async () => {
    const h = harness();
    expect(await h.acts.createVault(input(0))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await h.acts.createVault({ ...input(200), executor: 'nope' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await h.acts.createVault(input(200, []))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(h.chain).toHaveLength(0);
  });
});

describe('changeVault: tightening is immediate, loosening waits', () => {
  it('a tightening creates the replacement vault at once', async () => {
    const h = harness({ decision: { action: 'apply', reason: 'tightening' } });
    const r = await h.acts.changeVault(VAULT, input(100));
    expect(r.ok && r.message).toContain('Tighter limits apply at once');
    expect(h.chain.map((c) => c.name)).toEqual(['createGuardedVault']);
    expect(h.backend.map((b) => b.name)).toEqual(['requestVaultChange', 'recordVault']);
  });

  it('a loosening is staged and creates nothing on-chain', async () => {
    const h = harness({ decision: { action: 'stage', pending: { requestedAt: 1, endsAt: 2 } } });
    const r = await h.acts.changeVault(VAULT, input(500));
    expect(r.ok && r.message).toContain('hours');
    expect(h.chain).toHaveLength(0);
    expect(h.backend.map((b) => b.name)).toEqual(['requestVaultChange']);
    expect(VAULT_LOOSENING_HOLD_SECONDS).toBe(86_400);
  });

  it('while the hold runs, nothing is created and it says how long remains', async () => {
    const h = harness({ decision: { action: 'wait', remainingMs: 3 * 3_600_000 } });
    const r = await h.acts.changeVault(VAULT, input(500));
    expect(r.ok && r.message).toContain('3 hours');
    expect(h.chain).toHaveLength(0);
  });

  it('once the hold has run it creates the vault and clears the pending change', async () => {
    const h = harness({ decision: { action: 'apply', reason: 'hold_elapsed' } });
    const r = await h.acts.changeVault(VAULT, input(500));
    expect(r.ok && r.message).toContain('hold has run');
    expect(h.chain.map((c) => c.name)).toEqual(['createGuardedVault']);
    expect(h.backend.map((b) => b.name)).toEqual(['requestVaultChange', 'recordVault', 'withdrawVaultChange']);
  });

  it('a failed creation after the hold leaves the pending change in place', async () => {
    const h = harness({ decision: { action: 'apply', reason: 'hold_elapsed' }, createOk: false });
    expect((await h.acts.changeVault(VAULT, input(500))).ok).toBe(false);
    expect(h.backend.map((b) => b.name)).toEqual(['requestVaultChange']);
  });

  it('an unchanged or invalid request reports it and sends nothing', async () => {
    expect(await harness({ decision: { action: 'none' } }).acts.changeVault(VAULT, input(300))).toMatchObject({ ok: false, reason: 'unchanged' });
    const inv = harness({ decision: { action: 'invalid', problems: ['bad'] } });
    expect(await inv.acts.changeVault(VAULT, input(300))).toMatchObject({ ok: false, reason: 'invalid', message: 'bad' });
    expect(inv.chain).toHaveLength(0);
  });

  it('a vault the app never recorded cannot have a hold, so it is not changed', async () => {
    const h = harness();
    expect(await h.acts.changeVault(A(0xdead), input(100))).toMatchObject({ ok: false, reason: 'unrecorded' });
    expect(h.chain).toHaveLength(0);
  });
});

describe('fund and withdraw', () => {
  it('deposit sends to the chain then logs the balance before the movement', async () => {
    const h = harness();
    const r = await h.acts.fundVault(VAULT, { atoms: '5000000', decimals: 6 });
    expect(r.ok).toBe(true);
    expect(h.chain[0]).toMatchObject({ name: 'deposit', args: { vault: VAULT, amount: 5_000_000n } });
    expect(h.backend[0]!.args).toMatchObject({ equityAtoms: '1000000000', depositBalance: { atoms: '1005000000', decimals: 6 } });
  });

  it('withdraw refuses more than the vault holds before signing', async () => {
    const h = harness();
    expect(await h.acts.withdrawFromVault(VAULT, { atoms: '1000000001', decimals: 6 })).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(h.chain).toHaveLength(0);
    expect((await h.acts.withdrawFromVault(VAULT, { atoms: '1000000000', decimals: 6 })).ok).toBe(true);
  });
});

describe('copy trading', () => {
  it('follows with the lead\'s own listed fee and executor, records it, then deposits', async () => {
    const h = harness();
    const r = await h.acts.followLead({ leadId: 'l1', allocationBps: 2500, deposit: { atoms: '100000000', decimals: 6 } });
    expect(r.ok).toBe(true);
    expect(h.chain.map((c) => c.name)).toEqual(['createCopyVault', 'deposit']);
    expect(h.chain[0]!.args).toMatchObject({ leaderExecutor: LEAD_EXEC, leaderStrategyChainId: 9n, allocationBps: 2500, feeShareBps: 1000 });
    expect(h.backend.map((b) => b.name)).toEqual(['recordFollow']);
  });

  it('follow without a deposit sends no deposit', async () => {
    const h = harness();
    await h.acts.followLead({ leadId: 'l1', allocationBps: 100, deposit: null });
    expect(h.chain.map((c) => c.name)).toEqual(['createCopyVault']);
  });

  it('refuses out-of-range allocation and an unlisted lead before signing', async () => {
    const h = harness();
    expect(await h.acts.followLead({ leadId: 'l1', allocationBps: 0, deposit: null })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await h.acts.followLead({ leadId: 'zzz', allocationBps: 100, deposit: null })).toMatchObject({ ok: false, reason: 'no_lead' });
    expect(h.chain).toHaveLength(0);
  });

  it('unfollow is one setActive(false), immediately, and mirrors it', async () => {
    const h = harness();
    const r = await h.acts.unfollow(COPY, { withdraw: false });
    expect(r.ok).toBe(true);
    expect(h.chain.map((c) => c.name)).toEqual(['setFollowing']);
    expect(h.chain[0]!.args).toEqual({ vault: COPY, active: false });
    expect(h.backend[0]).toMatchObject({ name: 'setCopyRelationshipActive', args: { active: false } });
  });

  it('unfollow and withdraw takes out exactly the vault balance after stopping', async () => {
    const h = harness();
    await h.acts.unfollow(COPY, { withdraw: true });
    expect(h.chain.map((c) => c.name)).toEqual(['setFollowing', 'withdraw']);
    expect(h.chain[1]!.args).toEqual({ vault: COPY, amount: 250_000_000n });
  });
});
