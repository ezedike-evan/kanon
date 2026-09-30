/**
 * The live half of the vault and copy sections of `KanonDataSource`.
 *
 * `packages/ui` has no dependency on Convex or a wallet, so each app hands this
 * hook what it already has: the rows it subscribed to, the mutations it can
 * call, a `VaultClient` (or null when the contracts are not deployed) and the
 * active strategy. The hook reads the chain for everything that is true on
 * chain, and uses the rows only to find vaults again and to hold a loosening
 * through its hold.
 *
 * Signed out, it returns the demo sections unchanged. Signed in, it never
 * mixes fixtures with live data: no client means `not_deployed`, no signer
 * means `no_wallet`, and an action that did not reach the chain says so.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COOLING_OFF_SECONDS,
  SUGGESTED_DAILY_DRAWDOWN_BPS,
  VAULT_ASSET_UNIVERSE,
  VAULT_LOOSENING_HOLD_SECONDS,
  normalizeAssets,
  validateCopyTerms,
  validateVaultLimits,
  type Decimal,
} from '@kanon/spec';
import { DEMO_COPY, DEMO_VAULTS, demoOutcome } from './vault-demo';
import type { PinAvailability } from './flow-types';
import type { VaultClient, CopyVaultState, GuardedVaultState, RawRefusal, ClientResult } from './vault-client';
import { recordWithWalletLink, replyFailed, type WalletLinkDeps } from './wallet-link';
import { NOT_DEPLOYED, type VaultConfigResult } from './vault-config';
import {
  copyFollowView,
  leadView,
  refusalRow,
  shortAddress,
  vaultView,
  type LiveLeadRow,
} from './vault-map';
import type {
  CopyData,
  CopyFollowView,
  PendingLooseningView,
  VaultOutcome,
  VaultParamsInput,
  VaultSource,
  VaultsData,
} from './vault-types';

export type { VaultSource };

export interface LiveVaultRow {
  _id: string;
  strategyId: string;
  address?: string | undefined;
  pendingLoosening?: PendingLooseningWire | undefined;
}

interface PendingLooseningWire {
  whitelistedAssets: string[];
  maxDailyDrawdownBps: number;
  requestedAt: number;
  endsAt: number;
}

export interface LiveFollowRow {
  _id: string;
  leaderStrategyId: string;
  address?: string | undefined;
  active: boolean;
}

/** What `vaults.requestVaultChange` returns: the server's decision, and the hold it started. */
export type VaultChangeWire =
  | { action: 'none' }
  | { action: 'apply'; reason: 'tightening' | 'hold_elapsed' }
  | { action: 'stage'; pending: { requestedAt: number; endsAt: number } }
  | { action: 'wait'; remainingMs: number }
  | { action: 'invalid'; problems: string[] };

export interface VaultBackendActions {
  /** `users.walletLinkChallenge`, for the first record from a wallet the server has not linked yet. */
  walletLinkMessage?: WalletLinkDeps['walletLinkMessage'];
  recordVault(args: {
    strategyId: string;
    address: string;
    chainId: number;
    factoryAddress: string;
    executor: string;
    seriesAddress: string;
    txHash: string;
    whitelistedAssets: string[];
    maxDailyDrawdownBps: number;
    /** Only its decimals are read: the server takes the balance from the chain. */
    depositBalance: Decimal;
    walletSignature?: string;
  }): Promise<unknown>;
  /** The server reads the vault's balance from the chain; only the hash is a label. */
  recordBalance(args: { vaultId: string; txHash?: string }): Promise<unknown>;
  requestVaultChange(args: {
    vaultId: string;
    whitelistedAssets: string[];
    maxDailyDrawdownBps: number;
  }): Promise<VaultChangeWire>;
  withdrawVaultChange(args: { vaultId: string }): Promise<unknown>;
  recordFollow(args: {
    leaderStrategyId: string;
    allocationBps: number;
    feeShareBps: number;
    address: string;
    chainId: number;
    txHash: string;
  }): Promise<unknown>;
  setCopyRelationshipActive(args: {
    copyRelationshipId: string;
    active: boolean;
  }): Promise<unknown>;
}

export interface VaultLiveDeps {
  /** `pending`: auth has not said who is signed in. */
  session: { pending: boolean; userId: string | undefined };
  config: VaultConfigResult;
  /** Null when the contracts are not deployed on the configured network. */
  client: VaultClient | null;
  /** Whether a signer exists. Says why an action cannot run before it is tried. */
  hasWallet: boolean;
  /** The user's active pinned strategy, which a vault binds to. */
  strategy: {
    id: string;
    chainStrategyId: string | undefined;
    symbol: string;
    name: string;
  } | null;
  rows: {
    vaults: LiveVaultRow[] | undefined;
    leads: LiveLeadRow[] | undefined;
    follows: LiveFollowRow[] | undefined;
  };
  actions: VaultBackendActions;
}

const lower = (s: string | undefined) => (s ?? '').toLowerCase();

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

function availabilityOf(deps: VaultLiveDeps): PinAvailability {
  if (deps.config.status === 'not_deployed' || !deps.client) {
    return { state: 'not_deployed', message: deps.config.status === 'not_deployed' ? deps.config.message : NOT_DEPLOYED };
  }
  if (!deps.hasWallet) {
    return { state: 'no_wallet', message: 'No wallet is available to sign with. Sign in again and Kanon will create one.' };
  }
  return { state: 'ready' };
}

interface GuardedRead {
  state: GuardedVaultState;
  refusals: RawRefusal[];
  seriesDecimals: number;
}

export interface Snapshot {
  loading: boolean;
  error?: string | undefined;
  account: string | null;
  wallet: bigint | null;
  guarded: GuardedRead[];
  copies: CopyVaultState[];
}

const EMPTY: Snapshot = { loading: true, account: null, wallet: null, guarded: [], copies: [] };

export function useVaultDataSource(deps: VaultLiveDeps): VaultSource {
  const { session, client, rows, actions, strategy } = deps;
  const userId = session.userId;
  const signedIn = !session.pending && Boolean(userId);

  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // What changes the chain reads: a new client, a new account, a recorded vault, a finished action.
  const recordedKey = useMemo(
    () => [...(rows.vaults ?? []).map((v) => v.address), ...(rows.follows ?? []).map((f) => f.address)].join(','),
    [rows.vaults, rows.follows],
  );

  useEffect(() => {
    let live = true;
    if (!signedIn || !client) {
      setSnap({ ...EMPTY, loading: false });
      return;
    }
    setSnap((prev) => ({ ...prev, loading: true }));
    (async () => {
      const account = await client.account();
      if (!account) {
        if (live) setSnap({ ...EMPTY, loading: false });
        return;
      }
      const [guardedAddrs, copyAddrs, wallet] = await Promise.all([
        client.listGuardedVaults(account),
        client.listCopyVaults(account),
        client.walletBalance(account).catch(() => null),
      ]);
      const guarded = await Promise.all(
        [...guardedAddrs].reverse().map(async (address): Promise<GuardedRead> => {
          const state = await client.readGuardedVault(address);
          const [refusals, seriesDecimals] = await Promise.all([
            client.readRefusals(address).catch(() => [] as RawRefusal[]),
            client.seriesDecimals(state.series).catch(() => 8),
          ]);
          return { state, refusals, seriesDecimals };
        }),
      );
      const copies = await Promise.all([...copyAddrs].reverse().map((a) => client.readCopyVault(a)));
      if (live) setSnap({ loading: false, account, wallet, guarded, copies });
    })().catch((err) => {
      if (live) setSnap({ ...EMPTY, loading: false, error: `The chain could not be read. ${errorText(err, '')}`.trim() });
    });
    return () => {
      live = false;
    };
  }, [signedIn, client, tick, recordedKey]);

  // Latest values for the async actions, so they never act on a render's stale copy.
  const latest = useRef({ deps, snap });
  latest.current = { deps, snap };

  const decimals = client?.config.collateralDecimals ?? 6;
  const symbol = client?.config.collateralSymbol ?? 'USDC';

  return useMemo<VaultSource>(() => {
    if (session.pending) {
      return {
        ...demoSections(),
        vaults: { ...emptyVaults(deps, decimals, symbol), loading: true },
        copy: { ...emptyCopy(deps, decimals, symbol), loading: true },
      };
    }
    if (!userId) return demoSections();

    const availability = availabilityOf(deps);
    const nowSeconds = Math.floor(Date.now() / 1000);

    /* ------------------------------ vault view ------------------------------ */
    const rowByAddress = new Map((rows.vaults ?? []).filter((r) => r.address).map((r) => [lower(r.address), r]));

    const vaults = snap.guarded.map(({ state, refusals, seriesDecimals }) => {
      const row = rowByAddress.get(lower(state.address));
      const pending: PendingLooseningView | null = row?.pendingLoosening
        ? {
            assets: row.pendingLoosening.whitelistedAssets,
            maxDailyDrawdownBps: row.pendingLoosening.maxDailyDrawdownBps,
            requestedAt: row.pendingLoosening.requestedAt,
            endsAt: row.pendingLoosening.endsAt,
          }
        : null;
      const label =
        strategy && strategy.chainStrategyId === state.strategyChainId ? strategy.name : `STRATEGY #${state.strategyChainId}`;
      return vaultView({
        state,
        strategyLabel: label,
        collateralDecimals: decimals,
        refusals: refusals.map((raw) =>
          refusalRow({ raw, state, collateralDecimals: decimals, seriesDecimals, blockTimeSeconds: undefined }),
        ),
        pending,
        nowSeconds,
      });
    });

    let blocker: string | undefined = snap.error;
    if (!blocker && availability.state === 'ready') {
      if (!strategy || !strategy.chainStrategyId) {
        blocker = 'Pin a rule first. A vault is bound to a strategy that is pinned on-chain.';
      }
    }

    const vaultsData: VaultsData = {
      availability,
      collateralSymbol: symbol,
      collateralDecimals: decimals,
      universe: [...VAULT_ASSET_UNIVERSE],
      defaults: {
        assets: strategy && VAULT_ASSET_UNIVERSE.includes(strategy.symbol) ? [strategy.symbol] : [],
        maxDailyDrawdownBps: SUGGESTED_DAILY_DRAWDOWN_BPS,
        executor: snap.account ?? '',
      },
      vaults,
      walletBalance: snap.wallet === null ? null : { atoms: snap.wallet.toString(), decimals },
      holdSeconds: VAULT_LOOSENING_HOLD_SECONDS,
      loading: snap.loading,
      blocker,
    };

    /* ------------------------------- copy view ------------------------------ */
    const followRows = rows.follows ?? [];
    const leadRows = rows.leads ?? [];
    const leadByChainId = new Map(leadRows.filter((l) => l.chainStrategyId).map((l) => [l.chainStrategyId as string, l]));

    const following: CopyFollowView[] = snap.copies
      .filter((c) => c.active || c.balance > 0n)
      .map((state) => {
        const lead = leadByChainId.get(state.leaderStrategyChainId);
        const leadView_ = lead
          ? leadView(lead, { alreadyFollowing: true, deployed: true })
          : null;
        return copyFollowView({
          state,
          leadId: lead?.leadId ?? '',
          leadName: leadView_?.name || `STRATEGY #${state.leaderStrategyChainId}`,
          collateralDecimals: decimals,
        });
      });

    const activeFollowedStrategies = new Set(
      snap.copies.filter((c) => c.active).map((c) => leadByChainId.get(c.leaderStrategyChainId)?.strategyId),
    );
    const copyData: CopyData = {
      availability,
      collateralSymbol: symbol,
      collateralDecimals: decimals,
      leads: leadRows.map((row) =>
        leadView(row, {
          alreadyFollowing: activeFollowedStrategies.has(row.strategyId),
          deployed: availability.state !== 'not_deployed',
        }),
      ),
      following,
      walletBalance: vaultsData.walletBalance,
      loading: snap.loading,
    };

    const acts = createVaultActions({
      deps: () => latest.current.deps,
      snap: () => latest.current.snap,
      refresh,
    });

    return { vaults: vaultsData, copy: copyData, ...acts };
    // `deps` is rebuilt each render by the caller; the fields that change what is shown are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.pending, userId, snap, rows.vaults, rows.leads, rows.follows, strategy, client, deps.hasWallet, deps.config, decimals, symbol]);
}

export interface ActionContext {
  deps(): VaultLiveDeps;
  snap(): Snapshot;
  refresh(): void;
}

/**
 * Every write the vault and copy screens can make. Split from the hook so it
 * can be driven in a test with a fake chain and a fake backend: what each
 * action sends, in what order, and what it reports when a step fails.
 */
export function createVaultActions(
  ctx: ActionContext,
): Pick<
  VaultSource,
  'createVault' | 'changeVault' | 'cancelVaultChange' | 'fundVault' | 'withdrawFromVault' | 'followLead' | 'unfollow'
> {
  /* -------------------------------- actions -------------------------------- */
  const notReady = (): VaultOutcome | null => {
    const a = availabilityOf(ctx.deps());
    return a.state === 'ready' ? null : { ok: false, reason: a.state, message: a.message };
  };
  const fromClient = (r: ClientResult<{ txHash: string }>, done: string): VaultOutcome =>
    r.ok ? { ok: true, message: done, txHash: r.txHash } : { ok: false, reason: r.reason, message: r.message };

  const clientNow = (): VaultClient => {
    const c = ctx.deps().client;
    if (!c) throw new Error(NOT_DEPLOYED);
    return c;
  };

  async function createVault(input: VaultParamsInput): Promise<VaultOutcome> {
    const blocked = notReady();
    if (blocked) return blocked;
    const d = ctx.deps();
    if (!d.session.userId || !d.strategy || !d.strategy.chainStrategyId) {
      return { ok: false, reason: 'no_strategy', message: 'Pin a rule first. A vault is bound to a strategy that is pinned on-chain.' };
    }
    const assets = normalizeAssets(input.assets);
    const problems = validateVaultLimits({ assets, maxDailyDrawdownBps: input.maxDailyDrawdownBps });
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.executor)) problems.push({ field: 'assets', message: 'The executor is not an address.' });
    if (problems.length > 0) return { ok: false, reason: 'invalid', message: problems.map((p) => p.message).join(' ') };

    const c = clientNow();
    const created = await c.createGuardedVault({
      strategyChainId: BigInt(d.strategy.chainStrategyId),
      executor: input.executor,
      limits: { assets, maxDailyDrawdownBps: input.maxDailyDrawdownBps },
    });
    if (!created.ok) return { ok: false, reason: created.reason, message: created.message };

    // The vault exists on-chain from here on. Recording it is bookkeeping and cannot undo it.
    let note = '';
    try {
      const reply = await recordWithWalletLink(
        (extra) =>
          d.actions.recordVault({
            strategyId: d.strategy!.id,
            address: created.vault,
            chainId: c.config.chainId,
            factoryAddress: c.config.factory,
            executor: input.executor,
            seriesAddress: created.series,
            txHash: created.txHash,
            whitelistedAssets: assets,
            maxDailyDrawdownBps: input.maxDailyDrawdownBps,
            depositBalance: { atoms: '0', decimals: c.config.collateralDecimals },
            ...extra,
          }),
        { walletLinkMessage: d.actions.walletLinkMessage, signMessage: c.signMessage?.bind(c) },
      );
      if (replyFailed(reply)) throw new Error(reply.message ?? 'the server could not verify it');
    } catch (err) {
      note = ` It was created, but Kanon could not save it: ${errorText(err, '')}. It is still listed from the chain.`;
    }
    ctx.refresh();
    return { ok: true, message: `Vault created at ${shortAddress(created.vault)}.${note}`, txHash: created.txHash };
  }

  async function changeVault(vaultAddress: string, input: VaultParamsInput): Promise<VaultOutcome> {
    const blocked = notReady();
    if (blocked) return blocked;
    const d = ctx.deps();
    const row = (d.rows.vaults ?? []).find((r) => lower(r.address) === lower(vaultAddress));
    if (!d.session.userId || !row) {
      return { ok: false, reason: 'unrecorded', message: 'This vault is not saved in Kanon, so a change cannot be held or applied. Create a new vault instead.' };
    }
    const assets = normalizeAssets(input.assets);
    let decision: VaultChangeWire;
    try {
      decision = await d.actions.requestVaultChange({
        vaultId: row._id,
        whitelistedAssets: assets,
        maxDailyDrawdownBps: input.maxDailyDrawdownBps,
      });
    } catch (err) {
      return { ok: false, reason: 'failed', message: errorText(err, 'The change could not be checked.') };
    }
    ctx.refresh();

    switch (decision.action) {
      case 'none':
        return { ok: false, reason: 'unchanged', message: 'Nothing differs from this vault.' };
      case 'invalid':
        return { ok: false, reason: 'invalid', message: decision.problems.join(' ') };
      case 'stage':
        return {
          ok: true,
          message: `Looser limits wait ${Math.round(COOLING_OFF_SECONDS / 3600)} hours. This vault keeps enforcing its current limits until then.`,
        };
      case 'wait':
        return {
          ok: true,
          message: `Still holding. ${Math.ceil(decision.remainingMs / 3_600_000)} hours remain. Nothing changes until the hold has run.`,
        };
      case 'apply': {
        const made = await createVault(input);
        if (made.ok && decision.reason === 'hold_elapsed' && d.session.userId) {
          await d.actions.withdrawVaultChange({ vaultId: row._id }).catch(() => undefined);
        }
        return made.ok
          ? { ...made, message: `${decision.reason === 'tightening' ? 'Tighter limits apply at once.' : 'The hold has run.'} ${made.message}` }
          : made;
      }
    }
  }

  async function cancelVaultChange(vaultAddress: string): Promise<VaultOutcome> {
    const d = ctx.deps();
    const row = (d.rows.vaults ?? []).find((r) => lower(r.address) === lower(vaultAddress));
    if (!d.session.userId || !row) return { ok: false, reason: 'unrecorded', message: 'This vault is not saved in Kanon.' };
    try {
      await d.actions.withdrawVaultChange({ vaultId: row._id });
      ctx.refresh();
      return { ok: true, message: 'Change withdrawn. The vault never stopped enforcing its limits.' };
    } catch (err) {
      return { ok: false, reason: 'failed', message: errorText(err, 'The change could not be withdrawn.') };
    }
  }

  async function move(kind: 'deposit' | 'withdraw', vaultAddress: string, amount: Decimal): Promise<VaultOutcome> {
    const blocked = notReady();
    if (blocked) return blocked;
    const d = ctx.deps();
    const c = clientNow();
    const atoms = BigInt(amount.atoms);
    const g = ctx.snap().guarded.find((x) => lower(x.state.address) === lower(vaultAddress));
    const cp = ctx.snap().copies.find((x) => lower(x.address) === lower(vaultAddress));
    const balance = g?.state.balance ?? cp?.balance ?? 0n;
    if (kind === 'withdraw' && atoms > balance) {
      return { ok: false, reason: 'insufficient', message: 'That is more than the vault holds.' };
    }
    const result =
      kind === 'deposit' ? await c.deposit({ vault: vaultAddress, amount: atoms }) : await c.withdraw({ vault: vaultAddress, amount: atoms });
    if (result.ok && g) {
      const row = (d.rows.vaults ?? []).find((r) => lower(r.address) === lower(vaultAddress));
      if (row && d.session.userId) {
        await d.actions.recordBalance({ vaultId: row._id, txHash: result.txHash }).catch(() => undefined);
      }
    }
    ctx.refresh();
    return fromClient(result, kind === 'deposit' ? 'Deposited.' : 'Withdrawn.');
  }

  async function followLead(input: { leadId: string; allocationBps: number; deposit: Decimal | null }): Promise<VaultOutcome> {
    const blocked = notReady();
    if (blocked) return blocked;
    const d = ctx.deps();
    const lead = (d.rows.leads ?? []).find((l) => l.leadId === input.leadId);
    if (!d.session.userId || !lead) return { ok: false, reason: 'no_lead', message: 'This strategy is no longer listed for copying.' };
    if (!lead.chainStrategyId) return { ok: false, reason: 'no_lead', message: 'This strategy has no registry entry to follow.' };

    // The fee is the lead's listed share and nothing else: the follower was shown exactly this number.
    const terms = { allocationBps: input.allocationBps, feeShareBps: lead.profitShareBps };
    const issues = validateCopyTerms(terms);
    if (issues.length > 0) return { ok: false, reason: 'invalid', message: issues.map((i) => i.message).join(' ') };

    const c = clientNow();
    const made = await c.createCopyVault({
      leaderExecutor: lead.leaderExecutor,
      leaderStrategyChainId: BigInt(lead.chainStrategyId),
      allocationBps: terms.allocationBps,
      feeShareBps: terms.feeShareBps,
      feeRecipient: lead.feeRecipient,
    });
    if (!made.ok) return { ok: false, reason: made.reason, message: made.message };

    let note = '';
    try {
      await d.actions.recordFollow({
        leaderStrategyId: lead.strategyId,
        allocationBps: terms.allocationBps,
        feeShareBps: terms.feeShareBps,
        address: made.vault,
        chainId: c.config.chainId,
        txHash: made.txHash,
      });
    } catch (err) {
      note = ` It exists on-chain, but Kanon could not save it: ${errorText(err, '')}.`;
    }

    if (input.deposit && BigInt(input.deposit.atoms) > 0n) {
      const funded = await c.deposit({ vault: made.vault, amount: BigInt(input.deposit.atoms) });
      ctx.refresh();
      if (!funded.ok) {
        return { ok: true, message: `Following. The deposit did not go through: ${funded.message}${note}`, txHash: made.txHash };
      }
    } else {
      ctx.refresh();
    }
    return { ok: true, message: `Following from ${shortAddress(made.vault)}.${note}`, txHash: made.txHash };
  }

  async function unfollow(vaultAddress: string, opts: { withdraw: boolean }): Promise<VaultOutcome> {
    const blocked = notReady();
    if (blocked) return blocked;
    const d = ctx.deps();
    const c = clientNow();
    const stopped = await c.setFollowing({ vault: vaultAddress, active: false });
    if (!stopped.ok) return { ok: false, reason: stopped.reason, message: stopped.message };

    const row = (d.rows.follows ?? []).find((r) => lower(r.address) === lower(vaultAddress));
    if (row && d.session.userId) {
      await d.actions
        .setCopyRelationshipActive({ copyRelationshipId: row._id, active: false })
        .catch(() => undefined);
    }

    const balance = ctx.snap().copies.find((x) => lower(x.address) === lower(vaultAddress))?.balance ?? 0n;
    if (opts.withdraw && balance > 0n) {
      const out = await c.withdraw({ vault: vaultAddress, amount: balance });
      ctx.refresh();
      return out.ok
        ? { ok: true, message: 'Stopped mirroring and withdrew the balance.', txHash: out.txHash }
        : { ok: true, message: `Stopped mirroring. The withdrawal did not go through: ${out.message}`, txHash: stopped.txHash };
    }
    ctx.refresh();
    return { ok: true, message: 'Stopped mirroring. Your balance is still yours to withdraw.', txHash: stopped.txHash };
  }

  return {
    createVault,
    changeVault,
    cancelVaultChange,
    fundVault: (address, amount) => move('deposit', address, amount),
    withdrawFromVault: (address, amount) => move('withdraw', address, amount),
    followLead,
    unfollow,
  };
}

function demoSections(): VaultSource {
  const refuse = async () => demoOutcome;
  return {
    vaults: DEMO_VAULTS,
    createVault: refuse,
    changeVault: refuse,
    cancelVaultChange: refuse,
    fundVault: refuse,
    withdrawFromVault: refuse,
    copy: DEMO_COPY,
    followLead: refuse,
    unfollow: refuse,
  };
}

function emptyVaults(deps: VaultLiveDeps, decimals: number, symbol: string): VaultsData {
  return {
    availability: availabilityOf(deps),
    collateralSymbol: symbol,
    collateralDecimals: decimals,
    universe: [...VAULT_ASSET_UNIVERSE],
    defaults: { assets: [], maxDailyDrawdownBps: SUGGESTED_DAILY_DRAWDOWN_BPS, executor: '' },
    vaults: [],
    walletBalance: null,
    holdSeconds: VAULT_LOOSENING_HOLD_SECONDS,
    loading: false,
  };
}

function emptyCopy(deps: VaultLiveDeps, decimals: number, symbol: string): CopyData {
  return {
    availability: availabilityOf(deps),
    collateralSymbol: symbol,
    collateralDecimals: decimals,
    leads: [],
    following: [],
    walletBalance: null,
    loading: false,
  };
}
