'use client';

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { PrivyProvider, useCreateWallet, usePrivy, useWallets } from '@privy-io/react-auth';
import {
  ConvexProviderWithAuth,
  ConvexReactClient,
  useAction,
  useConvexAuth,
  useMutation,
  useQuery,
} from 'convex/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  PlatformProvider,
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
  useConvexKanonSource,
  type ConvexHooks,
  type PlatformCapabilities,
  type Signer,
} from '@kanon/ui';
import { AccountProvider, assertPublicEnv, type KanonAccount } from '@kanon/ui';
// The generated `api` object only knows about the `users` module until
// `npx convex dev` has run once against a real deployment and regenerated
// `_generated/api.d.ts` — see that file's header. At runtime `api` is a
// permissive proxy (`anyApi`) that resolves any module path fine; the cast
// below only works around the stale *type*. Drop it once codegen has run.
import { api as generatedApi } from '@kanon/backend/convex/_generated/api';
import { NextNavProvider } from './nav';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = generatedApi as any;

/**
 * A browser has no device passkey, and the pinning ceremony is told so rather
 * than being allowed to imply it took a signature it could not take.
 */
const browserPlatform: PlatformCapabilities = {
  hasBiometrics: false,
  authenticate: async () => false,
};

/**
 * The chain this build targets, written out literally so Next inlines it. Only
 * `10143` selects Monad testnet (the beta deployment); anything else is mainnet.
 */
// Wrong values stop the app at start, by variable name. The Convex URL and Privy id are
// required only in the browser: a server-side build has no reason to hold them.
assertPublicEnv(
  {
    convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
    privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
    registryAddress: process.env.NEXT_PUBLIC_REGISTRY_ADDRESS,
    thresholdMarketAddress: process.env.NEXT_PUBLIC_THRESHOLD_MARKET_ADDRESS,
    vaultChainId: process.env.NEXT_PUBLIC_VAULT_CHAIN_ID,
    vaultRpcUrl: process.env.NEXT_PUBLIC_VAULT_RPC_URL,
    vaultFactoryAddress: process.env.NEXT_PUBLIC_VAULT_FACTORY_ADDRESS,
    vaultCollateralAddress: process.env.NEXT_PUBLIC_VAULT_COLLATERAL_ADDRESS,
    vaultStartBlock: process.env.NEXT_PUBLIC_VAULT_START_BLOCK,
    vaultCollateralDecimals: process.env.NEXT_PUBLIC_VAULT_COLLATERAL_DECIMALS,
    gatewayUrl: process.env.NEXT_PUBLIC_GATEWAY_URL,
  },
  { platform: 'web', requireCore: typeof window !== 'undefined' },
);

const CHAIN = resolveChain(process.env.NEXT_PUBLIC_CHAIN_ID);
configureChain(CHAIN);

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL || 'https://placeholder.convex.cloud');

// Privy throws on any id that is not 25 characters, including an empty one, which
// broke prerendering in a build with no env. The browser never sees this value:
// `assertPublicEnv` above stops the app there when the real id is missing.
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || 'placeholder-privy-app-id0';

/** The three Convex hooks, handed to `@kanon/ui` so it never imports Convex itself. */
const hooks: ConvexHooks = {
  useQuery: useQuery as ConvexHooks['useQuery'],
  useMutation: useMutation as ConvexHooks['useMutation'],
  useAction: useAction as ConvexHooks['useAction'],
};

/**
 * The StrategyRegistry. Read from the environment, and written out literally
 * because Next only inlines `NEXT_PUBLIC_*` it can see spelled out. When the
 * contracts package publishes `deployments/143.json`, pass it as `deployments`
 * here. With neither, the pin ceremony says "not deployed" and stays off.
 */
const REGISTRY_ADDRESS = resolveRegistryAddress({
  env: process.env.NEXT_PUBLIC_REGISTRY_ADDRESS,
});

/**
 * The CanonicalSeries the gate reads, per asset. Written out literally so Next
 * inlines each `NEXT_PUBLIC_*`. When the contracts package publishes
 * `deployments/143.json` its `CanonicalSeries<BASE>USD` keys can be passed as
 * `deployments`. With none configured for a spec's asset, the pin ceremony says
 * "not deployed" and stays off.
 */
const SERIES = resolveSeriesMap({
  env: {
    'BTC/USD': process.env.NEXT_PUBLIC_SERIES_BTC_USD,
    'ETH/USD': process.env.NEXT_PUBLIC_SERIES_ETH_USD,
  },
});


/**
 * The ThresholdMarket the Predict tab stakes on, read the same way. With no
 * address the tab still shows live markets and their results, and says that
 * taking a side is not deployed here.
 */
const THRESHOLD_MARKET_ADDRESS = resolveMarketAddress({
  env: process.env.NEXT_PUBLIC_THRESHOLD_MARKET_ADDRESS,
});

/**
 * The vault factory the Guarded Vault and Copy screens use, read the same way.
 * Every `NEXT_PUBLIC_*` is written out literally so Next can inline it. With no
 * factory address the screens say vaults are not deployed and stay off.
 */
const VAULT_CONFIG = resolveVaultConfig({
  chainId: process.env.NEXT_PUBLIC_VAULT_CHAIN_ID,
  rpcUrl: process.env.NEXT_PUBLIC_VAULT_RPC_URL,
  factory: process.env.NEXT_PUBLIC_VAULT_FACTORY_ADDRESS,
  collateralToken: process.env.NEXT_PUBLIC_VAULT_COLLATERAL_ADDRESS,
  startBlock: process.env.NEXT_PUBLIC_VAULT_START_BLOCK,
  collateralDecimals: process.env.NEXT_PUBLIC_VAULT_COLLATERAL_DECIMALS,
  collateralSymbol: process.env.NEXT_PUBLIC_VAULT_COLLATERAL_SYMBOL,
});

/**
 * The market data gateway (`packages/gateway`), read the same way. With an
 * address, charts and pair prices come from the venue through it; with none
 * they stay on Convex. Creating the feed opens nothing: the first chart to
 * subscribe does, so this is safe at module load and during a server render.
 */
const MARKET_FEED = resolveMarketFeed(process.env.NEXT_PUBLIC_GATEWAY_URL);

/**
 * How Convex learns who is calling: Privy's own access token (an ES256 JWT
 * whose `sub` is the user's DID), fetched fresh each time Convex asks. Convex
 * verifies it against the app's JWKS (`packages/backend/convex/auth.config.ts`)
 * and every function derives the caller from it. No user id is ever sent.
 *
 * `fetchAccessToken` must keep a stable identity: Convex re-runs the whole
 * auth handshake whenever it changes. Privy refreshes a token that is near
 * expiry inside `getAccessToken`, so `forceRefreshToken` needs no handling.
 */
function usePrivyConvexAuth() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const getTokenRef = useRef(getAccessToken);
  getTokenRef.current = getAccessToken;
  const fetchAccessToken = useCallback(async (): Promise<string | null> => {
    try {
      return (await getTokenRef.current()) ?? null;
    } catch {
      return null;
    }
  }, []);
  return useMemo(
    () => ({ isLoading: !ready, isAuthenticated: ready && authenticated, fetchAccessToken }),
    [ready, authenticated, fetchAccessToken],
  );
}

/**
 * Privy -> Convex -> screens.
 *
 * Once Convex has accepted the Privy token, `useConvexKanonSource` reads the
 * caller's own `users` row (`users.me`, created at the signup moment in
 * `marketing-content.tsx`), then subscribes to their strategies and trades.
 * Until that row exists, or while signed out, every screen renders the demo
 * fixtures exactly as before, and a signed-out visitor makes no Convex calls.
 *
 * The signer is the Privy embedded wallet (`createOnLogin` below guarantees one
 * exists), reached through its EIP-1193 provider and handed to viem. A wallet
 * the user connected themselves is used only when there is no embedded one.
 */
function KanonDataBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, logout, exportWallet, user } = usePrivy();
  const { isLoading: convexLoading, isAuthenticated } = useConvexAuth();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();

  // `createOnLogin` only fires inside Privy's own login flow, and it is off in
  // the dashboard by default. Ask for the embedded wallet explicitly once the
  // user is signed in with none, exactly once per session: a failure is logged
  // and left visible (no wallet -> "not deployed"/disabled states), never retried
  // in a loop.
  const walletRequested = useRef(false);
  const hasEmbedded = wallets.some((w) => w.walletClientType === 'privy');
  useEffect(() => {
    if (!authenticated) {
      walletRequested.current = false;
      return;
    }
    if (!ready || !walletsReady || hasEmbedded || walletRequested.current) return;
    walletRequested.current = true;
    createWallet().catch((err: unknown) => {
      console.error('Privy embedded wallet creation failed', err);
    });
  }, [authenticated, ready, walletsReady, hasEmbedded, createWallet]);

  const wallet = wallets.find((w) => w.walletClientType === 'privy') ?? wallets[0];
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
          const provider = await current.getEthereumProvider();
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
          const provider = await current.getEthereumProvider();
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
                const provider = await current.getEthereumProvider();
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
    session: { pending: !ready || convexLoading, signedIn: isAuthenticated },
    pinClient,
    marketClient,
    vaultClient,
    vaultConfig: VAULT_CONFIG,
    hasWallet: Boolean(address),
    marketFeed: MARKET_FEED,
  });

  // Who signed in and how, and the one way out. Convex's session follows Privy's, so `logout`
  // ends both. Key export is Privy's own modal: the app never sees the key.
  const embedded = wallet?.walletClientType === 'privy';
  const loginTypes = (user?.linkedAccounts ?? [])
    .filter((a) => !(a.type === 'wallet' && (a as { walletClientType?: string }).walletClientType === 'privy'))
    .map((a) => a.type)
    .join(',');
  const account = useMemo<KanonAccount>(
    () => ({
      address: authenticated && address ? address : null,
      walletKind: !authenticated || !address ? null : embedded ? 'embedded' : 'external',
      loginMethods: loginTypes ? loginTypes.split(',') : [],
      signOut: () => logout(),
      exportWallet:
        authenticated && embedded && address ? () => exportWallet({ address }) : undefined,
    }),
    [authenticated, address, embedded, loginTypes, logout, exportWallet],
  );
  return (
    <KanonDataProvider source={source}>
      <AccountProvider value={account}>{children}</AccountProvider>
    </KanonDataProvider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email', 'wallet', 'google', 'twitter'],
        // The configured chain (Monad mainnet 143, or testnet 10143 for the beta).
        // Embedded wallets default to the first supported chain, so the pin
        // transaction is sent where the registry lives.
        defaultChain: CHAIN,
        supportedChains: [CHAIN],
        // Privy's default is 'off', which would leave an email or social
        // sign-in with no wallet to fund or sign with.
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        appearance: {
          theme: 'dark',
          accentColor: '#D4A017',
          showWalletLoginFirst: false,
        },
      }}
    >
      <ConvexProviderWithAuth client={convex} useAuth={usePrivyConvexAuth}>
        <SafeAreaProvider>
          <PlatformProvider capabilities={browserPlatform}>
            <KanonDataBridge>
              <NextNavProvider>{children}</NextNavProvider>
            </KanonDataBridge>
          </PlatformProvider>
        </SafeAreaProvider>
      </ConvexProviderWithAuth>
    </PrivyProvider>
  );
}
