import { useVaultDataSource, type LiveFollowRow, type LiveVaultRow, type VaultLiveDeps } from './vault-live';
import type { VaultClient } from './vault-client';
import type { VaultConfigResult } from './vault-config';
import type { LiveLeadRow } from './vault-map';
import type { VaultSource } from './vault-types';

/**
 * `KanonDataSource.useVaults`, live: vaults and copy trading, read from the
 * chain and from Convex, only while a component that shows them is mounted.
 *
 * This used to run at the app root, on every screen: three Convex
 * subscriptions (one of which, `copyRelationships.listLeads`, counts every
 * listed strategy's trades) and a sequence of RPC reads against the chain,
 * whether or not anyone opened Vault or Copy. Now the screen that needs them
 * calls this hook, and they exist while it is mounted.
 *
 * `packages/ui` has no dependency on Convex, so the app hands in its own hooks
 * and function references, exactly as for the chart and Predict reads.
 */
export interface VaultReadsDeps {
  hooks: {
    useQuery(ref: unknown, args: unknown): unknown;
    useMutation(ref: unknown): (args: any) => Promise<any>;
  };
  // Loosely typed on purpose: the generated `api` types are stale until codegen runs.
  api: any;
  session: { pending: boolean; userId: string | undefined };
  config: VaultConfigResult;
  /** Null when the contracts are not deployed on the configured network. */
  client: VaultClient | null;
  hasWallet: boolean;
  /** The user's active pinned strategy, which a vault binds to. */
  strategy: VaultLiveDeps['strategy'];
}

export function createVaultReads(deps: VaultReadsDeps): { useVaults(): VaultSource } {
  const { hooks, api, session, config, client, hasWallet, strategy } = deps;

  return {
    useVaults() {
      const { userId } = session;
      const vaults = hooks.useQuery(api.vaults.listVaultsByOwner, userId ? {} : 'skip') as
        | LiveVaultRow[]
        | undefined;
      const leads = hooks.useQuery(api.copyRelationships.listLeads, userId ? {} : 'skip') as
        | LiveLeadRow[]
        | undefined;
      const follows = hooks.useQuery(
        api.copyRelationships.listCopyRelationshipsByOwner,
        userId ? {} : 'skip',
      ) as LiveFollowRow[] | undefined;

      const recordVault = hooks.useMutation(api.vaults.recordVault);
      const recordBalance = hooks.useMutation(api.vaults.recordBalance);
      const requestVaultChange = hooks.useMutation(api.vaults.requestVaultChange);
      const withdrawVaultChange = hooks.useMutation(api.vaults.withdrawVaultChange);
      const recordFollow = hooks.useMutation(api.copyRelationships.recordFollow);
      const setCopyRelationshipActive = hooks.useMutation(api.copyRelationships.setCopyRelationshipActive);

      return useVaultDataSource({
        session: { pending: session.pending, userId },
        config,
        client,
        hasWallet,
        strategy,
        rows: { vaults, leads, follows },
        actions: {
          recordVault: (args) => recordVault(args),
          recordBalance: (args) => recordBalance(args),
          requestVaultChange: (args) => requestVaultChange(args),
          withdrawVaultChange: (args) => withdrawVaultChange(args),
          recordFollow: (args) => recordFollow(args),
          setCopyRelationshipActive: (args) => setCopyRelationshipActive(args),
        },
      });
    },
  };
}
