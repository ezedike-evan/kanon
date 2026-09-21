import { indexer } from "envio";
import { evidence, logId, newVault } from "../lib/helpers";
import { strategyKey } from "./strategyRegistry";

/**
 * VaultFactory: the only source of GuardedVault and CopyVault addresses.
 *
 * contractRegister runs during historical sync and tells Envio to start
 * indexing the new vault's events from its creation block. The onEvent handler
 * then records the vault's immutable configuration and owner, which is what
 * lets every later row be attributed to a person rather than a contract.
 */

indexer.contractRegister({ contract: "VaultFactory", event: "GuardedVaultCreated" }, async ({ event, context }) => {
  context.chain.GuardedVault.add(event.params.vault);
});

indexer.contractRegister({ contract: "VaultFactory", event: "CopyVaultCreated" }, async ({ event, context }) => {
  context.chain.CopyVault.add(event.params.vault);
});

indexer.onEvent({ contract: "VaultFactory", event: "GuardedVaultCreated" }, async ({ event, context }) => {
  const p = event.params;
  context.Vault.set({
    ...newVault(event.chainId, p.vault, "GUARDED", event.block.timestamp),
    ownerAddress: p.owner,
    factory: event.srcAddress,
    createdAt: event.block.timestamp,
    strategy_id: strategyKey(event.chainId, p.strategyId),
    executor: p.strategyExecutor,
    series: p.series,
    maxDailyDrawdownBps: Number(p.maxDailyDrawdownBps),
    whitelistedAssetIds: [...p.whitelistedAssetIds],
  });
});

indexer.onEvent({ contract: "VaultFactory", event: "CopyVaultCreated" }, async ({ event, context }) => {
  const p = event.params;
  context.Vault.set({
    ...newVault(event.chainId, p.vault, "COPY", event.block.timestamp),
    ownerAddress: p.follower,
    factory: event.srcAddress,
    createdAt: event.block.timestamp,
    leaderStrategy_id: strategyKey(event.chainId, p.leaderStrategyId),
    executor: p.leaderExecutor,
    allocationBps: Number(p.allocationBps),
    feeShareBps: Number(p.feeShareBps),
    feeRecipient: p.feeRecipient,
  });
});

/**
 * A vault looser than the owner's current posture must wait out a cooling-off
 * period, mirroring the registry's loosening rule. The request is the visible
 * start of that wait.
 */
indexer.onEvent({ contract: "VaultFactory", event: "LooserVaultRequested" }, async ({ event, context }) => {
  const p = event.params;
  context.LooserVaultRequest.set({
    id: logId(event),
    chainId: event.chainId,
    factory: event.srcAddress,
    owner: p.owner,
    strategy_id: strategyKey(event.chainId, p.strategyId),
    requestId: p.requestId,
    availableAt: Number(p.availableAt),
    ...evidence(event),
  });
});
