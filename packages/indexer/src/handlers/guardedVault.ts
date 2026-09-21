import { indexer } from "envio";
import { bumpAccount, decodeBytes32Text, evidence, logId, scopedId, tradeLog, updateVault } from "../lib/helpers";
import { recordFlow } from "../lib/flows";

/**
 * GuardedVault: whitelist and daily-drawdown guardrails around RefusalGate.
 * Instances are registered dynamically from VaultFactory.GuardedVaultCreated
 * (src/handlers/vaultFactory.ts), which also records the vault's owner.
 *
 * `account` on every row written here is the vault OWNER (whose rule set is
 * being enforced); `actor` is whoever called proposeTrade (the owner, or an
 * executor key acting for them).
 *
 * `proposeTrade` calls RefusalGate.evaluateOnChain in the same transaction, so a
 * predicate refusal produces TWO logs: RefusalGate.TradeRefused (with the exact
 * predicate and failing number, and the vault as `proposer`) and this
 * contract's own TradeRefused (reason PREDICATE_NOT_SATISFIED, the human
 * proposer). To keep "one row per trade" they are merged: the gate's row is
 * enriched in place with the vault, owner and actor instead of adding a
 * duplicate. Guardrail refusals (whitelist, drawdown) have no gate log and get
 * their own row.
 *
 * The merge relies on the gate log preceding the vault log in the same
 * transaction, which the call order in proposeTrade guarantees.
 */

indexer.onEvent({ contract: "GuardedVault", event: "Deposited" }, async ({ event, context }) => {
  await recordFlow(context, event, "GuardedVault", "GUARDED", "DEPOSIT", event.params.from, event.params.amount);
});

indexer.onEvent({ contract: "GuardedVault", event: "Withdrawn" }, async ({ event, context }) => {
  await recordFlow(context, event, "GuardedVault", "GUARDED", "WITHDRAWAL", event.params.to, event.params.amount);
});

indexer.onEvent({ contract: "GuardedVault", event: "TradeProposed" }, async ({ event, context }) => {
  const ev = evidence(event);
  const { proposer, assetId, isLong, size, projectedPnL } = event.params;
  const vaultRow = await context.Vault.get(scopedId(event.chainId, event.srcAddress));
  const owner = vaultRow?.ownerAddress ?? proposer;

  const sameTx = await context.TradeLog.getWhere({ txHash: { _eq: ev.txHash } });
  const gateLog = sameTx
    .filter(
      (l) =>
        l.kind === "PROPOSED" &&
        l.contractName === "RefusalGate" &&
        l.account === event.srcAddress &&
        l.vault === undefined &&
        l.logIndex < ev.logIndex,
    )
    .sort((a, b) => b.logIndex - a.logIndex)[0];

  if (gateLog) {
    context.TradeLog.set({
      ...gateLog,
      account: owner,
      actor: proposer,
      vault: event.srcAddress,
      assetId,
      isLong,
      size,
      pnl: projectedPnL,
    });
  } else {
    context.TradeLog.set(
      tradeLog(
        {
          id: logId(event),
          chainId: event.chainId,
          kind: "PROPOSED",
          account: owner,
          contractAddress: event.srcAddress,
          contractName: "GuardedVault",
          ...ev,
        },
        { actor: proposer, vault: event.srcAddress, assetId, isLong, size, pnl: projectedPnL },
      ),
    );
  }

  await bumpAccount(context.Account, event.chainId, owner, ev.timestamp, "proposalCount");
  if (gateLog) {
    // The gate already counted this trade against the vault contract's own
    // address (its msg.sender). Move the count to the owner.
    await bumpAccount(context.Account, event.chainId, event.srcAddress, ev.timestamp, "proposalCount", -1);
  }
  await updateVault(context.Vault, event.chainId, event.srcAddress, "GUARDED", ev.timestamp, (v) => ({
    proposalCount: v.proposalCount + 1,
  }));
});

indexer.onEvent({ contract: "GuardedVault", event: "TradeRefused" }, async ({ event, context }) => {
  const ev = evidence(event);
  const { proposer, assetId, decidingValue } = event.params;
  const reason = decodeBytes32Text(event.params.reason);
  const vaultRow = await context.Vault.get(scopedId(event.chainId, event.srcAddress));
  const owner = vaultRow?.ownerAddress ?? proposer;

  let merged = false;
  if (reason === "PREDICATE_NOT_SATISFIED") {
    const sameTx = await context.Refusal.getWhere({ txHash: { _eq: ev.txHash } });
    const gateRefusal = sameTx
      .filter((r) => r.proposer === event.srcAddress && r.vault === undefined && r.logIndex < ev.logIndex)
      .sort((a, b) => b.logIndex - a.logIndex)[0];

    if (gateRefusal) {
      context.Refusal.set({ ...gateRefusal, account: owner, actor: proposer, vault: event.srcAddress });
      const gateLog = await context.TradeLog.get(gateRefusal.id);
      if (gateLog) {
        context.TradeLog.set({ ...gateLog, account: owner, actor: proposer, vault: event.srcAddress, assetId });
      }
      merged = true;
    }
  }

  if (!merged) {
    context.TradeLog.set(
      tradeLog(
        {
          id: logId(event),
          chainId: event.chainId,
          kind: "REFUSED",
          account: owner,
          contractAddress: event.srcAddress,
          contractName: "GuardedVault",
          ...ev,
        },
        { actor: proposer, vault: event.srcAddress, assetId, reason, decidingValue },
      ),
    );
  }

  await bumpAccount(context.Account, event.chainId, owner, ev.timestamp, "refusalCount");
  if (merged) {
    await bumpAccount(context.Account, event.chainId, event.srcAddress, ev.timestamp, "refusalCount", -1);
  }
  await updateVault(context.Vault, event.chainId, event.srcAddress, "GUARDED", ev.timestamp, (v) => ({
    refusalCount: v.refusalCount + 1,
  }));
});
