import { indexer } from "envio";
import { evidence, logId } from "../lib/helpers";

/** InsuranceFund: the backstop that absorbs liquidation shortfalls. */

indexer.onEvent({ contract: "InsuranceFund", event: "Deposited" }, async ({ event, context }) => {
  context.FundEvent.set({
    id: logId(event),
    chainId: event.chainId,
    kind: "DEPOSIT",
    contractAddress: event.srcAddress,
    account: event.params.from,
    amount: event.params.amount,
    requested: undefined,
    covered: undefined,
    ...evidence(event),
  });
});

indexer.onEvent({ contract: "InsuranceFund", event: "PenaltyReceived" }, async ({ event, context }) => {
  context.FundEvent.set({
    id: logId(event),
    chainId: event.chainId,
    kind: "PENALTY_RECEIVED",
    contractAddress: event.srcAddress,
    account: undefined,
    amount: event.params.amount,
    requested: undefined,
    covered: undefined,
    ...evidence(event),
  });
});

indexer.onEvent({ contract: "InsuranceFund", event: "ShortfallCovered" }, async ({ event, context }) => {
  context.FundEvent.set({
    id: logId(event),
    chainId: event.chainId,
    kind: "SHORTFALL_COVERED",
    contractAddress: event.srcAddress,
    account: undefined,
    amount: undefined,
    requested: event.params.requested,
    covered: event.params.covered,
    ...evidence(event),
  });
});
