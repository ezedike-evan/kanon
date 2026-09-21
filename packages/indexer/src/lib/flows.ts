import type { CollateralFlow, Vault } from "envio";
import { evidence, logId, updateVault, type EventMeta, type Store } from "./helpers";

type FlowContext = {
  readonly CollateralFlow: Store<CollateralFlow>;
  readonly Vault: Store<Vault>;
};

/** Records a deposit or withdrawal and rolls it into the Vault's running totals. */
export async function recordFlow(
  context: FlowContext,
  event: EventMeta,
  contractName: string,
  vaultKind: Vault["kind"],
  kind: CollateralFlow["kind"],
  account: string,
  amount: bigint,
  vaultPatch: Partial<Vault> = {},
): Promise<void> {
  const ev = evidence(event);
  context.CollateralFlow.set({
    id: logId(event),
    chainId: event.chainId,
    kind,
    contractAddress: event.srcAddress,
    contractName,
    account,
    amount,
    ...ev,
  });
  await updateVault(context.Vault, event.chainId, event.srcAddress, vaultKind, ev.timestamp, (v) =>
    kind === "DEPOSIT"
      ? { ...vaultPatch, netDeposits: v.netDeposits + amount, depositCount: v.depositCount + 1 }
      : { ...vaultPatch, netDeposits: v.netDeposits - amount, withdrawalCount: v.withdrawalCount + 1 },
  );
}
