import { indexer } from "envio";
import { bumpAccount, decodeBytes32Text, evidence, logId, scopedId, tradeLog, updateVault } from "../lib/helpers";
import { recordFlow } from "../lib/flows";

/**
 * CopyVault: one instance per follower, registered dynamically from
 * VaultFactory.CopyVaultCreated (src/handlers/vaultFactory.ts), which is also
 * where the follower address is recorded on the Vault. Events other than
 * deposits and withdrawals do not carry the follower, so rows are attributed to
 * `Vault.ownerAddress`. If a vault somehow has no factory record, rows fall back
 * to the vault address itself and clients should also match `contractAddress`.
 */

const account0 = (v: { ownerAddress: string | undefined }, fallback: string) => v.ownerAddress ?? fallback;

const positionKey = (chainId: number, contract: string, positionId: bigint) => scopedId(chainId, contract, positionId);

indexer.onEvent({ contract: "CopyVault", event: "Deposited" }, async ({ event, context }) => {
  await recordFlow(context, event, "CopyVault", "COPY", "DEPOSIT", event.params.follower, event.params.amount);
});

indexer.onEvent({ contract: "CopyVault", event: "Withdrawn" }, async ({ event, context }) => {
  await recordFlow(context, event, "CopyVault", "COPY", "WITHDRAWAL", event.params.follower, event.params.amount);
});

indexer.onEvent({ contract: "CopyVault", event: "FollowingToggled" }, async ({ event, context }) => {
  await updateVault(context.Vault, event.chainId, event.srcAddress, "COPY", event.block.timestamp, (v) => ({
    following: event.params.active,
    ownerAddress: v.ownerAddress ?? event.transaction.from,
  }));
});

indexer.onEvent({ contract: "CopyVault", event: "TradeSkipped" }, async ({ event, context }) => {
  const ev = evidence(event);
  const vault = await updateVault(context.Vault, event.chainId, event.srcAddress, "COPY", ev.timestamp, (v) => ({
    skippedCount: v.skippedCount + 1,
  }));
  context.TradeLog.set(
    tradeLog(
      {
        id: logId(event),
        chainId: event.chainId,
        kind: "SKIPPED",
        account: vault.ownerAddress ?? event.srcAddress,
        contractAddress: event.srcAddress,
        contractName: "CopyVault",
        ...ev,
      },
      { actor: account0(vault, event.srcAddress), vault: event.srcAddress, assetId: event.params.assetId, reason: decodeBytes32Text(event.params.reason) },
    ),
  );
});

indexer.onEvent({ contract: "CopyVault", event: "PositionMirrored" }, async ({ event, context }) => {
  const ev = evidence(event);
  const { positionId, assetId, isLong, followerSize, entryPrice } = event.params;
  const id = positionKey(event.chainId, event.srcAddress, positionId);
  const vault = await updateVault(context.Vault, event.chainId, event.srcAddress, "COPY", ev.timestamp, () => ({}));
  const account = vault.ownerAddress ?? event.srcAddress;

  context.Position.set({
    id,
    chainId: event.chainId,
    source: "COPY_VAULT",
    contractAddress: event.srcAddress,
    account,
    positionId: positionId.toString(),
    series: undefined,
    assetId,
    isLong,
    size: followerSize,
    entryPrice,
    exitPrice: undefined,
    pnl: undefined,
    feeCharged: undefined,
    status: "OPEN",
    openedAt: ev.timestamp,
    closedAt: undefined,
    openTxHash: ev.txHash,
    closeTxHash: undefined,
    liquidator: undefined,
  });
  context.TradeLog.set(
    tradeLog(
      {
        id: logId(event),
        chainId: event.chainId,
        kind: "MIRRORED",
        account,
        contractAddress: event.srcAddress,
        contractName: "CopyVault",
        ...ev,
      },
      { actor: account, vault: event.srcAddress, assetId, isLong, size: followerSize, price: entryPrice, position_id: id },
    ),
  );
  await bumpAccount(context.Account, event.chainId, account, ev.timestamp, "openedCount");
});

indexer.onEvent({ contract: "CopyVault", event: "PositionClosed" }, async ({ event, context }) => {
  const ev = evidence(event);
  const { positionId, exitPrice, pnl, feeCharged } = event.params;
  const id = positionKey(event.chainId, event.srcAddress, positionId);
  const position = await context.Position.get(id);
  const vault = await updateVault(context.Vault, event.chainId, event.srcAddress, "COPY", ev.timestamp, () => ({}));
  const account = position?.account ?? vault.ownerAddress ?? event.srcAddress;

  if (position) {
    context.Position.set({
      ...position,
      exitPrice,
      pnl,
      feeCharged,
      status: "CLOSED",
      closedAt: ev.timestamp,
      closeTxHash: ev.txHash,
    });
  }
  context.TradeLog.set(
    tradeLog(
      {
        id: logId(event),
        chainId: event.chainId,
        kind: "MIRROR_CLOSED",
        account,
        contractAddress: event.srcAddress,
        contractName: "CopyVault",
        ...ev,
      },
      {
        actor: account,
        vault: event.srcAddress,
        assetId: position?.assetId,
        isLong: position?.isLong,
        size: position?.size,
        price: exitPrice,
        pnl,
        position_id: id,
      },
    ),
  );
  await bumpAccount(context.Account, event.chainId, account, ev.timestamp, "closedCount");
});
