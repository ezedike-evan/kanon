import { indexer } from "envio";
import { bumpAccount, evidence, logId, newAccount, scopedId, tradeLog } from "../lib/helpers";
import { strategyKey } from "./strategyRegistry";
import { recordFlow } from "../lib/flows";
import { updateVault } from "../lib/helpers";

/**
 * MarginAccount: positions and liquidations on the paper-margin engine.
 * Position ids are per-account array indexes on-chain, so the entity id is
 * `${chain}_${contract}_${account}_${positionId}`.
 */

const positionKey = (chainId: number, contract: string, account: string, positionId: bigint) =>
  scopedId(chainId, contract, account, positionId);

indexer.onEvent({ contract: "MarginAccount", event: "Deposited" }, async ({ event, context }) => {
  await recordFlow(context, event, "MarginAccount", "MARGIN", "DEPOSIT", event.params.account, event.params.amount);
});

indexer.onEvent({ contract: "MarginAccount", event: "Withdrawn" }, async ({ event, context }) => {
  await recordFlow(context, event, "MarginAccount", "MARGIN", "WITHDRAWAL", event.params.account, event.params.amount);
});

indexer.onEvent({ contract: "MarginAccount", event: "PositionOpened" }, async ({ event, context }) => {
  const ev = evidence(event);
  const { account, positionId, seriesContract, isLong, size, entryPrice } = event.params;
  const id = positionKey(event.chainId, event.srcAddress, account, positionId);

  context.Position.set({
    id,
    chainId: event.chainId,
    source: "MARGIN_ACCOUNT",
    contractAddress: event.srcAddress,
    account,
    positionId: positionId.toString(),
    series: seriesContract,
    assetId: undefined,
    isLong,
    size,
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
        kind: "OPENED",
        account,
        contractAddress: event.srcAddress,
        contractName: "MarginAccount",
        ...ev,
      },
      { actor: account, series: seriesContract, isLong, size, price: entryPrice, position_id: id },
    ),
  );
  await bumpAccount(context.Account, event.chainId, account, ev.timestamp, "openedCount");
  await updateVault(context.Vault, event.chainId, event.srcAddress, "MARGIN", ev.timestamp, () => ({}));
});

indexer.onEvent({ contract: "MarginAccount", event: "PositionClosed" }, async ({ event, context }) => {
  const ev = evidence(event);
  const { account, positionId, exitPrice, pnl, wasLiquidation } = event.params;
  const id = positionKey(event.chainId, event.srcAddress, account, positionId);
  const liquidator = wasLiquidation ? event.transaction.from : undefined;

  const position = await context.Position.get(id);
  if (position) {
    context.Position.set({
      ...position,
      exitPrice,
      pnl,
      status: wasLiquidation ? "LIQUIDATED" : "CLOSED",
      closedAt: ev.timestamp,
      closeTxHash: ev.txHash,
      liquidator,
    });
  }

  context.TradeLog.set(
    tradeLog(
      {
        id: logId(event),
        chainId: event.chainId,
        kind: wasLiquidation ? "LIQUIDATED" : "CLOSED",
        account,
        contractAddress: event.srcAddress,
        contractName: "MarginAccount",
        ...ev,
      },
      {
        actor: liquidator ?? account,
        series: position?.series,
        isLong: position?.isLong,
        size: position?.size,
        price: exitPrice,
        pnl,
        position_id: id,
      },
    ),
  );
  await bumpAccount(context.Account, event.chainId, account, ev.timestamp, wasLiquidation ? "liquidationCount" : "closedCount");
  await updateVault(context.Vault, event.chainId, event.srcAddress, "MARGIN", ev.timestamp, () => ({}));
});

// ---------------------------------------------------------------------------
// Risk events: deleveraging, penalties and debt. Kept in MarginEvent so the
// trade history stays about trades; a partial close is also a TradeLog row.
// ---------------------------------------------------------------------------

const marginEvent = (event: Parameters<typeof evidence>[0]) => ({
  id: logId(event),
  chainId: event.chainId,
  contractAddress: event.srcAddress,
  closedSize: undefined,
  remainingSize: undefined,
  exitPrice: undefined,
  pnl: undefined,
  healthFactorBefore: undefined,
  healthFactorAfter: undefined,
  amount: undefined,
  debt: undefined,
  coveredByFund: undefined,
  uncovered: undefined,
  position_id: undefined,
  strategy_id: undefined,
  ...evidence(event),
});

indexer.onEvent({ contract: "MarginAccount", event: "PositionDeleveraged" }, async ({ event, context }) => {
  const ev = evidence(event);
  const p = event.params;
  const id = positionKey(event.chainId, event.srcAddress, p.account, p.positionId);

  const position = await context.Position.get(id);
  if (position) {
    context.Position.set({ ...position, size: p.remainingSize });
  }
  context.MarginEvent.set({
    ...marginEvent(event),
    kind: "DELEVERAGED",
    account: p.account,
    position_id: id,
    closedSize: p.closedSize,
    remainingSize: p.remainingSize,
    exitPrice: p.exitPrice,
    pnl: p.pnl,
    healthFactorBefore: p.healthFactorBefore,
    healthFactorAfter: p.healthFactorAfter,
  });
  context.TradeLog.set(
    tradeLog(
      {
        id: logId(event),
        chainId: event.chainId,
        kind: "DELEVERAGED",
        account: p.account,
        contractAddress: event.srcAddress,
        contractName: "MarginAccount",
        ...ev,
      },
      {
        actor: event.transaction.from,
        series: position?.series,
        isLong: position?.isLong,
        size: p.closedSize,
        price: p.exitPrice,
        pnl: p.pnl,
        position_id: id,
      },
    ),
  );
});

indexer.onEvent({ contract: "MarginAccount", event: "LiquidationPenaltyCharged" }, async ({ event, context }) => {
  context.MarginEvent.set({
    ...marginEvent(event),
    kind: "LIQUIDATION_PENALTY",
    account: event.params.account,
    position_id: positionKey(event.chainId, event.srcAddress, event.params.account, event.params.positionId),
    amount: event.params.penalty,
  });
});

indexer.onEvent({ contract: "MarginAccount", event: "DebtIncurred" }, async ({ event, context }) => {
  context.MarginEvent.set({
    ...marginEvent(event),
    kind: "DEBT_INCURRED",
    account: event.params.account,
    amount: event.params.amount,
  });
});

indexer.onEvent({ contract: "MarginAccount", event: "DebtRepaid" }, async ({ event, context }) => {
  context.MarginEvent.set({
    ...marginEvent(event),
    kind: "DEBT_REPAID",
    account: event.params.account,
    amount: event.params.amount,
  });
});

indexer.onEvent({ contract: "MarginAccount", event: "BadDebtResolved" }, async ({ event, context }) => {
  context.MarginEvent.set({
    ...marginEvent(event),
    kind: "BAD_DEBT_RESOLVED",
    account: event.params.account,
    debt: event.params.debt,
    coveredByFund: event.params.coveredByFund,
    uncovered: event.params.uncovered,
  });
});

/**
 * StrategyBound: the one-way binding of an account to a strategy the account
 * owns. After this the account can only open positions through
 * openGuardedPosition, i.e. positions the RefusalGate has already cleared.
 */
indexer.onEvent({ contract: "MarginAccount", event: "StrategyBound" }, async ({ event, context }) => {
  const key = strategyKey(event.chainId, event.params.strategyId);
  const ts = event.block.timestamp;
  const id = scopedId(event.chainId, event.params.account);
  const account = (await context.Account.get(id)) ?? newAccount(event.chainId, event.params.account, ts);
  context.Account.set({ ...account, boundStrategy_id: key, lastActivityAt: Math.max(account.lastActivityAt, ts) });
  context.MarginEvent.set({
    ...marginEvent(event),
    kind: "STRATEGY_BOUND",
    account: event.params.account,
    strategy_id: key,
  });
});
