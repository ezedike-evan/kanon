import { DEFAULT_RPC_RETRIES, RpcError, rpcRequest, type FetchLike, type RpcConfig } from "./chainRpc";
import {
  MAX_WHITELIST_READS,
  SELECTORS,
  decodeAddress,
  decodeBool,
  decodeUint,
  encodeAddressCall,
  encodeUintCall,
  type CopyVaultReads,
  type RpcReceipt,
  type VaultReads,
} from "./chainLogic";
import type { ChainEnv } from "./serverEnv";

/** Reads from the configured Monad RPC. Everything returned is what the chain said. */
export function rpcFor(env: ChainEnv, fetchImpl: FetchLike = fetch as unknown as FetchLike): RpcConfig {
  return { url: env.rpcUrl, fetch: fetchImpl, retries: DEFAULT_RPC_RETRIES };
}

/** The RPC must be on the chain the deployment is configured for. */
export async function rpcIsOnChain(cfg: RpcConfig, chainId: number): Promise<boolean> {
  const hex = await rpcRequest<string>(cfg, "eth_chainId", []);
  return typeof hex === "string" && /^0x[0-9a-fA-F]+$/.test(hex) && Number(BigInt(hex)) === chainId;
}

export async function getReceipt(cfg: RpcConfig, txHash: string): Promise<RpcReceipt | null> {
  return await rpcRequest<RpcReceipt | null>(cfg, "eth_getTransactionReceipt", [txHash]);
}

export async function ethCall(cfg: RpcConfig, to: string, data: string): Promise<string> {
  return await rpcRequest<string>(cfg, "eth_call", [{ to, data }, "latest"]);
}

/** A call that may revert: a revert is `null`, transport faults still throw. */
async function tryCall(cfg: RpcConfig, to: string, data: string): Promise<string | null> {
  try {
    return await ethCall(cfg, to, data);
  } catch (err) {
    if (err instanceof RpcError && err.kind === "rpc") return null;
    throw err;
  }
}

export async function readIsVault(cfg: RpcConfig, factory: string, vault: string): Promise<boolean | null> {
  return decodeBool(await tryCall(cfg, factory, encodeAddressCall(SELECTORS.isVault, vault)));
}

/** The vault's own balance: `GuardedVault.totalCollateral`, in collateral atoms. */
export async function readTotalCollateral(cfg: RpcConfig, vault: string): Promise<bigint | null> {
  return decodeUint(await tryCall(cfg, vault, SELECTORS.totalCollateral));
}

export async function readVault(cfg: RpcConfig, factory: string, vault: string): Promise<VaultReads> {
  const isVault = await readIsVault(cfg, factory, vault);
  if (isVault !== true) return { isVault, owner: null, executor: null, maxDailyDrawdownBps: null, assetIds: [] };
  const [owner, executor, drawdown] = await Promise.all([
    tryCall(cfg, vault, SELECTORS.owner),
    tryCall(cfg, vault, SELECTORS.strategyExecutor),
    tryCall(cfg, vault, SELECTORS.maxDailyDrawdownBps),
  ]);
  const assetIds: string[] = [];
  for (let i = 0; i < MAX_WHITELIST_READS; i++) {
    const r = await tryCall(cfg, vault, encodeUintCall(SELECTORS.whitelistedAssetIds, i));
    if (r === null) break;
    assetIds.push(r.toLowerCase());
  }
  return {
    isVault,
    owner: decodeAddress(owner),
    executor: decodeAddress(executor),
    maxDailyDrawdownBps: decodeUint(drawdown),
    assetIds,
  };
}

export async function readCopyVault(cfg: RpcConfig, factory: string, vault: string): Promise<CopyVaultReads> {
  const isCopyVault = decodeBool(await tryCall(cfg, factory, encodeAddressCall(SELECTORS.isCopyVault, vault)));
  const none = {
    follower: null,
    leaderExecutor: null,
    feeRecipient: null,
    allocationBps: null,
    feeShareBps: null,
    leaderStrategyId: null,
  };
  if (isCopyVault !== true) return { isCopyVault, ...none };
  const [follower, executor, recipient, allocation, fee, strategy] = await Promise.all(
    [
      SELECTORS.follower,
      SELECTORS.leaderExecutor,
      SELECTORS.feeRecipient,
      SELECTORS.allocationBps,
      SELECTORS.feeShareBps,
      SELECTORS.leaderStrategyId,
    ].map((sel) => tryCall(cfg, vault, sel)),
  );
  return {
    isCopyVault,
    follower: decodeAddress(follower),
    leaderExecutor: decodeAddress(executor),
    feeRecipient: decodeAddress(recipient),
    allocationBps: decodeUint(allocation),
    feeShareBps: decodeUint(fee),
    leaderStrategyId: decodeUint(strategy),
  };
}
