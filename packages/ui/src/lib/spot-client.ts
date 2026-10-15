/**
 * The seam between the spot screen and the chain.
 *
 * `SpotClient` is what the screen calls to read the signing wallet and to send
 * from it: the open mint, an approval, a market order on the Kuru order book.
 * It is injected, as `PinClient` is, so the screen carries no chain library and
 * a build with no wallet swaps in `unavailableSpotClient`, which says why
 * instead of pretending. `spot-viem.ts` is the real implementation.
 *
 * Every transaction here is the person's own: their wallet signs it and pays
 * for it. No key of Kanon's is involved, and the gateway only reads.
 *
 * The rule this file exists to hold, the same as `pin.ts`: a fill is reported
 * only when a receipt carries it. Nothing here returns a fill it did not decode.
 */

import type { Decimal } from '@kanon/spec';
import {
  SPOT_NO_WALLET,
  type SpotAvailability,
  type SpotFailure,
  type SpotFailureInfo,
  type SpotMarket,
  type SpotOrder,
  type SpotOrderReceipt,
  type SpotStep,
  type SpotTxKind,
  type SpotWallet,
} from './spot';

export class SpotError extends Error {
  readonly code: SpotFailure;
  /** The transaction the failure is about, when one was sent: evidence, one press away. */
  readonly txHash: string | undefined;
  /** Which transaction that is, so its link is named for what it was. */
  readonly txKind: SpotTxKind | undefined;
  constructor(code: SpotFailure, message: string, txHash?: string, txKind?: SpotTxKind) {
    super(message);
    this.name = 'SpotError';
    this.code = code;
    this.txHash = txHash;
    this.txKind = txHash ? txKind : undefined;
  }
}

export interface SpotClient {
  /** The chain this client signs for. A market on another chain cannot be traded from it. */
  chainId: number;
  availability(): SpotAvailability;
  /** The signing wallet: its gas, both token balances, and what the market may already move of each. */
  readWallet(market: SpotMarket): Promise<SpotWallet>;
  /** Mints `amount` of one of the market's two test tokens to the signing wallet, from the token's own open mint. */
  mint(market: SpotMarket, which: 'base' | 'quote', amount: Decimal): Promise<{ txHash: string }>;
  /**
   * Sends a market order from the signing wallet: an approval of exactly what
   * the order spends when the allowance is short, then the order, fill or kill.
   * Resolves with what the receipt says. `onStep` is told where it has got to.
   */
  placeOrder(market: SpotMarket, order: SpotOrder, onStep?: (step: SpotStep) => void): Promise<SpotOrderReceipt>;
}

export function spotAvailability(input: { hasWallet: boolean }): SpotAvailability {
  return input.hasWallet ? { state: 'ready' } : { state: 'no_wallet', message: SPOT_NO_WALLET };
}

/** A client that reads nothing and sends nothing, and says why. Used when there is no wallet to sign with. */
export function unavailableSpotClient(input: { chainId: number }): SpotClient {
  const fail = (): never => {
    throw new SpotError('no_wallet', SPOT_NO_WALLET);
  };
  return {
    chainId: input.chainId,
    availability: () => spotAvailability({ hasWallet: false }),
    readWallet: async () => fail(),
    mint: async () => fail(),
    placeOrder: async () => fail(),
  };
}

export const SPOT_UNKNOWN_FAILURE =
  'Something stopped before a result could be read. Check the balances above before sending again.';

/** Whatever a client threw, as the code and sentence the screen shows. Only a `SpotError` is taken at its word. */
export function spotFailure(err: unknown): SpotFailureInfo {
  if (err instanceof SpotError) return { code: err.code, message: err.message, txHash: err.txHash, txKind: err.txKind };
  // Not one of this client's own failures, so nothing is claimed about what did or did not happen.
  return { code: 'failed', message: SPOT_UNKNOWN_FAILURE };
}
