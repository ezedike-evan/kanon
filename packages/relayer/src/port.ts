import type { Abi } from 'viem';

export interface ContractCall {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Native value in wei. Only Pyth's `updatePriceFeeds` takes any. */
  value?: bigint;
}

/**
 * Everything the relayer needs from a chain, and nothing more. The relay logic
 * talks to this port, never to viem, so tests hand it a plain fake and the real
 * viem client is confined to `viem-port.ts`.
 */
export interface ChainPort {
  chainId(): Promise<number>;
  latestBlockTimestamp(): Promise<bigint>;
  read(call: ContractCall): Promise<unknown>;
  /** An `eth_call` of the write. Throws with the revert reason if it would fail. Never sends. */
  simulate(call: ContractCall): Promise<void>;
  /** Signs, sends and waits for the receipt. The only method that spends anything. */
  send(call: ContractCall): Promise<{ hash: `0x${string}`; success: boolean }>;
}
