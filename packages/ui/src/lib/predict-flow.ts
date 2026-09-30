/**
 * Taking a side, as one flow: check the market is open, make sure it exists
 * on-chain with the terms on the card, stake, then record it.
 *
 * Every step that could be a lie is a step that can stop the flow. A closed
 * market stops it before a wallet is asked to sign. A chain market that does
 * not match the card stops it before any value moves. A stake is reported only
 * when the chain accepted it, and if the app then fails to save the record the
 * outcome says so instead of hiding it: the chain is the record.
 */

import { canTakeSide, marketPhase, sideTakesYes, type Decimal, type MarketSide } from '@kanon/spec';
import {
  MarketError,
  stakeToWei,
  type ChainMarketRef,
  type MarketClient,
  type OnChainTerms,
} from './market-client';
import type { PredictMarket, TakeSideOutcome } from './predict-types';
import { recordWithWalletLink, replyFailed, type WalletLinkDeps } from './wallet-link';

export interface PredictActions {
  /** `markets.linkChainMarket`. First link wins; the result says whether this one did. */
  linkChainMarket(args: {
    marketId: string;
    chainId: number;
    address: string;
    chainMarketId: string;
    txHash: string;
  }): Promise<{ linked: boolean; chain: ChainMarketRef | { chainId: number; address: string; marketId: string; txHash: string } }>;
  /**
   * `predictions.recordPosition`. The server reads the stake, side and staker
   * from the transaction on the chain: only the hash goes up.
   */
  recordPosition(args: { marketId: string; txHash: string; walletSignature?: string }): Promise<unknown>;
  /** `users.walletLinkChallenge`, for the first record from a wallet the server has not linked yet. */
  walletLinkMessage?: WalletLinkDeps['walletLinkMessage'];
}

const FAILURE_MESSAGES = {
  closed: 'This market is closed to new sides.',
  no_user: 'Sign in to take a side.',
  demo: 'Demo data. Sign in to take a side.',
  invalid_stake: 'Choose a stake first.',
} as const;

export function onChainTerms(m: PredictMarket): OnChainTerms {
  return {
    asset: m.asset,
    direction: m.direction,
    thresholdPrice: m.target,
    windowStart: m.windowStart,
    windowEnd: m.windowEnd,
    bucketSeconds: m.terms?.bucketSeconds ?? 900,
  };
}

export async function takeMarketSide(input: {
  market: PredictMarket | undefined;
  side: MarketSide;
  stake: Decimal;
  nowSeconds: number;
  userId: string | undefined;
  client: MarketClient;
  actions: PredictActions;
}): Promise<TakeSideOutcome> {
  const { market, side, stake, nowSeconds, userId, client, actions } = input;

  if (!market) return { ok: false, reason: 'closed', message: FAILURE_MESSAGES.closed };
  if (market.demo) return { ok: false, reason: 'demo', message: FAILURE_MESSAGES.demo };
  if (!userId) return { ok: false, reason: 'no_user', message: FAILURE_MESSAGES.no_user };
  if (stakeToWei(stake) === null) {
    return { ok: false, reason: 'invalid_stake', message: FAILURE_MESSAGES.invalid_stake };
  }
  if (!canTakeSide(marketPhase(market, nowSeconds))) {
    return { ok: false, reason: 'closed', message: FAILURE_MESSAGES.closed };
  }

  const availability = client.availability();
  if (availability.state !== 'ready') {
    const reason = availability.state === 'no_wallet' ? 'no_wallet' : availability.state === 'demo' ? 'demo' : 'not_deployed';
    return { ok: false, reason, message: availability.message };
  }

  try {
    const terms = onChainTerms(market);
    let ensured = await client.ensureMarket(terms, market.chain ?? undefined);

    if (ensured.opened) {
      // We opened it. Tell the backend, and if someone linked another market first, stake on theirs
      // once it has been checked against the same terms.
      const linked = await actions
        .linkChainMarket({
          marketId: market.id,
          chainId: ensured.chainId,
          address: ensured.address,
          chainMarketId: ensured.marketId,
          txHash: ensured.txHash,
        })
        .catch(() => null);
      if (linked && !linked.linked) {
        ensured = await client.ensureMarket(terms, {
          chainId: linked.chain.chainId,
          address: linked.chain.address,
          marketId: linked.chain.marketId,
          txHash: linked.chain.txHash,
        });
      }
    }

    const { txHash } = await client.takeSide({
      chainMarketId: ensured.marketId,
      yes: sideTakesYes(market.direction, side),
      stake,
    });

    let recorded = true;
    try {
      const reply = await recordWithWalletLink(
        (extra) => actions.recordPosition({ marketId: market.id, txHash, ...extra }),
        { walletLinkMessage: actions.walletLinkMessage, signMessage: client.signMessage?.bind(client) },
      );
      if (replyFailed(reply)) recorded = false;
    } catch {
      recorded = false;
    }
    return { ok: true, txHash, recorded };
  } catch (err) {
    if (err instanceof MarketError) return { ok: false, reason: err.code, message: err.message };
    return {
      ok: false,
      reason: 'failed',
      message: err instanceof Error && err.message ? err.message : 'The transaction did not go through.',
    };
  }
}
