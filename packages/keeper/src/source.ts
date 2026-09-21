import { marginAccountAbi } from './abi';
import type { ChainPort } from './port';

export interface DiscoveryResult {
  /** Accounts that may hold open positions. Duplicates and repeats across polls are fine. */
  accounts: `0x${string}`[];
  /** Inclusive block range this poll covered, when the source is block-based. */
  fromBlock?: bigint;
  toBlock?: bigint;
}

/**
 * Where the keeper learns which accounts to look at. Pluggable on purpose: the
 * event-log scan below is the v1 source, and the Envio indexer (packages/indexer)
 * can replace it by implementing this one method.
 *
 * A source only nominates candidates. The keeper never trusts it for a
 * decision: every candidate is checked against the contract's own views, so a
 * source that over-reports costs a few reads and one that under-reports is the
 * only way an account is missed.
 */
export interface AccountSource {
  poll(port: ChainPort): Promise<DiscoveryResult>;
}

export interface LogSourceOptions {
  marginAddress: `0x${string}`;
  startBlock: bigint;
  /** Widest eth_getLogs range requested at once. */
  rangeBlocks: bigint;
  /** Blocks behind the previous head that are re-scanned, so a reorg cannot hide an event. */
  reorgDepth: bigint;
}

/**
 * Scans `MarginAccount.PositionOpened` events. Every account that has ever
 * opened a position is a candidate; the keeper prunes the ones with nothing
 * open. Progress is kept per chunk, so a failure in the middle of a long
 * back-fill resumes where it stopped instead of starting over.
 */
export function createLogSource(opts: LogSourceOptions): AccountSource & { cursor(): bigint | undefined } {
  let scannedTo: bigint | undefined;

  return {
    cursor: () => scannedTo,
    async poll(port) {
      const head = await port.blockNumber();
      const rewind = scannedTo === undefined ? opts.startBlock : scannedTo + 1n - opts.reorgDepth;
      const from = rewind < opts.startBlock ? opts.startBlock : rewind;
      const found = new Map<string, `0x${string}`>();
      if (from > head) return { accounts: [], fromBlock: from, toBlock: head };

      let cursor = from;
      while (cursor <= head) {
        const end = cursor + opts.rangeBlocks - 1n > head ? head : cursor + opts.rangeBlocks - 1n;
        let logs;
        try {
          logs = await port.getLogs({
            address: opts.marginAddress,
            abi: marginAccountAbi,
            eventName: 'PositionOpened',
            fromBlock: cursor,
            toBlock: end,
          });
        } catch (e) {
          // Keep what earlier chunks found; the next poll resumes at `cursor`.
          if (cursor > from) scannedTo = cursor - 1n;
          throw new PartialDiscoveryError([...found.values()], e);
        }
        for (const l of logs) {
          const a = l.args['account'];
          if (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) found.set(a.toLowerCase(), a as `0x${string}`);
        }
        scannedTo = end;
        cursor = end + 1n;
      }
      return { accounts: [...found.values()], fromBlock: from, toBlock: head };
    },
  };
}

/** A back-fill failed part way. `accounts` holds what the earlier chunks found. */
export class PartialDiscoveryError extends Error {
  constructor(
    public readonly accounts: `0x${string}`[],
    public readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'PartialDiscoveryError';
  }
}
