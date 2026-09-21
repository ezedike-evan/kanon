/**
 * What the vault and copy screens render, and what they can ask for.
 *
 * Types only, so `vault-map.ts` and its tests can import them without React or
 * the demo fixtures. Amounts are `Decimal` (integer atoms, explicit decimals);
 * percentages are integer basis points.
 */

import type { Decimal } from '@kanon/spec';
import type { PinAvailability } from './flow-types';

/** The same four states the pinning ceremony uses, worded for a vault. */
export type VaultAvailability = PinAvailability;

export interface VaultRefusalRow {
  id: string;
  /** UTC, `YYYY-MM-DD HH:MM`. */
  at: string;
  asset: string;
  /** The named predicate that refused. */
  predicate: string;
  /** The number that failed it. */
  failing: string;
  /** What it had to satisfy. */
  required: string;
  /** Abbreviated hash of the refusing transaction. */
  txAbbrev: string;
  /** The evidence, one tap from the row: what refused, where, and the raw number. */
  evidence: Array<[label: string, value: string]>;
}

export interface VaultGuardView {
  /** The day's opening balance the cap is a percentage of. */
  referenceBalance: Decimal;
  /** Most a day may lose. */
  lossBudget: Decimal;
  /** What is left of it today. */
  remaining: Decimal;
  /** Signed realized P&L today. Shown below the fold, inside the guard panel. */
  realizedToday: Decimal;
  /** Loss so far today in bps of the opening balance. */
  usedBps: number;
}

export interface PendingLooseningView {
  assets: string[];
  maxDailyDrawdownBps: number;
  requestedAt: number;
  endsAt: number;
}

export interface VaultView {
  address: string;
  addressShort: string;
  strategyLabel: string;
  assets: string[];
  maxDailyDrawdownBps: number;
  /** The executor's full address. It can propose trades. It cannot withdraw. */
  executor: string;
  executorShort: string;
  balance: Decimal;
  guard: VaultGuardView;
  refusals: VaultRefusalRow[];
  /** A looser vault waiting out its hold. Null when nothing is pending. */
  pending: PendingLooseningView | null;
}

export interface VaultFormDefaults {
  /** Pre-ticked assets. Shown, flagged as a starting value, editable. */
  assets: string[];
  maxDailyDrawdownBps: number;
  /** Prefilled with the signer's own address. Shown and editable. */
  executor: string;
}

export interface VaultsData {
  availability: VaultAvailability;
  collateralSymbol: string;
  collateralDecimals: number;
  /** Assets a whitelist may draw from. */
  universe: string[];
  defaults: VaultFormDefaults;
  /** Newest first. Older vaults stay listed while they hold funds. */
  vaults: VaultView[];
  /** The signer's collateral balance, or null when it has not been read. */
  walletBalance: Decimal | null;
  /** The hold a looser vault waits out, in seconds. */
  holdSeconds: number;
  /** The chain has not been read yet. */
  loading: boolean;
  /** The strategy the vault binds to has no pinned id or no series on this network. */
  blocker?: string | undefined;
}

export interface VaultParamsInput {
  assets: string[];
  maxDailyDrawdownBps: number;
  executor: string;
}

export type VaultOutcome =
  | { ok: true; message: string; txHash?: string | undefined }
  | { ok: false; reason: string; message: string };

export interface CopyLeadView {
  id: string;
  /** The lead strategy's own id, for opening its strategy card. */
  strategyId: string;
  name: string;
  asset: string;
  timeframe: string;
  /** The rule in the spec's own words, compressed. */
  summary: string[];
  /** Abbreviated. What a follower checks the card against. */
  specHash: string;
  adherenceBps: number | null;
  taken: number;
  blocked: number;
  /** The only fee a follower can be charged. Set by the lead. */
  profitShareBps: number;
  executorShort: string;
  /** Empty when it can be followed. Otherwise, why not, in words. */
  blocker: string;
}

export interface CopyFollowView {
  address: string;
  addressShort: string;
  leadId: string;
  leadName: string;
  allocationBps: number;
  feeShareBps: number;
  active: boolean;
  balance: Decimal;
  mirrored: number;
  feeRecipientShort: string;
}

export interface CopyData {
  availability: VaultAvailability;
  collateralSymbol: string;
  collateralDecimals: number;
  leads: CopyLeadView[];
  following: CopyFollowView[];
  walletBalance: Decimal | null;
  loading: boolean;
}

/**
 * Everything the vault and copy screens read and can do: the read model
 * (`vaults`, `copy`) and every write. Returned by `useVaults()`, which reads the
 * chain and Convex only while a vault or copy screen is mounted.
 */
export interface VaultSource {
  /** Guarded AI Agent Vaults: read from the chain, mirrored by the app. */
  vaults: VaultsData;
  /** Non-custodial copy trading: leads to browse, and the follows the user holds. */
  copy: CopyData;
  /** Creates the owner's first vault on-chain. Every parameter was shown and signed for. */
  createVault(input: VaultParamsInput): Promise<VaultOutcome>;
  /** Tighter limits create a replacement vault at once; looser ones wait out the hold first. */
  changeVault(vaultAddress: string, input: VaultParamsInput): Promise<VaultOutcome>;
  /** Drops a staged loosening. The vault's current limits never stopped applying. */
  cancelVaultChange(vaultAddress: string): Promise<VaultOutcome>;
  /** Deposits collateral into a vault (guarded or copy). `amount` is in the collateral's atoms. */
  fundVault(vaultAddress: string, amount: Decimal): Promise<VaultOutcome>;
  withdrawFromVault(vaultAddress: string, amount: Decimal): Promise<VaultOutcome>;
  followLead(input: {
    leadId: string;
    allocationBps: number;
    /** Collateral to deposit straight away, or null to fund later. */
    deposit: Decimal | null;
  }): Promise<VaultOutcome>;
  /** Stops mirroring now. No hold, no fee. Optionally takes the remaining balance out too. */
  unfollow(vaultAddress: string, opts: { withdraw: boolean }): Promise<VaultOutcome>;
}
