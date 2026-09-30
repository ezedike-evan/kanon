/**
 * Pure decoding and validation of what the chain says, so a mirrored row is
 * derived from a receipt or an `eth_call` and never from a client's claim.
 * No network here: `chainVerify.ts` fetches, this decides. Hand-decoded (the
 * backend package has no viem); the shapes are pinned by fixtures in
 * `chainLogic.test.ts`, which also recomputes the selectors with viem.
 */

import type { Decimal, type MarketDirection, type MarketSide } from "@kanon/spec";

/** `keccak256("SideTaken(uint256,address,bool,uint256)")`: ThresholdMarket's stake event. */
export const SIDE_TAKEN_TOPIC = "0xfc621c28da8932d8fb3e5c6c4c25268d2014483c7eeb2b32b12435309f107186";

export const SELECTORS = {
  isVault: "0x652b9b41",
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
