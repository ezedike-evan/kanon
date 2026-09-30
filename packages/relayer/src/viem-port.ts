import { createPublicClient, createWalletClient, defineChain, http, type Abi } from 'viem';
import { RPC_RETRIES, RPC_TIMEOUT_MS } from './cli-args';
import { privateKeyToAccount } from 'viem/accounts';
import type { RelayerConfig } from './config';
import type { ChainPort, ContractCall } from './port';

/**
 * The real `ChainPort`. A wallet client is only ever built when `broadcast` is
 * set, so in a dry run there is no signer in the process to misuse.
 */
export function createViemPort(cfg: RelayerConfig): ChainPort {
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 143 ? 'Monad' : `chain-${cfg.chainId}`,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const transport = http(cfg.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRIES });
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
    latestBlockTimestamp: async () => (await publicClient.getBlock()).timestamp,
    read: (c) => publicClient.readContract(base(c)),
    async simulate(c) {
      await publicClient.simulateContract({
        ...base(c),
        ...(c.value !== undefined ? { value: c.value } : {}),
        ...(sender ? { account: sender } : {}),
      });
    },
    async send(c) {
      if (!walletClient) throw new Error('no signer: broadcasting is not configured');
      const hash = await walletClient.writeContract({
        ...base(c),
        ...(c.value !== undefined ? { value: c.value } : {}),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { hash, success: receipt.status === 'success' };
    },
  };
}
