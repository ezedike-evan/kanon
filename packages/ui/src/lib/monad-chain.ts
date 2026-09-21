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
