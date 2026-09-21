import type { Abi } from 'viem';

export interface ContractCall {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface LogQuery {
  address: `0x${string}`;
  abi: Abi;
  eventName: string;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface LogEntry {
  blockNumber: bigint;
  args: Record<string, unknown>;
}

/**
 * Everything the keeper needs from a chain, and nothing more. The keeper logic
 * talks to this port, never to viem, so tests hand it a plain fake and the real
 * viem client is confined to `viem-port.ts`.
 */
export interface ChainPort {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  /** The network's current gas price in wei, for the fee cap check. */
  gasPrice(): Promise<bigint>;
  read(call: ContractCall): Promise<unknown>;
  /** An `eth_call` of the write. Throws with the revert reason if it would fail. Never sends. Returns the gas estimate. */
  simulate(call: ContractCall): Promise<{ gas: bigint }>;
  /** Event logs over an inclusive block range. */
  getLogs(query: LogQuery): Promise<LogEntry[]>;
  /**
   * Signs, sends and waits for the receipt. The only method that spends
   * anything. `gas` is the gas limit (Monad charges the limit, not the gas
   * used) and `maxFeePerGas` a hard ceiling on the price bid.
   */
  send(call: ContractCall, opts: { gas: bigint; maxFeePerGas: bigint }): Promise<{ hash: `0x${string}`; success: boolean }>;
}
