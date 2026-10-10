import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  ConvexProviderWithAuth,
  ConvexReactClient,
  useAction,
  useConvexAuth,
  useMutation,
  useQuery,
} from 'convex/react';
import { useEmbeddedEthereumWallet, usePrivy } from '@privy-io/expo';
import {
  KanonDataProvider,
  configureChain,
  resolveChain,
  createViemMarketClient,
  createViemPinClient,
  createViemChainIO,
  createVaultClient,
  resolveVaultConfig,
  resolveMarketAddress,
  resolveMarketFeed,
  resolveRegistryAddress,
  resolveSeriesMap,
  resolveVenueTrade,
  useConvexKanonSource,
  type ConvexHooks,
  type Signer,
} from '@kanon/ui';
import { AccountProvider, assertPublicEnv, type KanonAccount } from '@kanon/ui';
// The generated `api` object only knows about the `users` module until
// `npx convex dev` has run once against a real deployment and regenerated
// `_generated/api.d.ts` — see that file's header. At runtime `api` is a
// permissive proxy (`anyApi`) that resolves any module path fine; the cast
// below only works around the stale *type*. Drop it once codegen has run.
import { api as generatedApi } from '@kanon/backend/convex/_generated/api';

const api = generatedApi as any;

/**
 * The chain this build targets, written out literally so Expo inlines it. Only
 * `10143` selects Monad testnet (the beta deployment); anything else is mainnet.
 */
assertPublicEnv(
  {
    convexUrl: process.env.EXPO_PUBLIC_CONVEX_URL,
    privyAppId: process.env.EXPO_PUBLIC_PRIVY_APP_ID,
    privyClientId: process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID,
    chainId: process.env.EXPO_PUBLIC_CHAIN_ID,
    registryAddress: process.env.EXPO_PUBLIC_REGISTRY_ADDRESS,
    thresholdMarketAddress: process.env.EXPO_PUBLIC_THRESHOLD_MARKET_ADDRESS,
    vaultChainId: process.env.EXPO_PUBLIC_VAULT_CHAIN_ID,
    vaultRpcUrl: process.env.EXPO_PUBLIC_VAULT_RPC_URL,
    vaultFactoryAddress: process.env.EXPO_PUBLIC_VAULT_FACTORY_ADDRESS,
    vaultCollateralAddress: process.env.EXPO_PUBLIC_VAULT_COLLATERAL_ADDRESS,
    vaultStartBlock: process.env.EXPO_PUBLIC_VAULT_START_BLOCK,
    vaultCollateralDecimals: process.env.EXPO_PUBLIC_VAULT_COLLATERAL_DECIMALS,
    gatewayUrl: process.env.EXPO_PUBLIC_GATEWAY_URL,
  },
  { platform: 'mobile', requireCore: true },
);

export const CHAIN = resolveChain(process.env.EXPO_PUBLIC_CHAIN_ID);
configureChain(CHAIN);

export const convex = new ConvexReactClient(
  process.env.EXPO_PUBLIC_CONVEX_URL || 'https://placeholder.convex.cloud',
);

/** The three Convex hooks, handed to `@kanon/ui` so it never imports Convex itself. */
const hooks: ConvexHooks = {
  useQuery: useQuery as ConvexHooks['useQuery'],
  useMutation: useMutation as ConvexHooks['useMutation'],
  useAction: useAction as ConvexHooks['useAction'],
};

/**
 * The StrategyRegistry, read from the environment and written out literally so
 * Metro inlines it. When the contracts package publishes
 * `deployments/143.json`, pass it as `deployments` here. With neither, the pin
 * ceremony says "not deployed" and stays off.
 */
const REGISTRY_ADDRESS = resolveRegistryAddress({
  env: process.env.EXPO_PUBLIC_REGISTRY_ADDRESS,
});

/**
 * The CanonicalSeries the gate reads, per asset. Written out literally so Next
 * inlines each `EXPO_PUBLIC_*`. When the contracts package publishes
 * `deployments/143.json` its `CanonicalSeries<BASE>USD` keys can be passed as
 * `deployments`. With none configured for a spec's asset, the pin ceremony says
 * "not deployed" and stays off.
 */
const SERIES = resolveSeriesMap({
  env: {
    'BTC/USD': process.env.EXPO_PUBLIC_SERIES_BTC_USD,
    'ETH/USD': process.env.EXPO_PUBLIC_SERIES_ETH_USD,
  },
});


/**
 * The ThresholdMarket the Predict tab stakes on, read the same way. With no
 * address the tab still shows live markets and their results, and says that
 * taking a side is not deployed here.
 */
const THRESHOLD_MARKET_ADDRESS = resolveMarketAddress({
  env: process.env.EXPO_PUBLIC_THRESHOLD_MARKET_ADDRESS,
});

/**
 * The vault factory the Guarded Vault and Copy screens use, read the same way
 * and written out literally so Metro inlines it. With no factory address the
 * screens say vaults are not deployed and stay off.
 */
const VAULT_CONFIG = resolveVaultConfig({
  chainId: process.env.EXPO_PUBLIC_VAULT_CHAIN_ID,
  rpcUrl: process.env.EXPO_PUBLIC_VAULT_RPC_URL,
  factory: process.env.EXPO_PUBLIC_VAULT_FACTORY_ADDRESS,
  collateralToken: process.env.EXPO_PUBLIC_VAULT_COLLATERAL_ADDRESS,
  startBlock: process.env.EXPO_PUBLIC_VAULT_START_BLOCK,
  collateralDecimals: process.env.EXPO_PUBLIC_VAULT_COLLATERAL_DECIMALS,
  collateralSymbol: process.env.EXPO_PUBLIC_VAULT_COLLATERAL_SYMBOL,
});

/**
 * The market data gateway (`packages/gateway`), read the same way and written
 * out literally so Metro inlines it. With an address, charts and pair prices
 * come from the venue through it; with none they stay on Convex. Creating the
 * feed opens nothing: the first chart to subscribe does.
 */
const MARKET_FEED = resolveMarketFeed(process.env.EXPO_PUBLIC_GATEWAY_URL);

/**
 * How Convex learns who is calling: Privy's own access token (an ES256 JWT
 * whose `sub` is the user's DID), fetched fresh each time Convex asks. Convex
 * verifies it against the app's JWKS (`packages/backend/convex/auth.config.ts`)
 * and every function derives the caller from it. No user id is ever sent.
 *
 * `@privy-io/expo`'s `usePrivy()` has no `authenticated` flag: `isReady && user`
 * is the equivalent. `fetchAccessToken` keeps a stable identity (Convex re-runs
 * the auth handshake when it changes); Privy refreshes a near-expiry token
 * inside `getAccessToken`, so `forceRefreshToken` needs no handling.
 */
function usePrivyConvexAuth() {
  const { isReady, user, getAccessToken } = usePrivy();
  const getTokenRef = useRef(getAccessToken);
  getTokenRef.current = getAccessToken;
  const fetchAccessToken = useCallback(async (): Promise<string | null> => {
    try {
      return (await getTokenRef.current()) ?? null;
    } catch {
      return null;
    }
  }, []);
  const isAuthenticated = isReady && Boolean(user);
  return useMemo(
    () => ({ isLoading: !isReady, isAuthenticated, fetchAccessToken }),
    [isReady, isAuthenticated, fetchAccessToken],
  );
}

/**
 * Mirrors `apps/web/src/providers.tsx`: Privy -> Convex -> screens, with the
 * same demo fallback while signed out. `@privy-io/expo`'s `usePrivy()` has no
 * `authenticated` flag: `isReady && user` is the equivalent.
 *
 * Unlike the web there is no `createOnLogin` for an embedded wallet here, so
 * this creates one after login if the user has none. Pinning signs with it.
 */
function KanonDataBridge({ children }: { children: ReactNode }) {
  const { isReady, user, logout, getAccessToken } = usePrivy();

  // The order ticket's calls go to the gateway with the caller's own Privy token, the same
  // one Convex is given. Built once: the ref keeps the getter current without rebuilding it.
  const getTokenRef = useRef(getAccessToken);
  getTokenRef.current = getAccessToken;
  const venueTrade = useMemo(
    () =>
      resolveVenueTrade(process.env.EXPO_PUBLIC_GATEWAY_URL, async () => {
        try {
          return (await getTokenRef.current()) ?? null;
        } catch {
          return null;
        }
      }),
    [],
  );
  const { isLoading: convexLoading, isAuthenticated } = useConvexAuth();
  const { wallets, create } = useEmbeddedEthereumWallet();
  // Only for creating the embedded wallet below. Who the user is to Convex comes from the token.
  const privyId = isReady && user ? user.id : undefined;

  // Privy lists the wallet on the user before the hook has hydrated it; do not create a second.
  const linked = Boolean(
    user?.linked_accounts?.some((account) => {
      const a = account as { type?: string; chain_type?: string; wallet_client_type?: string };
      return a.type === 'wallet' && a.chain_type === 'ethereum' && a.wallet_client_type === 'privy';
    }),
  );
  const hasEmbedded = wallets.length > 0 || linked;
  const creating = useRef(false);
  useEffect(() => {
    if (!privyId || hasEmbedded || creating.current) return;
    creating.current = true;
    create()
      .catch(() => {
        /* the pin ceremony reports "no wallet"; nothing is faked in the meantime */
      })
      .finally(() => {
        creating.current = false;
      });
  }, [privyId, hasEmbedded, create]);

  const wallet = wallets[0];
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const address = wallet?.address;

  const pinClient = useMemo(
    () =>
      createViemPinClient({
        chain: CHAIN,
        registryAddress: REGISTRY_ADDRESS,
        series: SERIES,
        hasWallet: Boolean(address),
        getSigner: async () => {
          const current = walletRef.current;
          if (!current) return null;
          const provider = await current.getProvider();
          return {
            provider: provider as unknown as Signer['provider'],
            address: current.address as `0x${string}`,
          };
        },
      }),
    [address],
  );

  const marketClient = useMemo(
    () =>
      createViemMarketClient({
        chain: CHAIN,
        marketAddress: THRESHOLD_MARKET_ADDRESS,
        hasWallet: Boolean(address),
        getSigner: async () => {
          const current = walletRef.current;
          if (!current) return null;
          const provider = await current.getProvider();
          return {
            provider: provider as unknown as Signer['provider'],
            address: current.address as `0x${string}`,
          };
        },
      }),
    [address],
  );

  const vaultClient = useMemo(
    () =>
      VAULT_CONFIG.status === 'ready'
        ? createVaultClient(
            VAULT_CONFIG.config,
            createViemChainIO({
              chainId: VAULT_CONFIG.config.chainId,
              rpcUrl: VAULT_CONFIG.config.rpcUrl,
              getSigner: async () => {
                const current = walletRef.current;
                if (!current) return null;
                const provider = await current.getProvider();
                return {
                  provider: provider as unknown as Signer['provider'],
                  address: current.address as `0x${string}`,
                };
              },
            }),
          )
        : null,
    [],
  );

  const source = useConvexKanonSource({
    hooks,
    api,
    session: { pending: !isReady || convexLoading, signedIn: isAuthenticated },
    pinClient,
    marketClient,
    vaultClient,
    vaultConfig: VAULT_CONFIG,
    hasWallet: Boolean(address),
    marketFeed: MARKET_FEED,
    venueTrade,
  });

  // Who signed in and how, and the one way out. Convex's session follows Privy's, so `logout`
  // ends both. `@privy-io/expo` offers no key-export flow, so none is offered here.
  const signedIn = isReady && Boolean(user);
  const loginTypes = (user?.linked_accounts ?? [])
    .filter((a) => !(a.type === 'wallet' && (a as { wallet_client_type?: string }).wallet_client_type === 'privy'))
    .map((a) => a.type)
    .join(',');
  const account = useMemo<KanonAccount>(
    () => ({
      address: signedIn && address ? address : null,
      walletKind: !signedIn || !address ? null : 'embedded',
      loginMethods: loginTypes ? loginTypes.split(',') : [],
      signOut: () => logout(),
    }),
    [signedIn, address, loginTypes, logout],
  );
  return (
    <KanonDataProvider source={source}>
      <AccountProvider value={account}>{children}</AccountProvider>
    </KanonDataProvider>
  );
}

export function ConvexDataProviders({ children }: { children: ReactNode }) {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={usePrivyConvexAuth}>
      <KanonDataBridge>{children}</KanonDataBridge>
    </ConvexProviderWithAuth>
  );
}
