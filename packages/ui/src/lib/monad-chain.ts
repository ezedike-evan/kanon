import { defineChain } from 'viem';

/**
 * Monad mainnet, chain 143.
 *
 * The same definition as `monad` in `viem/chains`, written out here because
 * `import { monad } from 'viem/chains'` pulls in that package's whole chain
 * table: 704 modules, none tree-shaken by Metro and all compiled by the Next
 * dev server, to use one of them. Both apps take the chain from here.
 */
export const monad = defineChain({
  id: 143,
  name: 'Monad',
  blockTime: 400,
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://rpc.monad.xyz', 'https://rpc1.monad.xyz'],
      webSocket: ['wss://rpc.monad.xyz', 'wss://rpc1.monad.xyz'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Monadscan',
      url: 'https://monadscan.com',
      apiUrl: 'https://api.etherscan.io/v2/api?chainid=143',
    },
    monadvision: { name: 'MonadVision', url: 'https://monadvision.com' },
  },
  testnet: false,
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      blockCreated: 9248132,
    },
  },
});

/**
 * Monad testnet, chain 10143. What the beta deployment runs on: `deployments/
 * 10143.json` in `@kanon/contracts` (a MockPyth fed with mainnet prices, and a
 * mock USDC).
 */
export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  blockTime: 400,
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://testnet-rpc.monad.xyz'],
      webSocket: ['wss://testnet-rpc.monad.xyz'],
    },
  },
  blockExplorers: {
    default: { name: 'Monadscan', url: 'https://testnet.monadscan.com' },
  },
  testnet: true,
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

/**
 * The chain a client targets. `chainId` is `NEXT_PUBLIC_CHAIN_ID` /
 * `EXPO_PUBLIC_CHAIN_ID`, passed in by the app because a bundler only inlines
 * those when they are written out literally. Only `10143` selects testnet;
 * anything else, including nothing, is mainnet, so a missing variable can never
 * point a production build at a test deployment.
 */
export function resolveChain(chainId: string | undefined): typeof monad | typeof monadTestnet {
  return chainId?.trim() === String(monadTestnet.id) ? monadTestnet : monad;
}

let active: typeof monad | typeof monadTestnet = monad;

/** Called once by each app's providers, before any screen renders. */
export function configureChain(chain: typeof monad | typeof monadTestnet): void {
  active = chain;
}

/** The chain this client was configured for, for screens that name or link to it. */
export function activeChain(): typeof monad | typeof monadTestnet {
  return active;
}
