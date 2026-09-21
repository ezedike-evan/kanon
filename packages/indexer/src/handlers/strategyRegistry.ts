import { indexer } from "envio";
import type { Strategy } from "envio";
import { evidence, logId, scopedId } from "../lib/helpers";

/**
 * StrategyRegistry: the pinned-spec timeline. Tightening is immediate, loosening
 * waits out a cooling-off period, and both are recorded as StrategyEvent rows so
 * a client can replay "what was the rule, and when did it change".
 *
 * Every spec change now carries three things: the spec hash, a commitment to the
 * predicate list, and the CanonicalSeries the strategy is bound to. All three
 * are stored on Strategy (active and pending) and on each StrategyEvent.
 *
 * Strategy ids are `${chainId}_${strategyId}`. RefusalGate events carry the
 * strategy id but not the registry address, so one registry per chain is assumed
 * (config.yaml lists exactly one).
 */

export const strategyKey = (chainId: number, strategyId: bigint | string): string => scopedId(chainId, strategyId);

indexer.onEvent({ contract: "StrategyRegistry", event: "StrategyPinned" }, async ({ event, context }) => {
  const key = strategyKey(event.chainId, event.params.strategyId);
  const strategy: Strategy = {
    id: key,
    chainId: event.chainId,
    registry: event.srcAddress,
    strategyId: event.params.strategyId.toString(),
    owner: event.params.owner,
    activeSpecHash: event.params.specHash,
    predicatesCommitment: event.params.predicatesCommitment,
    series: event.params.series,
    bond: event.params.bond,
    pinnedAt: event.block.timestamp,
    pendingSpecHash: undefined,
    pendingPredicatesCommitment: undefined,
    pendingSeries: undefined,
    cooldownEndsAt: undefined,
    tightenCount: 0,
    looseningCount: 0,
    proposalCount: 0,
    refusalCount: 0,
    lastActivityAt: event.block.timestamp,
  };
  context.Strategy.set(strategy);
  context.StrategyEvent.set({
    id: logId(event),
    strategy_id: key,
    chainId: event.chainId,
    kind: "PINNED",
    oldSpecHash: undefined,
    newSpecHash: event.params.specHash,
    predicatesCommitment: event.params.predicatesCommitment,
    series: event.params.series,
    oldPredicatesCommitment: undefined,
    oldSeries: undefined,
    cooldownEndsAt: undefined,
    bond: event.params.bond,
    actor: event.params.owner,
    ...evidence(event),
  });
});

indexer.onEvent({ contract: "StrategyRegistry", event: "Tightened" }, async ({ event, context }) => {
  const key = strategyKey(event.chainId, event.params.strategyId);
  const strategy = await context.Strategy.get(key);
  if (strategy) {
    // A tighten supersedes any in-flight loosening, mirroring the contract.
    context.Strategy.set({
      ...strategy,
      activeSpecHash: event.params.newSpecHash,
      predicatesCommitment: event.params.newPredicatesCommitment,
      series: event.params.newSeries,
      pendingSpecHash: undefined,
      pendingPredicatesCommitment: undefined,
      pendingSeries: undefined,
      cooldownEndsAt: undefined,
      tightenCount: strategy.tightenCount + 1,
      lastActivityAt: event.block.timestamp,
    });
  }
  context.StrategyEvent.set({
    id: logId(event),
    strategy_id: key,
    chainId: event.chainId,
    kind: "TIGHTENED",
    oldSpecHash: event.params.oldSpecHash,
    newSpecHash: event.params.newSpecHash,
    predicatesCommitment: event.params.newPredicatesCommitment,
    series: event.params.newSeries,
    oldPredicatesCommitment: strategy?.predicatesCommitment,
    oldSeries: strategy?.series,
    cooldownEndsAt: undefined,
    bond: undefined,
    actor: strategy?.owner,
    ...evidence(event),
  });
});

indexer.onEvent({ contract: "StrategyRegistry", event: "LooseningProposed" }, async ({ event, context }) => {
  const key = strategyKey(event.chainId, event.params.strategyId);
  const strategy = await context.Strategy.get(key);
  const cooldownEndsAt = Number(event.params.cooldownEndsAt);
  if (strategy) {
    context.Strategy.set({
      ...strategy,
      pendingSpecHash: event.params.pendingSpecHash,
      pendingPredicatesCommitment: event.params.pendingPredicatesCommitment,
      pendingSeries: event.params.pendingSeries,
      cooldownEndsAt,
      looseningCount: strategy.looseningCount + 1,
      lastActivityAt: event.block.timestamp,
    });
  }
  context.StrategyEvent.set({
    id: logId(event),
    strategy_id: key,
    chainId: event.chainId,
    kind: "LOOSENING_PROPOSED",
    oldSpecHash: strategy?.activeSpecHash,
    newSpecHash: event.params.pendingSpecHash,
    predicatesCommitment: event.params.pendingPredicatesCommitment,
    series: event.params.pendingSeries,
    oldPredicatesCommitment: strategy?.predicatesCommitment,
    oldSeries: strategy?.series,
    cooldownEndsAt,
    bond: undefined,
    actor: strategy?.owner,
    ...evidence(event),
  });
});

indexer.onEvent({ contract: "StrategyRegistry", event: "LooseningFinalized" }, async ({ event, context }) => {
  const key = strategyKey(event.chainId, event.params.strategyId);
  const strategy = await context.Strategy.get(key);
  if (strategy) {
    context.Strategy.set({
      ...strategy,
      activeSpecHash: event.params.newSpecHash,
      predicatesCommitment: event.params.newPredicatesCommitment,
      series: event.params.newSeries,
      pendingSpecHash: undefined,
      pendingPredicatesCommitment: undefined,
      pendingSeries: undefined,
      cooldownEndsAt: undefined,
      lastActivityAt: event.block.timestamp,
    });
  }
  context.StrategyEvent.set({
    id: logId(event),
    strategy_id: key,
    chainId: event.chainId,
    kind: "LOOSENING_FINALIZED",
    oldSpecHash: event.params.oldSpecHash,
    newSpecHash: event.params.newSpecHash,
    predicatesCommitment: event.params.newPredicatesCommitment,
    series: event.params.newSeries,
    oldPredicatesCommitment: strategy?.predicatesCommitment,
    oldSeries: strategy?.series,
    cooldownEndsAt: undefined,
    bond: undefined,
    // Finalizing is permissionless, so the sender is not necessarily the owner.
    actor: event.transaction.from,
    ...evidence(event),
  });
});
