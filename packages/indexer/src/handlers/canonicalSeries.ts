import { indexer } from "envio";
import { logId, scopedId } from "../lib/helpers";

/**
 * CanonicalSeries: every recorded price sample. These are the tape the
 * predicates run over, and the input to "would this refusal have lost": pair a
 * refusal's timestamp with the samples on either side of it.
 *
 * Price and exponent are stored exactly as emitted (Pyth: price * 10^expo).
 * Never converted to floats here.
 */
indexer.onEvent({ contract: "CanonicalSeries", event: "SampleRecorded" }, async ({ event, context }) => {
  const p = event.params;
  context.PriceSample.set({
    id: `${scopedId(event.chainId, event.srcAddress, p.bucketIndex)}_${logId(event)}`,
    chainId: event.chainId,
    series: event.srcAddress,
    bucketIndex: p.bucketIndex.toString(),
    price: p.price,
    expo: Number(p.expo),
    publishTime: Number(p.publishTime),
    caller: p.caller,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  });
});
