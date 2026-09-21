import type { Account, TradeLog, Vault } from "envio";

type VaultKind = Vault["kind"];

/**
 * Pure helpers shared by the handlers. Nothing in here touches the Envio
 * runtime, so all of it is unit-testable without an indexer.
 */

/** Minimal structural view of an entity store, so helpers work on any context. */
export interface Store<T> {
  readonly get: (id: string) => Promise<T | undefined>;
  readonly set: (entity: T) => void;
}

export interface EventMeta {
  readonly chainId: number;
  readonly srcAddress: string;
  readonly logIndex: number;
  readonly block: { readonly number: number; readonly timestamp: number };
  readonly transaction: { readonly hash: string; readonly from?: string | undefined };
}

/** Scoped id: every id is prefixed with the chain id. */
export function scopedId(chainId: number, ...parts: ReadonlyArray<string | number | bigint>): string {
  return [chainId, ...parts.map((p) => p.toString())].join("_");
}

/** Unique per emitted log. Also the id of the TradeLog / Refusal it produces. */
export function logId(event: EventMeta): string {
  return scopedId(event.chainId, event.block.number, event.logIndex);
}

/** Evidence anchor common to every row. */
export function evidence(event: EventMeta) {
  return {
    timestamp: event.block.timestamp,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  };
}

/**
 * Decodes a bytes32 that carries a short ASCII label (predicate symbols and
 * refusal reasons are emitted as right-padded bytes32 strings). If the value is
 * not printable ASCII it is returned unchanged as hex, never guessed at.
 */
export function decodeBytes32Text(hex: string): string {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) return hex;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 2) bytes.push(parseInt(body.slice(i, i + 2), 16));
  while (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes.pop();
  if (bytes.length === 0) return "";
  if (!bytes.every((b) => b >= 0x20 && b <= 0x7e)) return hex;
  return String.fromCharCode(...bytes);
}

export function newAccount(chainId: number, address: string, timestamp: number): Account {
  return {
    id: scopedId(chainId, address),
    chainId,
    address,
    proposalCount: 0,
    refusalCount: 0,
    openedCount: 0,
    closedCount: 0,
    liquidationCount: 0,
    boundStrategy_id: undefined,
    firstSeenAt: timestamp,
    lastActivityAt: timestamp,
  };
}

export type AccountCounter = "proposalCount" | "refusalCount" | "openedCount" | "closedCount" | "liquidationCount";

/** Increments one counter on an address's Account row, creating it on first sight. */
export async function bumpAccount(
  store: Store<Account>,
  chainId: number,
  address: string,
  timestamp: number,
  counter: AccountCounter,
  delta = 1,
): Promise<void> {
  const id = scopedId(chainId, address);
  const existing = (await store.get(id)) ?? newAccount(chainId, address, timestamp);
  store.set({
    ...existing,
    [counter]: existing[counter] + delta,
    lastActivityAt: Math.max(existing.lastActivityAt, timestamp),
  });
}

export function newVault(chainId: number, address: string, kind: VaultKind, timestamp: number): Vault {
  return {
    id: scopedId(chainId, address),
    chainId,
    address,
    kind,
    ownerAddress: undefined,
    factory: undefined,
    createdAt: undefined,
    strategy_id: undefined,
    executor: undefined,
    series: undefined,
    maxDailyDrawdownBps: undefined,
    whitelistedAssetIds: undefined,
    leaderStrategy_id: undefined,
    allocationBps: undefined,
    feeShareBps: undefined,
    feeRecipient: undefined,
    netDeposits: 0n,
    depositCount: 0,
    withdrawalCount: 0,
    proposalCount: 0,
    refusalCount: 0,
    skippedCount: 0,
    following: kind === "COPY" ? true : undefined,
    lastActivityAt: timestamp,
  };
}

/** Get-or-create a Vault, apply `patch`, save. */
export async function updateVault(
  store: Store<Vault>,
  chainId: number,
  address: string,
  kind: VaultKind,
  timestamp: number,
  patch: (v: Vault) => Partial<Vault>,
): Promise<Vault> {
  const existing = (await store.get(scopedId(chainId, address))) ?? newVault(chainId, address, kind, timestamp);
  const next: Vault = { ...existing, ...patch(existing), lastActivityAt: Math.max(existing.lastActivityAt, timestamp) };
  store.set(next);
  return next;
}

/** A TradeLog with every optional field explicitly undefined, to be overridden. */
export function tradeLog(
  base: Pick<TradeLog, "id" | "chainId" | "kind" | "account" | "contractAddress" | "contractName"> &
    Pick<TradeLog, "timestamp" | "blockNumber" | "logIndex" | "txHash">,
  extra: Partial<TradeLog> = {},
): TradeLog {
  return {
    actor: undefined,
    vault: undefined,
    strategy_id: undefined,
    specHash: undefined,
    assetId: undefined,
    series: undefined,
    isLong: undefined,
    size: undefined,
    price: undefined,
    pnl: undefined,
    reason: undefined,
    decidingValue: undefined,
    position_id: undefined,
    refusal_id: undefined,
    ...base,
    ...extra,
  };
}
