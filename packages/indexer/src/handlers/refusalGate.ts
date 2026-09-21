import { indexer } from "envio";
import type { Refusal } from "envio";
import { bumpAccount, decodeBytes32Text, evidence, logId, tradeLog } from "../lib/helpers";
import { strategyKey } from "./strategyRegistry";

/**
 * RefusalGate: every accepted proposal and every refusal.
 *
 * A refusal is a success state, so it is stored as first-class data, not as an
 * error. The evidence anchor is (specHash, txHash, blockNumber, logIndex): the
 * spec hash the check ran against and the exact log that proves it.
 *
 * `decidingValue` is the predicate-specific number that failed the check (a gap,
 * a distance). It is NOT a price. To ask "would this refusal have lost", pair
 * the refusal's timestamp with PriceSample rows of the series the strategy
 * trades (see getRefusalOutcomeInputs in src/client.ts).
 */

indexer.onEvent({ contract: "RefusalGate", event: "TradeProposed" }, async ({ event, context }) => {
  const key = strategyKey(event.chainId, event.params.strategyId);
  const id = logId(event);
  const ev = evidence(event);

  context.TradeLog.set(
    tradeLog(
      {
        id,
        chainId: event.chainId,
        kind: "PROPOSED",
        account: event.params.proposer,
        contractAddress: event.srcAddress,
        contractName: "RefusalGate",
        ...ev,
      },
      { actor: event.params.proposer, strategy_id: key, specHash: event.params.specHash },
    ),
  );
  await bumpAccount(context.Account, event.chainId, event.params.proposer, ev.timestamp, "proposalCount");

  const strategy = await context.Strategy.get(key);
  if (strategy) {
    context.Strategy.set({ ...strategy, proposalCount: strategy.proposalCount + 1, lastActivityAt: ev.timestamp });
  }
});

indexer.onEvent({ contract: "RefusalGate", event: "TradeRefused" }, async ({ event, context }) => {
  const key = strategyKey(event.chainId, event.params.strategyId);
  const id = logId(event);
  const ev = evidence(event);
  const predicate = decodeBytes32Text(event.params.predicateSymbol);

  const refusal: Refusal = {
    id,
    chainId: event.chainId,
    gate: event.srcAddress,
    strategy_id: key,
    specHash: event.params.specHash,
    proposer: event.params.proposer,
    account: event.params.proposer,
    actor: event.params.proposer,
    vault: undefined,
    predicate,
    predicateRaw: event.params.predicateSymbol,
    decidingValue: event.params.decidingValue,
    ...ev,
  };
  context.Refusal.set(refusal);

  context.TradeLog.set(
    tradeLog(
      {
        id,
        chainId: event.chainId,
        kind: "REFUSED",
        account: event.params.proposer,
        contractAddress: event.srcAddress,
        contractName: "RefusalGate",
        ...ev,
      },
      {
        actor: event.params.proposer,
        strategy_id: key,
        specHash: event.params.specHash,
        reason: predicate,
        decidingValue: event.params.decidingValue,
        refusal_id: id,
      },
    ),
  );
  await bumpAccount(context.Account, event.chainId, event.params.proposer, ev.timestamp, "refusalCount");

  const strategy = await context.Strategy.get(key);
  if (strategy) {
    context.Strategy.set({ ...strategy, refusalCount: strategy.refusalCount + 1, lastActivityAt: ev.timestamp });
  }
});
