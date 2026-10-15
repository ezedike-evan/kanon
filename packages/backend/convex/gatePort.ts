import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  PYTH_MONAD_ADDRESS,
  decodeSourcePrice,
  encodeGetPriceUnsafe,
  type PredicateDefinition,
  type PythPrice,
} from "@kanon/spec";
import { DEFAULT_RPC_RETRIES, rpcRequest, type FetchLike, type RpcConfig } from "./chainRpc";
import type { GateEnv } from "./serverEnv";

/**
 * Everything the keeper and the gate need from the chain, and nothing more.
 * The logic in `keeperLogic.ts` and `gate.ts` talks to this port, never to
 * viem, so a test hands it a plain fake and the real client is confined to
 * `createViemGatePort` below. The same split as `packages/keeper/src/port.ts`
 * and `viem-port.ts`.
 *
 * Signing happens here, with viem's local account, in Convex's default
 * runtime. If that runtime ever refuses it, this file moves behind a
 * `"use node"` action unchanged: nothing else imports viem's wallet.
 */

export interface GateCall {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** `CanonicalSeries.getCandle`, prices in the series' own `priceExpo`. */
export interface SeriesCandle {
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  sampleCount: number;
  recorded: boolean;
}

/** One log of a receipt, as the node returns it. */
export interface GateLog {
  address: string;
  topics: string[];
  data: string;
}

export interface GateReceipt {
  status: "success" | "reverted";
  gasUsed: bigint;
  /** Wei per gas actually paid. Monad bills it on the gas limit, not on `gasUsed`. */
  effectiveGasPrice: bigint;
  blockNumber: bigint;
  /** Every log the transaction emitted. The gate's verdict is read from these (`decodeGateReceipt`). */
  logs?: GateLog[];
  to?: string | null;
}

/** What `RefusalGate.previewOnChain` takes: the strategy, the side, and the committed predicates. */
export interface GateQuestion {
  strategyId: bigint;
  isLong: boolean;
  predicates: readonly PredicateDefinition[];
}

/**
 * What `previewOnChain` answered. A revert of the gate's own (`StaleSeries`,
 * `CommitmentMismatch`, ...) is an answer, not a throw, and so is a call that
 * ran out of the gas it was given (`error: "OutOfGas"`). Anything else, a node
 * that did not answer, throws.
 */
export type PreviewAnswer =
  | { kind: "result"; allSatisfied: boolean; failingSymbol: `0x${string}`; decidingValue: bigint }
  | { kind: "revert"; error: string; args: readonly unknown[] };

/** A window of a series as one read saw it: its `priceExpo` and every bucket in it, recorded or not. */
export interface CandleWindow {
  priceExpo: number;
  candles: Array<SeriesCandle & { bucket: bigint }>;
}

export interface GatePort {
  /** The signer's address. Undefined when the port was built without a key: it can read, not send. */
  readonly signer: `0x${string}` | undefined;
  /** Unix seconds of the latest block: the clock `CanonicalSeries` buckets by. */
  blockTime(): Promise<bigint>;
  getCandle(series: `0x${string}`, bucketIndex: bigint): Promise<SeriesCandle>;
  /** The Pyth feed id a series is pinned to at construction. */
  seriesFeedId(series: `0x${string}`): Promise<`0x${string}`>;
  /** Block time of the series' last `recordSample`, 0 if never. */
  lastSampleTimestamp(series: `0x${string}`): Promise<bigint>;
  cadenceSeconds(series: `0x${string}`): Promise<bigint>;
  /** The signer's balance in wei. */
  balance(): Promise<bigint>;
  /** The network's gas price in wei, for the fee cap. */
  gasPrice(): Promise<bigint>;
  /** An `eth_estimateGas` of the write from the signer. Throws with the revert if it would fail. Never sends. */
  estimateGas(call: GateCall): Promise<bigint>;
  /**
   * Signs and sends; returns the hash without waiting. The only method that
   * spends anything. `gas` is the limit (what Monad bills) and `maxFeePerGas`
   * a hard ceiling on the price bid. The nonce is the chain's pending count,
   * fetched on every call, so a caller retries a nonce error by calling again.
   */
  send(call: GateCall, opts: { gas: bigint; maxFeePerGas: bigint }): Promise<`0x${string}`>;
  waitForReceipt(hash: `0x${string}`): Promise<GateReceipt>;
  /** Unix seconds of a block: the clock the gate bucketed its verdict by. */
  blockTimeAt(blockNumber: bigint): Promise<bigint>;
  /**
   * `RefusalGate.previewOnChain` as an `eth_call`. With `gas`, the call runs
   * under that limit: the gas probe (`gate.ts`), because the gate's try/catch
   * turns an evaluation that runs out of gas into a refusal.
   */
  previewOnChain(gate: `0x${string}`, question: GateQuestion, gas?: bigint): Promise<PreviewAnswer>;
  /**
   * The series' `priceExpo` and `getCandle` of every bucket in [from, to], in
   * one multicall, at `blockNumber` when given. What the gate's verdict is
   * replayed over (`explainFromChain`).
   */
  readCandles(series: `0x${string}`, from: bigint, to: bigint, blockNumber?: bigint): Promise<CandleWindow>;
}

/** Where the keeper reads the price it mirrors: Pyth on Monad mainnet. */
export interface PriceSource {
  /** The feed's current price, and the source chain's own block time to measure its age by. */
  read(feedId: `0x${string}`): Promise<{ price: PythPrice; sourceNowSeconds: bigint }>;
}

export const seriesAbi = parseAbi([
  "function getCandle(uint256 bucketIndex) view returns (int64 open, int64 high, int64 low, int64 close, uint32 sampleCount, bool recorded)",
  "function feedId() view returns (bytes32)",
  "function lastSampleTimestamp() view returns (uint256)",
  "function cadenceSeconds() view returns (uint256)",
  "function recordSample()",
]);

export const mockPythAbi = parseAbi([
  "function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime)",
]);

/** `CanonicalSeries.priceExpo`: the one scale every candle of a series is at. */
export const seriesExpoAbi = parseAbi(["function priceExpo() view returns (int32)"]);

/**
 * The parts of `RefusalGate` Kanon calls, and every error it can revert with.
 * `gateAbi.test.ts` holds each line to `packages/contracts/abi/RefusalGate.json`,
 * so a contract change that moves a signature fails a test, not a judgment.
 */
export const gateAbi = parseAbi([
  "struct PredicateDefinition { uint8 kind; bytes32 symbol; uint8 direction; uint256 swingLookbackCandles; uint256 minGapBps; uint8 referenceExtreme; uint8 lookback; uint256 timeframeSeconds; }",
  "function evaluateOnChain(uint256 strategyId, bool isLong, PredicateDefinition[] predicates) returns (bool allSatisfied)",
  "function previewOnChain(uint256 strategyId, bool isLong, PredicateDefinition[] predicates) view returns (bool allSatisfied, bytes32 failingSymbol, int256 decidingValue)",
  "function registry() view returns (address)",
  "event TradeProposed(uint256 indexed strategyId, bytes32 indexed specHash, address indexed proposer)",
  "event TradeRefused(uint256 indexed strategyId, bytes32 indexed specHash, address indexed proposer, bytes32 predicateSymbol, int256 decidingValue)",
  "error CommitmentMismatch(bytes32 committed, bytes32 supplied)",
  "error InconsistentSweepDirection(uint256 predicateIndex)",
  "error InsufficientCandles(uint256 needed, uint256 available)",
  "error InvalidPredicate()",
  "error InvalidWindow()",
  "error MixedDirections()",
  "error NoPredicates()",
  "error NoReferenceHistory()",
  "error OnlySelf()",
  "error StaleSeries(uint256 bucketIndex)",
  "error TimeframeMismatch(uint256 seriesBucketSeconds, uint256 predicateTimeframeSeconds)",
  "error UnknownStrategy()",
  "error WindowTooWide()",
]);

/** Multicall3, at the address it has on every chain it is deployed to, Monad testnet included. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** `RefusalGate.evaluateOnChain`: the one call that writes a verdict to the chain. */
export const evaluateOnChainCall = (gate: `0x${string}`, q: GateQuestion): GateCall => ({
  address: gate,
  abi: gateAbi as Abi,
  functionName: "evaluateOnChain",
  args: [q.strategyId, q.isLong, q.predicates],
});

export const setPriceCall = (mock: `0x${string}`, feedId: `0x${string}`, p: PythPrice): GateCall => ({
  address: mock,
  abi: mockPythAbi,
  functionName: "setPrice",
  args: [feedId, p.price, p.conf, p.expo, p.publishTime],
});

export const recordSampleCall = (series: `0x${string}`): GateCall => ({
  address: series,
  abi: seriesAbi,
  functionName: "recordSample",
  args: [],
});

const RPC_TIMEOUT_MS = 10_000;
const RECEIPT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_MS = 750;

/**
 * The revert data an `eth_call` failed with, from the innermost error that
 * carries any: where viem leaves the node's answer. Undefined when there is none.
 */
function revertData(e: unknown): `0x${string}` | undefined {
  let found: `0x${string}` | undefined;
  let cur: unknown = e;
  for (let depth = 0; depth < 8 && cur && typeof cur === "object"; depth++) {
    const d = (cur as { data?: unknown }).data;
    const hex = typeof d === "string" ? d : typeof (d as { data?: unknown } | undefined)?.data === "string" ? (d as { data: string }).data : undefined;
    if (hex && /^0x[0-9a-fA-F]*$/.test(hex)) found = hex as `0x${string}`;
    cur = (cur as { cause?: unknown }).cause;
  }
  return found;
}

/** Every message an error carries, causes included: viem puts the node's own words in a cause. */
export function errorText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur; depth++) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    const x = cur as { shortMessage?: string; message?: string; details?: string; cause?: unknown };
    if (x.shortMessage) parts.push(x.shortMessage);
    if (x.message) parts.push(x.message);
    if (x.details) parts.push(x.details);
    cur = x.cause;
  }
  return parts.join("\n");
}

/**
 * The real port, over viem. Without `privateKey` there is no signer in the
 * function at all, and `send` throws before anything is built.
 */
export function createViemGatePort(env: Pick<GateEnv, "rpcUrl" | "chainId">, privateKey?: `0x${string}`): GatePort {
  const chain = defineChain({
    id: env.chainId,
    name: env.chainId === 10143 ? "Monad testnet" : `chain-${env.chainId}`,
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [env.rpcUrl] } },
  });
  const transport = http(env.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: DEFAULT_RPC_RETRIES });
  const client = createPublicClient({ chain, transport });
  const account = privateKey ? privateKeyToAccount(privateKey) : undefined;
  const wallet = account ? createWalletClient({ account, chain, transport }) : undefined;

  const read = <T>(series: `0x${string}`, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: series, abi: seriesAbi as Abi, functionName, args }) as Promise<T>;
  const calldata = (c: GateCall) =>
    encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] } as Parameters<typeof encodeFunctionData>[0]);

  return {
    signer: account?.address,
    async blockTime() {
      return (await client.getBlock({ blockTag: "latest" })).timestamp;
    },
    async getCandle(series, bucketIndex) {
      const [open, high, low, close, sampleCount, recorded] = await read<
        readonly [bigint, bigint, bigint, bigint, number, boolean]
      >(series, "getCandle", [bucketIndex]);
      return { open, high, low, close, sampleCount, recorded };
    },
    seriesFeedId: (series) => read<`0x${string}`>(series, "feedId"),
    lastSampleTimestamp: (series) => read<bigint>(series, "lastSampleTimestamp"),
    cadenceSeconds: (series) => read<bigint>(series, "cadenceSeconds"),
    async balance() {
      if (!account) throw new Error("no signer: KEEPER_PRIVATE_KEY is not set");
      return await client.getBalance({ address: account.address });
    },
    gasPrice: () => client.getGasPrice(),
    async estimateGas(c) {
      if (!account) throw new Error("no signer: KEEPER_PRIVATE_KEY is not set");
      return await client.estimateGas({ account: account.address, to: c.address, data: calldata(c) });
    },
    async send(c, opts) {
      if (!account || !wallet) throw new Error("no signer: KEEPER_PRIVATE_KEY is not set");
      // Prepared, signed and sent as three steps so the hash is known before the node answers:
      // "already known" means the node holds this very transaction, and its receipt is waited for.
      const request = await wallet.prepareTransactionRequest({
        account,
        chain,
        to: c.address,
        data: calldata(c),
        gas: opts.gas,
        maxFeePerGas: opts.maxFeePerGas,
        type: "eip1559",
      });
      const serializedTransaction = await wallet.signTransaction(request);
      const hash = keccak256(serializedTransaction);
      try {
        await wallet.sendRawTransaction({ serializedTransaction });
      } catch (e) {
        if (/already known/i.test(errorText(e))) return hash;
        throw e;
      }
      return hash;
    },
    async waitForReceipt(hash) {
      const r = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: RECEIPT_POLL_MS });
      return {
        status: r.status,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        blockNumber: r.blockNumber,
        to: r.to,
        logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics] as string[], data: l.data })),
      };
    },
    async blockTimeAt(blockNumber) {
      return (await client.getBlock({ blockNumber })).timestamp;
    },
    async previewOnChain(gate, q, gas) {
      const data = encodeFunctionData({
        abi: gateAbi,
        functionName: "previewOnChain",
        args: [q.strategyId, q.isLong, q.predicates.map((p) => ({ ...p }))],
      });
      try {
        const out = await client.call({ to: gate, data, ...(gas !== undefined ? { gas } : {}) });
        const [allSatisfied, failingSymbol, decidingValue] = decodeFunctionResult({
          abi: gateAbi,
          functionName: "previewOnChain",
          data: out.data ?? "0x",
        });
        return { kind: "result", allSatisfied, failingSymbol, decidingValue };
      } catch (e) {
        const raw = revertData(e);
        if (raw && raw.length >= 10) {
          try {
            const { errorName, args } = decodeErrorResult({ abi: gateAbi, data: raw });
            return { kind: "revert", error: errorName, args: args ?? [] };
          } catch {
            return { kind: "revert", error: "Unknown", args: [raw] };
          }
        }
        // A call that ran out of the gas it was given has no revert data: that is an answer for the probe.
        if (/out of gas|gas required exceeds|intrinsic gas too low/i.test(errorText(e))) return { kind: "revert", error: "OutOfGas", args: [] };
        // Monad's RPC answers a limit below the call's intrinsic gas as invalid parameters, not as a revert.
        if (gas !== undefined && /invalid param/i.test(errorText(e))) return { kind: "revert", error: "OutOfGas", args: [] };
        if (/revert/i.test(errorText(e))) return { kind: "revert", error: "Unknown", args: [] };
        throw e;
      }
    },
    async readCandles(series, from, to, blockNumber) {
      if (to < from) return { priceExpo: 0, candles: [] };
      const buckets: bigint[] = [];
      for (let b = from; b <= to; b++) buckets.push(b);
      const contracts = [
        { address: series, abi: seriesExpoAbi as Abi, functionName: "priceExpo", args: [] },
        ...buckets.map((bucket) => ({ address: series, abi: seriesAbi as Abi, functionName: "getCandle", args: [bucket] })),
      ];
      const results = await client.multicall({
        allowFailure: false,
        // One call, however many buckets: the window is read at one moment, not stitched from several.
        batchSize: 0,
        multicallAddress: MULTICALL3_ADDRESS,
        ...(blockNumber !== undefined ? { blockNumber } : {}),
        contracts: contracts as never,
      });
      const [expo, ...rows] = results as unknown as [number, ...Array<readonly [bigint, bigint, bigint, bigint, number, boolean]>];
      return {
        priceExpo: Number(expo),
        candles: rows.map(([open, high, low, close, sampleCount, recorded], i) => ({
          bucket: buckets[i]!,
          open,
          high,
          low,
          close,
          sampleCount,
          recorded,
        })),
      };
    },
  };
}

/**
 * Pyth on Monad mainnet, read with a plain `eth_call` (`chainRpc.ts`): the same
 * `getPriceUnsafe` the tick ingest reads, decoded by `@kanon/spec`. No key.
 */
export function createPythSource(rpcUrl: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): PriceSource {
  const cfg: RpcConfig = { url: rpcUrl, fetch: fetchImpl, retries: DEFAULT_RPC_RETRIES };
  return {
    async read(feedId) {
      const [data, block] = await Promise.all([
        rpcRequest<string>(cfg, "eth_call", [{ to: PYTH_MONAD_ADDRESS, data: encodeGetPriceUnsafe(feedId) }, "latest"]),
        rpcRequest<{ timestamp?: unknown } | null>(cfg, "eth_getBlockByNumber", ["latest", false]),
      ]);
      const ts = block?.timestamp;
      if (typeof ts !== "string" || !/^0x[0-9a-fA-F]+$/.test(ts)) throw new Error("the price source returned no block time");
      return { price: decodeSourcePrice(data), sourceNowSeconds: BigInt(ts) };
    },
  };
}
