/**
 * Pure decoding and validation of what the chain says, so a mirrored row is
 * derived from a receipt or an `eth_call` and never from a client's claim.
 * No network here: `chainVerify.ts` fetches, this decides. Hand-decoded (the
 * backend package has no viem); the shapes are pinned by fixtures in
 * `chainLogic.test.ts`, which also recomputes the selectors with viem.
 */

import type { Decimal, MarketDirection, MarketSide } from "@kanon/spec";

/** `keccak256("SideTaken(uint256,address,bool,uint256)")`: ThresholdMarket's stake event. */
export const SIDE_TAKEN_TOPIC = "0xfc621c28da8932d8fb3e5c6c4c25268d2014483c7eeb2b32b12435309f107186";

export const SELECTORS = {
  isVault: "0x652b9b41",
  isCopyVault: "0x9e2286a4",
  follower: "0xd9efc0ca",
  leaderExecutor: "0xd62bb9e5",
  allocationBps: "0xa4ce9d10",
  feeShareBps: "0x1b49fc18",
  feeRecipient: "0x46904840",
  leaderStrategyId: "0xab04c7b6",
  owner: "0x8da5cb5b",
  strategyExecutor: "0x5731d3b7",
  maxDailyDrawdownBps: "0xaec376cd",
  totalCollateral: "0x4ac8eb5f",
  whitelistedAssetIds: "0x4575086b",
} as const;

/** The chain's native unit, 18 decimals: what `takeSide`'s `msg.value` is in. */
export const NATIVE_DECIMALS = 18;
/** More than any vault whitelist (the asset universe is far smaller). */
export const MAX_WHITELIST_READS = 64;

export interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
}
export interface RpcReceipt {
  status?: string;
  to?: string | null;
  from?: string;
  logs?: RpcLog[];
}

const lower = (s: string | undefined | null) => (typeof s === "string" ? s.toLowerCase() : "");
const isHex = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]*$/.test(s);

export const padAddress = (address: string): string => "0x" + lower(address).slice(2).padStart(64, "0");
export const padUint = (n: bigint | number): string => "0x" + BigInt(n).toString(16).padStart(64, "0");

/** Calldata for `f(address)`. */
export const encodeAddressCall = (selector: string, address: string): string =>
  selector + padAddress(address).slice(2);
/** Calldata for `f(uint256)`. */
export const encodeUintCall = (selector: string, n: bigint | number): string =>
  selector + padUint(n).slice(2);

export function decodeUint(result: unknown): bigint | null {
  if (!isHex(result) || result.length !== 66) return null;
  return BigInt(result);
}
export function decodeAddress(result: unknown): string | null {
  if (!isHex(result) || result.length !== 66) return null;
  if (!/^0x0{24}/.test(result)) return null;
  return "0x" + result.slice(26).toLowerCase();
}
export function decodeBool(result: unknown): boolean | null {
  const n = decodeUint(result);
  return n === 0n ? false : n === 1n ? true : null;
}

/* ------------------------------------------------------------------ */
/* Positions                                                           */
/* ------------------------------------------------------------------ */

export type PositionVerdict =
  | { ok: true; stake: Decimal; side: MarketSide; takesYes: boolean }
  | { ok: false; reason: string };

/**
 * A receipt proves a stake only if it succeeded, went to the ThresholdMarket,
 * and carries exactly one `SideTaken` from the signer's wallet on this market.
 * The stake and the side are then read off that log.
 */
export function verifyPositionReceipt(input: {
  receipt: RpcReceipt | null;
  marketAddress: string;
  chainMarketId: string;
  wallet: string;
  direction: MarketDirection;
}): PositionVerdict {
  const { receipt } = input;
  if (!receipt) return { ok: false, reason: "The transaction is not confirmed yet." };
  if (lower(receipt.status) !== "0x1") return { ok: false, reason: "The transaction did not succeed." };
  if (lower(receipt.to) !== lower(input.marketAddress)) {
    return { ok: false, reason: "The transaction was not sent to the market contract." };
  }
  if (lower(receipt.from) !== lower(input.wallet)) {
    return { ok: false, reason: "The transaction was not sent from your linked wallet." };
  }
  if (!/^\d+$/.test(input.chainMarketId)) return { ok: false, reason: "The market has no on-chain id." };
  const marketTopic = padUint(BigInt(input.chainMarketId));
  const stakerTopic = padAddress(input.wallet);

  const matches = (receipt.logs ?? []).filter((l) => {
    const t = l.topics ?? [];
    return (
      lower(l.address) === lower(input.marketAddress) &&
      t.length === 3 &&
      lower(t[0]) === SIDE_TAKEN_TOPIC &&
      lower(t[1]) === marketTopic &&
      lower(t[2]) === stakerTopic
    );
  });
  if (matches.length !== 1) return { ok: false, reason: "No matching stake was found in that transaction." };

  const data = matches[0]!.data;
  if (!isHex(data) || data.length !== 2 + 128) return { ok: false, reason: "The stake log is malformed." };
  const takesYes = decodeBool("0x" + data.slice(2, 66));
  const amount = decodeUint("0x" + data.slice(66, 130));
  if (takesYes === null || amount === null) return { ok: false, reason: "The stake log is malformed." };
  if (amount <= 0n) return { ok: false, reason: "The stake must be a positive amount." };

  const opposite: MarketSide = input.direction === "above" ? "below" : "above";
  const side: MarketSide = takesYes ? input.direction : opposite;
  return { ok: true, stake: { atoms: amount.toString(), decimals: NATIVE_DECIMALS }, side, takesYes };
}

/* ------------------------------------------------------------------ */
/* Vaults                                                              */
/* ------------------------------------------------------------------ */

export type VaultVerdict = { ok: true } | { ok: false; reason: string };

export interface VaultReads {
  isVault: boolean | null;
  owner: string | null;
  executor: string | null;
  maxDailyDrawdownBps: bigint | null;
  /** `whitelistedAssetIds(i)` until the contract reverts, lower-cased. */
  assetIds: string[];
}

/** Checks what the client said about a new vault against what the chain holds. */
export function verifyVaultMirror(input: {
  reads: VaultReads;
  wallet: string;
  claimed: { executor: string; maxDailyDrawdownBps: number; assetIds: string[] };
}): VaultVerdict {
  const { reads, wallet, claimed } = input;
  if (reads.isVault !== true) return { ok: false, reason: "That address is not a Kanon vault." };
  if (!reads.owner || reads.owner !== lower(wallet)) {
    return { ok: false, reason: "That vault is not owned by your linked wallet." };
  }
  if (!reads.executor || reads.executor !== lower(claimed.executor)) {
    return { ok: false, reason: "The executor does not match the vault." };
  }
  if (reads.maxDailyDrawdownBps === null || reads.maxDailyDrawdownBps !== BigInt(claimed.maxDailyDrawdownBps)) {
    return { ok: false, reason: "The drawdown limit does not match the vault." };
  }
  const onChain = [...reads.assetIds].sort().join("|");
  const said = claimed.assetIds.map(lower).sort().join("|");
  if (onChain !== said) return { ok: false, reason: "The asset whitelist does not match the vault." };
  return { ok: true };
}

/** Whether a receipt proves a transaction to `address` succeeded. Used only to keep a tx hash as a label. */
export function receiptConfirms(receipt: RpcReceipt | null, to: string): boolean {
  return !!receipt && lower(receipt.status) === "0x1" && lower(receipt.to) === lower(to);
}

/* ------------------------------------------------------------------ */
/* Copy vaults                                                         */
/* ------------------------------------------------------------------ */

export interface CopyVaultReads {
  isCopyVault: boolean | null;
  follower: string | null;
  leaderExecutor: string | null;
  feeRecipient: string | null;
  allocationBps: bigint | null;
  feeShareBps: bigint | null;
  leaderStrategyId: bigint | null;
}

export type CopyVaultVerdict =
  | { ok: true; allocationBps: number; feeShareBps: number }
  | { ok: false; reason: string };

/**
 * A follow is real only if the chain's `CopyVault` belongs to the linked wallet
 * and copies the listed lead: same executor, fee address and registry strategy.
 * Allocation and fee are read off the vault, never taken from the client.
 */
export function verifyCopyVaultMirror(input: {
  reads: CopyVaultReads;
  wallet: string;
  lead: { leaderExecutor: string; feeRecipient: string; chainStrategyId: string | null | undefined };
}): CopyVaultVerdict {
  const { reads, wallet, lead } = input;
  if (reads.isCopyVault !== true) return { ok: false, reason: "That address is not a Kanon copy vault." };
  if (!reads.follower || reads.follower !== lower(wallet)) {
    return { ok: false, reason: "That vault does not belong to your linked wallet." };
  }
  if (!reads.leaderExecutor || reads.leaderExecutor !== lower(lead.leaderExecutor)) {
    return { ok: false, reason: "The vault does not follow this lead's executor." };
  }
  if (!reads.feeRecipient || reads.feeRecipient !== lower(lead.feeRecipient)) {
    return { ok: false, reason: "The vault's fee address does not match the listing." };
  }
  if (!lead.chainStrategyId || !/^\d+$/.test(lead.chainStrategyId)) {
    return { ok: false, reason: "This strategy has no registry entry to follow." };
  }
  if (reads.leaderStrategyId === null || reads.leaderStrategyId !== BigInt(lead.chainStrategyId)) {
    return { ok: false, reason: "The vault follows a different strategy." };
  }
  const { allocationBps, feeShareBps } = reads;
  if (allocationBps === null || allocationBps <= 0n || allocationBps > 10_000n) {
    return { ok: false, reason: "The vault's allocation could not be read." };
  }
  if (feeShareBps === null || feeShareBps > 10_000n) {
    return { ok: false, reason: "The vault's profit share could not be read." };
  }
  return { ok: true, allocationBps: Number(allocationBps), feeShareBps: Number(feeShareBps) };
}

/* ------------------------------------------------------------------ */
/* StrategyRegistry                                                    */
/* ------------------------------------------------------------------ */

/**
 * `topic0` of each StrategyRegistry event a rule's row is recorded from. The
 * strategy id is the first indexed argument of every one of them.
 */
export const REGISTRY_TOPICS = {
  /** `StrategyPinned(uint256,address,bytes32,uint256,bytes32,address)`: id and owner indexed. */
  pinned: "0xad9baa700360137d79e4b4703a8e78056ed96178e1d7d5047d24d0e44385fc8a",
  /** `Tightened(uint256,bytes32,bytes32,bytes32,address)` */
  tightened: "0x3698ff1fd39f84c2c42219ca9ed634275b7b3ab02df8c3f842f8c081d11555bb",
  /** `LooseningProposed(uint256,bytes32,bytes32,address,uint256)` */
  looseningProposed: "0xe9777bcf25545a245a9ab59323a8d3ccb2dd6a72c03d2436366b96940d442484",
  /** `LooseningFinalized(uint256,bytes32,bytes32,bytes32,address)` */
  looseningFinalized: "0x483f9045a8de840c9679551be93246aba98b88d5001a75a6d9dfec4cfd53f467",
} as const;

export type RegistryVerdict<T = unknown> = ({ ok: true } & T) | { ok: false; reason: string };

/** What a rule's row is about to say the registry holds. Compared with what the registry's own log says. */
export interface RegistryClaim {
  receipt: RpcReceipt | null;
  registryAddress: string;
  /** The registry's id for the strategy, in decimal. */
  chainStrategyId: string;
  specHash: string;
  predicatesCommitment: string;
  series: string;
}

const WORD = 64;

/**
 * The one log of `topic0` the registry itself emitted for this strategy in a
 * transaction that succeeded, as its data words. The log's address is what
 * makes it the registry's word: only the registry can emit from its address,
 * whatever contract the transaction was sent to. No log, or more than one, is
 * a refusal.
 */
function registryEvent(input: {
  receipt: RpcReceipt | null;
  registryAddress: string;
  chainStrategyId: string;
  topic0: string;
  /** Indexed arguments after the strategy id, as 32-byte topics. */
  indexed?: string[];
  words: number;
  missing: string;
}): RegistryVerdict<{ words: string[] }> {
  const { receipt } = input;
  if (!receipt) return { ok: false, reason: "The transaction is not confirmed yet." };
  if (lower(receipt.status) !== "0x1") return { ok: false, reason: "The transaction did not succeed." };
  if (!/^\d{1,78}$/.test(input.chainStrategyId)) return { ok: false, reason: "The rule has no registry id." };
  const wanted = [input.topic0, padUint(BigInt(input.chainStrategyId)), ...(input.indexed ?? [])];

  const matches = (receipt.logs ?? []).filter((l) => {
    const t = l.topics ?? [];
    return (
      lower(l.address) === lower(input.registryAddress) &&
      t.length === wanted.length &&
      wanted.every((topic, i) => lower(t[i]) === topic)
    );
  });
  if (matches.length !== 1) return { ok: false, reason: input.missing };

  const data = matches[0]!.data;
  if (!isHex(data) || data.length !== 2 + WORD * input.words) {
    return { ok: false, reason: "The registry's log is malformed." };
  }
  const words = Array.from({ length: input.words }, (_, i) => "0x" + lower(data.slice(2 + i * WORD, 2 + (i + 1) * WORD)));
  return { ok: true, words };
}

/** The hash, the commitment and the series a log carries must be the ones the row is about to record. */
function sameTarget(
  claim: RegistryClaim,
  said: { specHash: string | undefined; commitment: string | undefined; series: string | undefined },
): string | null {
  if (said.specHash !== lower(claim.specHash)) return "The registry holds a different spec hash than this rule's.";
  if (said.commitment !== lower(claim.predicatesCommitment)) {
    return "The registry holds a different predicates commitment than this rule's.";
  }
  if (decodeAddress(said.series) !== lower(claim.series)) return "The registry holds a different series than this rule's.";
  return null;
}

/**
 * A receipt proves a pin only if it succeeded and carries the registry's own
 * `StrategyPinned` for this strategy id, from the signer's linked wallet, with
 * the hash, commitment and series the draft is being pinned under. The bond is
 * read off the log, never taken from the client.
 */
export function verifyPinReceipt(claim: RegistryClaim & { wallet: string }): RegistryVerdict<{ bondWei: bigint }> {
  const ev = registryEvent({
    ...claim,
    topic0: REGISTRY_TOPICS.pinned,
    indexed: [padAddress(claim.wallet)],
    words: 4,
    missing: "No pin of this rule from your linked wallet was found in that transaction.",
  });
  if (!ev.ok) return ev;
  const [specHash, bond, commitment, series] = ev.words;
  const differs = sameTarget(claim, { specHash, commitment, series });
  if (differs) return { ok: false, reason: differs };
  const bondWei = decodeUint(bond);
  if (bondWei === null) return { ok: false, reason: "The registry's log is malformed." };
  return { ok: true, bondWei };
}

/**
 * A receipt proves a tightening only if it carries the registry's own
 * `Tightened` for this strategy, to the hash, commitment and series being
 * recorded. The registry lets only the strategy's owner tighten it and refuses
 * anything not provably stricter, so the log is both.
 */
export function verifyTightenReceipt(claim: RegistryClaim): RegistryVerdict {
  const ev = registryEvent({
    ...claim,
    topic0: REGISTRY_TOPICS.tightened,
    words: 4,
    missing: "No tightening of this rule was found in that transaction.",
  });
  if (!ev.ok) return ev;
  const [, specHash, commitment, series] = ev.words;
  const differs = sameTarget(claim, { specHash, commitment, series });
  return differs ? { ok: false, reason: differs } : { ok: true };
}

/**
 * A receipt proves a loosening was proposed only if it carries the registry's
 * own `LooseningProposed` for this strategy with the pending hash, commitment
 * and series. The cooldown's end is the registry's, read off the log.
 */
export function verifyLooseningProposedReceipt(claim: RegistryClaim): RegistryVerdict<{ cooldownEndsAtMs: number }> {
  const ev = registryEvent({
    ...claim,
    topic0: REGISTRY_TOPICS.looseningProposed,
    words: 4,
    missing: "No proposed loosening of this rule was found in that transaction.",
  });
  if (!ev.ok) return ev;
  const [specHash, commitment, series, endsAt] = ev.words;
  const differs = sameTarget(claim, { specHash, commitment, series });
  if (differs) return { ok: false, reason: differs };
  const seconds = decodeUint(endsAt);
  if (seconds === null || seconds > BigInt(Number.MAX_SAFE_INTEGER) / 1000n) {
    return { ok: false, reason: "The registry's log is malformed." };
  }
  return { ok: true, cooldownEndsAtMs: Number(seconds) * 1000 };
}

/**
 * A receipt proves a loosening was applied only if it carries the registry's
 * own `LooseningFinalized` for this strategy, adopting the hash, commitment and
 * series that were pending. The registry refuses it before its cooldown has run.
 */
export function verifyLooseningFinalizedReceipt(claim: RegistryClaim): RegistryVerdict {
  const ev = registryEvent({
    ...claim,
    topic0: REGISTRY_TOPICS.looseningFinalized,
    words: 4,
    missing: "No applied loosening of this rule was found in that transaction.",
  });
  if (!ev.ok) return ev;
  const [, specHash, commitment, series] = ev.words;
  const differs = sameTarget(claim, { specHash, commitment, series });
  return differs ? { ok: false, reason: differs } : { ok: true };
}
