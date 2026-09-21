import { createContext, useContext, type ReactNode } from 'react';

/**
 * The signed-in person's wallet and sign-out, from whichever auth SDK the app
 * mounts (Privy on both clients). `packages/ui` knows only this shape, the way
 * it knows only `KanonDataSource` and never Convex.
 *
 * Each app provides one value from its data bridge. Signed out, or with no
 * provider mounted, the default is inert: no address, nothing to sign out of.
 * Convex's session ends by itself: it is derived from Privy's, so
 * `signOut()` on the auth SDK is the whole of signing out.
 */
export interface KanonAccount {
  /** The address every pin and loosening is signed by, or null while there is no wallet. */
  address: string | null;
  /** `embedded` is the Privy wallet made at sign-up; `external` one the person connected. */
  walletKind: 'embedded' | 'external' | null;
  /** How the person signed in, as the auth SDK names them: `email`, `google_oauth`, ... */
  loginMethods: readonly string[];
  /** Ends the auth session. Resolves once the SDK has done it; rejects when it could not. */
  signOut(): Promise<void>;
  /**
   * Opens the SDK's own key-export flow. Present only where the SDK offers one
   * and the person has an embedded wallet: the app never handles the key.
   */
  exportWallet?: (() => Promise<void>) | undefined;
}

export const SIGNED_OUT_ACCOUNT: KanonAccount = {
  address: null,
  walletKind: null,
  loginMethods: [],
  signOut: async () => undefined,
};

const AccountContext = createContext<KanonAccount>(SIGNED_OUT_ACCOUNT);

export function AccountProvider({ value, children }: { value: KanonAccount; children: ReactNode }) {
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export const useAccount = (): KanonAccount => useContext(AccountContext);
