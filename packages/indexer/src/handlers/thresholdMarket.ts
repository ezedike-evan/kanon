import { indexer } from "envio";
import { evidence, logId, scopedId } from "../lib/helpers";

/**
 * ThresholdMarket: prediction markets over CanonicalSeries. Bets, settlements
 * and claims. The (seriesId -> series contract) map is now fixed in the
 * constructor, which emits one SeriesRegistered per entry in the deployment
 * transaction, so `start_block` must be at or before the market's deployment
 * block or those rows are missed. Stakes are tracked per side on the Market so a client can render
 * the book without summing MarketBet rows.
 */

const marketKey = (chainId: number, contract: string, marketId: bigint) => scopedId(chainId, contract, marketId);

indexer.onEvent({ contract: "ThresholdMarket", event: "SeriesRegistered" }, async ({ event, context }) => {
  context.MarketSeries.set({
    id: scopedId(event.chainId, event.srcAddress, event.params.seriesId),
    chainId: event.chainId,
    contractAddress: event.srcAddress,
    seriesId: event.params.seriesId,
    seriesContract: event.params.seriesContract,
    registeredAt: event.block.timestamp,
  });
});

indexer.onEvent({ contract: "ThresholdMarket", event: "MarketOpened" }, async ({ event, context }) => {
  const p = event.params;
  context.Market.set({
    id: marketKey(event.chainId, event.srcAddress, p.marketId),
    chainId: event.chainId,
    contractAddress: event.srcAddress,
    marketId: p.marketId.toString(),
    seriesId: p.seriesId,
    thresholdPrice: p.thresholdPrice,
    above: p.above,
    windowStart: Number(p.windowStart),
    windowEnd: Number(p.windowEnd),
    status: "OPEN",
    yesWon: undefined,
    yesStake: 0n,
    noStake: 0n,
    betCount: 0,
    openedAt: event.block.timestamp,
    settledAt: undefined,
    openTxHash: event.transaction.hash,
    settleTxHash: undefined,
  });
});

indexer.onEvent({ contract: "ThresholdMarket", event: "SideTaken" }, async ({ event, context }) => {
  const { marketId, staker, takesYes, amount } = event.params;
  const key = marketKey(event.chainId, event.srcAddress, marketId);
  context.MarketBet.set({
    id: logId(event),
    chainId: event.chainId,
    market_id: key,
    staker,
    takesYes,
    amount,
    ...evidence(event),
  });
  const market = await context.Market.get(key);
  if (market) {
    context.Market.set({
      ...market,
      yesStake: takesYes ? market.yesStake + amount : market.yesStake,
      noStake: takesYes ? market.noStake : market.noStake + amount,
      betCount: market.betCount + 1,
    });
  }
});

indexer.onEvent({ contract: "ThresholdMarket", event: "MarketSettled" }, async ({ event, context }) => {
  const key = marketKey(event.chainId, event.srcAddress, event.params.marketId);
  const market = await context.Market.get(key);
  if (market) {
    context.Market.set({
      ...market,
      status: "SETTLED",
      yesWon: event.params.yesWon,
      settledAt: event.block.timestamp,
      settleTxHash: event.transaction.hash,
    });
  }
});

indexer.onEvent({ contract: "ThresholdMarket", event: "MarketUnresolvable" }, async ({ event, context }) => {
  const key = marketKey(event.chainId, event.srcAddress, event.params.marketId);
  const market = await context.Market.get(key);
  if (market) {
    context.Market.set({
      ...market,
      status: "UNRESOLVABLE",
      settledAt: event.block.timestamp,
      settleTxHash: event.transaction.hash,
    });
  }
});

indexer.onEvent({ contract: "ThresholdMarket", event: "Claimed" }, async ({ event, context }) => {
  context.MarketClaim.set({
    id: logId(event),
    chainId: event.chainId,
    market_id: marketKey(event.chainId, event.srcAddress, event.params.marketId),
    staker: event.params.staker,
    amount: event.params.amount,
    ...evidence(event),
  });
});
