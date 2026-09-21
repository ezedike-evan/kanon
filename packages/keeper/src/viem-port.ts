import { createPublicClient, createWalletClient, defineChain, http, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { KeeperConfig } from './config';
import type { ChainPort, ContractCall } from './port';

const RECEIPT_TIMEOUT_MS = 60_000;

/**
 * The real `ChainPort`. A wallet client is only ever built when `broadcast` is
 * set, so in a dry run there is no signer in the process to misuse.
 */
export function createViemPort(cfg: KeeperConfig): ChainPort {
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 143 ? 'Monad' : `chain-${cfg.chainId}`,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });

  const account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : undefined;
  const walletClient =
    cfg.broadcast && account ? createWalletClient({ account, chain, transport }) : undefined;
  const sender = account?.address ?? cfg.senderAddress;

  const base = (c: ContractCall) => ({
    address: c.address,
    abi: c.abi as Abi,
    functionName: c.functionName,
    args: c.args as readonly unknown[] | undefined,
  });

  return {
    chainId: () => publicClient.getChainId(),
    blockNumber: () => publicClient.getBlockNumber(),
    gasPrice: () => publicClient.getGasPrice(),
    read: (c) => publicClient.readContract(base(c)),
    async simulate(c) {
      const withSender = sender ? { account: sender } : {};
      // simulateContract surfaces the decoded revert reason; estimateContractGas gives the limit to use.
      await publicClient.simulateContract({ ...base(c), ...withSender });
      const gas = await publicClient.estimateContractGas({ ...base(c), ...withSender });
      return { gas };
    },
    async getLogs(q) {
      const logs = await publicClient.getContractEvents({
        address: q.address,
        abi: q.abi as Abi,
        eventName: q.eventName,
        fromBlock: q.fromBlock,
        toBlock: q.toBlock,
        strict: true,
      });
      return logs.map((l) => ({
        blockNumber: l.blockNumber,
        args: (l as unknown as { args?: Record<string, unknown> }).args ?? {},
      }));
    },
    async send(c, opts) {
      if (!walletClient) throw new Error('no signer: broadcasting is not configured');
      const hash = await walletClient.writeContract({
        ...base(c),
        gas: opts.gas,
        maxFeePerGas: opts.maxFeePerGas,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      return { hash, success: receipt.status === 'success' };
    },
  };
}
