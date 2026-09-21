/**
 * The chain client for guarded vaults and copy vaults.
 *
 * `VaultClient` is what screens and the live data hook talk to. It is built
 * from a `ChainIO` — a five-method seam over viem — so a test injects a fake
 * chain and the apps inject the Privy embedded wallet's EIP-1193 provider.
 * Nothing in here signs unless a wallet is connected, and nothing reports a
 * transaction it did not send: every failure comes back as a typed reason.
 *
 * The contracts are read exactly as deployed: a vault's whitelist and drawdown
 * cap are immutable, `withdraw` on a `GuardedVault` is owner-only, and
 * `CopyVault.setActive(false)` is the follower's kill switch.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToBytes,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import {
  decodeBytes32Text,
  vaultAssetKey,
  vaultAssetSymbol,
  VAULT_ASSET_UNIVERSE,
  type VaultLimits,
} from '@kanon/spec';
import type { VaultConfig } from './vault-config';
import type { Signer } from './pin-viem';

/* ------------------------------------------------------------------ */
/* ABI slices. Checked against packages/contracts/abi/*.json in tests. */
/* ------------------------------------------------------------------ */

export const factoryAbi = parseAbi([
  'function createGuardedVault(address strategyExecutor, uint256 strategyId, bytes32[] whitelistedAssetIds, uint256 maxDailyDrawdownBps) returns (address vault)',
  'function createCopyVault(address leaderExecutor, uint256 leaderStrategyId, uint256 allocationBps, uint256 feeShareBps, address feeRecipient) returns (address vault)',
  'function guardedVaultsOf(address owner) view returns (address[])',
  'function copyVaultsOf(address follower) view returns (address[])',
  'function collateralToken() view returns (address)',
  'function refusalGate() view returns (address)',
  'function registry() view returns (address)',
  'event GuardedVaultCreated(address indexed vault, address indexed owner, uint256 indexed strategyId, address strategyExecutor, address series, uint256 maxDailyDrawdownBps, bytes32[] whitelistedAssetIds)',
  'event CopyVaultCreated(address indexed vault, address indexed follower, uint256 indexed leaderStrategyId, address leaderExecutor, uint256 allocationBps, uint256 feeShareBps, address feeRecipient)',
]);

export const guardedVaultAbi = parseAbi([
  'function owner() view returns (address)',
  'function strategyExecutor() view returns (address)',
  'function strategyId() view returns (uint256)',
  'function registry() view returns (address)',
  'function maxDailyDrawdownBps() view returns (uint256)',
  'function totalCollateral() view returns (uint256)',
  'function whitelistLength() view returns (uint256)',
  'function whitelistedAssetIds(uint256) view returns (bytes32)',
  'function dailyRealizedPnL(uint256) view returns (int256)',
  'function dailyReferenceBalance(uint256) view returns (uint256)',
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
  'event Deposited(address indexed from, uint256 amount)',
  'event Withdrawn(address indexed to, uint256 amount)',
  'event TradeProposed(bytes32 indexed assetId, address indexed proposer, bool isLong, uint256 size, int256 projectedPnL)',
  'event TradeRefused(bytes32 indexed assetId, address indexed proposer, bytes32 reason, int256 decidingValue)',
]);

export const copyVaultAbi = parseAbi([
  'function follower() view returns (address)',
  'function leaderExecutor() view returns (address)',
  'function leaderStrategyId() view returns (uint256)',
  'function allocationBps() view returns (uint256)',
  'function feeShareBps() view returns (uint256)',
  'function feeRecipient() view returns (address)',
  'function active() view returns (bool)',
  'function collateral() view returns (uint256)',
  'function nextPositionId() view returns (uint256)',
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
  'function setActive(bool active_)',
  'event PositionMirrored(uint256 indexed positionId, bytes32 indexed assetId, bool isLong, uint256 followerSize, uint256 entryPrice)',
  'event PositionClosed(uint256 indexed positionId, uint256 exitPrice, int256 pnl, uint256 feeCharged)',
  'event TradeSkipped(bytes32 indexed assetId, bytes32 reason)',
]);

export const refusalGateAbi = parseAbi([
  'event TradeRefused(uint256 indexed strategyId, bytes32 indexed specHash, address indexed proposer, bytes32 predicateSymbol, int256 decidingValue)',
]);

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

/**
 * The registry now owns a strategy's series: a vault is bound to the series the
 * strategy pinned with its predicates commitment, and the client reads it from here.
 */
export const registryAbi = parseAbi([
  'function strategies(uint256) view returns (address owner, bytes32 specHash, uint256 bond, uint256 pinnedAt, bytes32 pendingSpecHash, uint256 cooldownEndsAt, bytes32 predicatesCommitment, address series, bytes32 pendingPredicatesCommitment, address pendingSeries)',
  'function activePredicatesCommitment(uint256 strategyId) view returns (bytes32)',
]);

export const seriesAbi = parseAbi(['function priceExpo() view returns (int32)']);

/* ------------------------------------------------------------------ */
/* The seam                                                            */
/* ------------------------------------------------------------------ */

export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface ChainCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface ChainLog {
  transactionHash: string;
  blockNumber: bigint;
  args: Record<string, unknown>;
}

/** Everything the client needs from a chain. viem implements it; a test fakes it. */
export interface ChainIO {
  chainId: number;
  /** The connected signer, or null when no wallet is available. */
  account(): Promise<Address | null>;
  read(call: ChainCall): Promise<unknown>;
  /** Sends, waits for the receipt, and returns it. Throws if the user declines or the node refuses. */
  write(call: ChainCall): Promise<{ hash: string; success: boolean; logs: readonly ReceiptLog[] }>;
  logs(query: {
    address: Address;
    abi: Abi;
    eventName: string;
    fromBlock: bigint;
    args?: Record<string, unknown>;
  }): Promise<ChainLog[]>;
  /** Unix seconds of the latest block. */
  now(): Promise<number>;
}

export type FailureReason = 'not_deployed' | 'no_wallet' | 'rejected' | 'failed';

export type ClientResult<T> = ({ ok: true } & T) | { ok: false; reason: FailureReason; message: string };

export interface GuardedVaultState {
  address: string;
  owner: string;
  executor: string;
  strategyChainId: string;
  series: string;
  limits: VaultLimits;
  /** Assets whose id this client could not resolve to a known symbol. */
  unknownAssetIds: string[];
  balance: bigint;
  /** Today's snapshot and realized P&L, read from the vault's own ledger. */
  today: { utcDay: number; referenceBalance: bigint; realizedPnl: bigint };
}

export interface CopyVaultState {
  address: string;
  follower: string;
  leaderExecutor: string;
  leaderStrategyChainId: string;
  allocationBps: number;
  feeShareBps: number;
  feeRecipient: string;
  active: boolean;
  balance: bigint;
  mirroredPositions: number;
}

export interface RawRefusal {
  txHash: string;
  blockNumber: bigint;
  assetId: string;
  /** Text decoded from the vault's `reason`, e.g. `DAILY_DRAWDOWN_EXCEEDED`. */
  reason: string;
  decidingValue: bigint;
  /** For a predicate refusal: the `RefusalGate` log in the same transaction. */
  gate?: { symbol: string; decidingValue: bigint } | undefined;
}

export interface VaultClient {
  readonly config: VaultConfig;
  account(): Promise<string | null>;
  walletBalance(owner: string): Promise<bigint>;

  /**
   * The series is not an argument: the vault reads it from the strategy's pinned
   * commitment in the registry, so it cannot be pointed at a different one.
   */
  createGuardedVault(input: {
    strategyChainId: bigint;
    executor: string;
    limits: VaultLimits;
  }): Promise<ClientResult<{ vault: string; txHash: string; series: string }>>;
  createCopyVault(input: {
    leaderExecutor: string;
    leaderStrategyChainId: bigint;
    allocationBps: number;
    feeShareBps: number;
    feeRecipient: string;
  }): Promise<ClientResult<{ vault: string; txHash: string }>>;

  deposit(input: { vault: string; amount: bigint }): Promise<ClientResult<{ txHash: string }>>;
  withdraw(input: { vault: string; amount: bigint }): Promise<ClientResult<{ txHash: string }>>;
  setFollowing(input: { vault: string; active: boolean }): Promise<ClientResult<{ txHash: string }>>;

  listGuardedVaults(owner: string): Promise<string[]>;
  listCopyVaults(follower: string): Promise<string[]>;
  readGuardedVault(vault: string): Promise<GuardedVaultState>;
  readCopyVault(vault: string): Promise<CopyVaultState>;
  readRefusals(vault: string, opts?: { fromBlock?: bigint }): Promise<RawRefusal[]>;
  /** Fixed-point decimals of the series' prices, for showing a predicate's deciding value. */
  seriesDecimals(series: string): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* Asset ids                                                           */
/* ------------------------------------------------------------------ */

/** `keccak256("BTC-USD")` — what the contract's whitelist stores for `BTC/USD`. */
export function assetIdOf(symbol: string): Hex {
  return keccak256(stringToBytes(vaultAssetKey(symbol)));
}

const KNOWN_IDS: ReadonlyMap<string, string> = new Map(
  VAULT_ASSET_UNIVERSE.map((s) => [assetIdOf(s).toLowerCase(), s]),
);

/** The symbol behind an asset id, or undefined if it is not one Kanon lists. */
export function symbolOfAssetId(id: string): string | undefined {
  return KNOWN_IDS.get(id.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Failure mapping                                                     */
/* ------------------------------------------------------------------ */

/** A wallet the user closed, declined or never opened is a choice, not a fault. */
export function isUserRejection(err: unknown): boolean {
  const e = err as { code?: number; name?: string; message?: string; cause?: unknown } | undefined;
  if (!e) return false;
  if (e.code === 4001 || e.code === 5000) return true;
  if (e.name === 'UserRejectedRequestError') return true;
  if (typeof e.message === 'string' && /user (rejected|denied|declined|cancel)/i.test(e.message)) return true;
  return e.cause ? isUserRejection(e.cause) : false;
}

const shortMessage = (err: unknown): string => {
  const e = err as { shortMessage?: string; message?: string } | undefined;
  return (e?.shortMessage ?? e?.message ?? 'The transaction did not complete.').split('\n')[0]!;
};

function fail<T>(err: unknown): ClientResult<T> {
  if (isUserRejection(err)) {
    return { ok: false, reason: 'rejected', message: 'Signature declined. Nothing was sent.' };
  }
  return { ok: false, reason: 'failed', message: shortMessage(err) };
}

/* ------------------------------------------------------------------ */
/* The client                                                          */
/* ------------------------------------------------------------------ */

const addr = (s: string): Address => s as Address;
const num = (v: unknown): number => Number(v as bigint);

export function createVaultClient(config: VaultConfig, io: ChainIO): VaultClient {
  const factory = addr(config.factory);

  let collateralCache: Address | undefined = config.collateralToken ? addr(config.collateralToken) : undefined;
  const collateral = async (): Promise<Address> => {
    if (collateralCache) return collateralCache;
    collateralCache = (await io.read({
      address: factory,
      abi: factoryAbi,
      functionName: 'collateralToken',
    })) as Address;
    return collateralCache;
  };

  const needAccount = async (): Promise<Address | null> => io.account();

  /** Approve exactly what is about to be pulled, only if the allowance is short. */
  const ensureAllowance = async (spender: Address, owner: Address, amount: bigint) => {
    const token = await collateral();
    const allowance = (await io.read({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    })) as bigint;
    if (allowance >= amount) return;
    const r = await io.write({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
    if (!r.success) throw new Error('The approval did not confirm.');
  };

  const NO_WALLET = {
    ok: false as const,
    reason: 'no_wallet' as const,
    message: 'Connect a wallet to sign. Nothing was sent.',
  };

  return {
    config,
    account: async () => (await io.account()) ?? null,

    async walletBalance(owner) {
      return (await io.read({
        address: await collateral(),
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [addr(owner)],
      })) as bigint;
    },

    async createGuardedVault({ strategyChainId, executor, limits }) {
      if (!(await needAccount())) return NO_WALLET;
      try {
        const r = await io.write({
          address: factory,
          abi: factoryAbi,
          functionName: 'createGuardedVault',
          args: [
            addr(executor),
            strategyChainId,
            limits.assets.map(assetIdOf),
            BigInt(limits.maxDailyDrawdownBps),
          ],
        });
        if (!r.success) return { ok: false, reason: 'failed', message: 'The transaction reverted. No vault was created.' };
        const created = parseEventLogs({
          abi: factoryAbi,
          eventName: 'GuardedVaultCreated',
          logs: r.logs as never,
        });
        const vault = created[0]?.args.vault;
        if (!vault) return { ok: false, reason: 'failed', message: 'The vault address was not in the receipt.' };
        // The series the registry bound it to, as the factory emitted it.
        return { ok: true, vault, txHash: r.hash, series: created[0]?.args.series ?? '' };
      } catch (err) {
        return fail(err);
      }
    },

    async createCopyVault(input) {
      if (!(await needAccount())) return NO_WALLET;
      try {
        const r = await io.write({
          address: factory,
          abi: factoryAbi,
          functionName: 'createCopyVault',
          args: [
            addr(input.leaderExecutor),
            input.leaderStrategyChainId,
            BigInt(input.allocationBps),
            BigInt(input.feeShareBps),
            addr(input.feeRecipient),
          ],
        });
        if (!r.success) return { ok: false, reason: 'failed', message: 'The transaction reverted. Nothing was followed.' };
        const created = parseEventLogs({
          abi: factoryAbi,
          eventName: 'CopyVaultCreated',
          logs: r.logs as never,
        });
        const vault = created[0]?.args.vault;
        if (!vault) return { ok: false, reason: 'failed', message: 'The vault address was not in the receipt.' };
        return { ok: true, vault, txHash: r.hash };
      } catch (err) {
        return fail(err);
      }
    },

    async deposit({ vault, amount }) {
      const owner = await needAccount();
      if (!owner) return NO_WALLET;
      if (amount <= 0n) return { ok: false, reason: 'failed', message: 'Enter an amount above zero.' };
      try {
        await ensureAllowance(addr(vault), owner, amount);
        const r = await io.write({
          address: addr(vault),
          abi: guardedVaultAbi, // `deposit(uint256)` is the same selector on both vault kinds
          functionName: 'deposit',
          args: [amount],
        });
        if (!r.success) return { ok: false, reason: 'failed', message: 'The deposit reverted. Nothing moved.' };
        return { ok: true, txHash: r.hash };
      } catch (err) {
        return fail(err);
      }
    },

    async withdraw({ vault, amount }) {
      if (!(await needAccount())) return NO_WALLET;
      if (amount <= 0n) return { ok: false, reason: 'failed', message: 'Enter an amount above zero.' };
      try {
        const r = await io.write({
          address: addr(vault),
          abi: guardedVaultAbi,
          functionName: 'withdraw',
          args: [amount],
        });
        if (!r.success) return { ok: false, reason: 'failed', message: 'The withdrawal reverted. Nothing moved.' };
        return { ok: true, txHash: r.hash };
      } catch (err) {
        return fail(err);
      }
    },

    async setFollowing({ vault, active }) {
      if (!(await needAccount())) return NO_WALLET;
      try {
        const r = await io.write({
          address: addr(vault),
          abi: copyVaultAbi,
          functionName: 'setActive',
          args: [active],
        });
        if (!r.success) return { ok: false, reason: 'failed', message: 'The transaction reverted.' };
        return { ok: true, txHash: r.hash };
      } catch (err) {
        return fail(err);
      }
    },

    async listGuardedVaults(owner) {
      return (await io.read({
        address: factory,
        abi: factoryAbi,
        functionName: 'guardedVaultsOf',
        args: [addr(owner)],
      })) as string[];
    },

    async listCopyVaults(follower) {
      return (await io.read({
        address: factory,
        abi: factoryAbi,
        functionName: 'copyVaultsOf',
        args: [addr(follower)],
      })) as string[];
    },

    async readGuardedVault(vault) {
      const a = addr(vault);
      const r = (functionName: string, args?: readonly unknown[]) =>
        io.read({ address: a, abi: guardedVaultAbi, functionName, ...(args ? { args } : {}) });
      const now = await io.now();
      const day = BigInt(Math.floor(now / 86_400));

      const [owner, executor, strategyId, registry, bps, balance, length, realized, reference] = await Promise.all([
        r('owner'),
        r('strategyExecutor'),
        r('strategyId'),
        r('registry'),
        r('maxDailyDrawdownBps'),
        r('totalCollateral'),
        r('whitelistLength'),
        r('dailyRealizedPnL', [day]),
        r('dailyReferenceBalance', [day]),
      ]);

      // A vault's series is its strategy's pinned series, held by the registry.
      const pinned = (await io.read({
        address: registry as Address,
        abi: registryAbi,
        functionName: 'strategies',
        args: [strategyId as bigint],
      })) as readonly unknown[];
      const series = pinned[7] as string;

      const ids = await Promise.all(
        Array.from({ length: num(length) }, (_, i) => r('whitelistedAssetIds', [BigInt(i)]) as Promise<string>),
      );
      const assets: string[] = [];
      const unknownAssetIds: string[] = [];
      for (const id of ids) {
        const symbol = symbolOfAssetId(id);
        if (symbol) assets.push(symbol);
        else unknownAssetIds.push(id);
      }

      return {
        address: vault,
        owner: owner as string,
        executor: executor as string,
        strategyChainId: String(strategyId as bigint),
        series,
        limits: { assets, maxDailyDrawdownBps: num(bps) },
        unknownAssetIds,
        balance: balance as bigint,
        today: {
          utcDay: Number(day),
          // The vault snapshots its balance at the first proposal of the day; before that, today's base is the live balance.
          referenceBalance: (reference as bigint) === 0n ? (balance as bigint) : (reference as bigint),
          realizedPnl: realized as bigint,
        },
      };
    },

    async readCopyVault(vault) {
      const a = addr(vault);
      const r = (functionName: string) => io.read({ address: a, abi: copyVaultAbi, functionName });
      const [follower, executor, strategyId, alloc, fee, recipient, active, balance, next] = await Promise.all([
        r('follower'),
        r('leaderExecutor'),
        r('leaderStrategyId'),
        r('allocationBps'),
        r('feeShareBps'),
        r('feeRecipient'),
        r('active'),
        r('collateral'),
        r('nextPositionId'),
      ]);
      return {
        address: vault,
        follower: follower as string,
        leaderExecutor: executor as string,
        leaderStrategyChainId: String(strategyId as bigint),
        allocationBps: num(alloc),
        feeShareBps: num(fee),
        feeRecipient: recipient as string,
        active: active as boolean,
        balance: balance as bigint,
        mirroredPositions: num(next),
      };
    },

    async readRefusals(vault, opts) {
      const fromBlock = opts?.fromBlock ?? config.startBlock;
      const logs = await io.logs({ address: addr(vault), abi: guardedVaultAbi, eventName: 'TradeRefused', fromBlock });
      const out: RawRefusal[] = [];

      // The specific predicate and its number are on RefusalGate's own log in the same transaction.
      let gateLogs: ChainLog[] | undefined;
      const needsGate = logs.some((l) => decodeBytes32Text(String(l.args.reason)) === 'PREDICATE_NOT_SATISFIED');
      if (needsGate) {
        const gate = (await io.read({
          address: factory,
          abi: factoryAbi,
          functionName: 'refusalGate',
        })) as Address;
        gateLogs = await io.logs({
          address: gate,
          abi: refusalGateAbi,
          eventName: 'TradeRefused',
          fromBlock,
          args: { proposer: addr(vault) },
        });
      }

      for (const l of logs) {
        const reason = decodeBytes32Text(String(l.args.reason));
        const g = reason === 'PREDICATE_NOT_SATISFIED'
          ? gateLogs?.find((x) => x.transactionHash === l.transactionHash)
          : undefined;
        out.push({
          txHash: l.transactionHash,
          blockNumber: l.blockNumber,
          assetId: String(l.args.assetId),
          reason,
          decidingValue: BigInt(l.args.decidingValue as bigint),
          gate: g
            ? { symbol: decodeBytes32Text(String(g.args.predicateSymbol)), decidingValue: BigInt(g.args.decidingValue as bigint) }
            : undefined,
        });
      }
      return out.sort((x, y) => (x.blockNumber === y.blockNumber ? 0 : x.blockNumber > y.blockNumber ? -1 : 1));
    },

    async seriesDecimals(series) {
      const expo = (await io.read({ address: addr(series), abi: seriesAbi, functionName: 'priceExpo' })) as number;
      return expo < 0 ? -expo : 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/* viem adapter                                                        */
/* ------------------------------------------------------------------ */

export interface ViemChainIOOptions {
  chainId: number;
  rpcUrl: string;
  /**
   * The same signer the pin client is given: the Privy embedded wallet's
   * EIP-1193 provider and address, resolved at the moment of signing. Return
   * null when nobody is signed in or no wallet exists; writes then fail as
   * `no_wallet` instead of pretending.
   */
  getSigner: () => Promise<Signer | null>;
}

export function createViemChainIO(opts: ViemChainIOOptions): ChainIO {
  const chain = defineChain({
    id: opts.chainId,
    name: opts.chainId === 143 ? 'Monad' : `chain-${opts.chainId}`,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });

  const signer = async () => {
    const s = await opts.getSigner();
    if (!s) return null;
    const wallet = createWalletClient({ account: s.address, chain, transport: custom(s.provider) });
    return { wallet, account: s.address };
  };

  return {
    chainId: opts.chainId,
    async account() {
      return (await signer())?.account ?? null;
    },
    read: (c) =>
      publicClient.readContract({
        address: c.address,
        abi: c.abi,
        functionName: c.functionName,
        ...(c.args ? { args: c.args } : {}),
      } as never),
    async write(c) {
      const s = await signer();
      if (!s) throw new Error('no wallet');
      try {
        await s.wallet.switchChain({ id: opts.chainId });
      } catch {
        // A provider that cannot switch is already on the right chain, or the send below says otherwise.
      }
      const hash = await s.wallet.writeContract({
        address: c.address,
        abi: c.abi,
        functionName: c.functionName,
        ...(c.args ? { args: c.args } : {}),
        account: s.account,
        chain,
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { hash, success: receipt.status === 'success', logs: receipt.logs as unknown as ReceiptLog[] };
    },
    async logs(q) {
      const logs = await publicClient.getContractEvents({
        address: q.address,
        abi: q.abi,
        eventName: q.eventName,
        fromBlock: q.fromBlock,
        toBlock: 'latest',
        ...(q.args ? { args: q.args } : {}),
      } as never);
      return (logs as unknown as Array<{ transactionHash: string; blockNumber: bigint; args: Record<string, unknown> }>).map(
        (l) => ({ transactionHash: l.transactionHash, blockNumber: l.blockNumber, args: l.args }),
      );
    },
    async now() {
      return Number((await publicClient.getBlock()).timestamp);
    },
  };
}

export { vaultAssetSymbol };
