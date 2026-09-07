import { createContext, useContext, type ReactNode } from 'react';

/**
 * Capabilities only one platform has.
 *
 * The pinning ceremony asks for a device passkey. That is real on a phone and
 * absent in a browser, and the screen must not pretend otherwise — a ceremony
 * that claims to have taken a signature it did not take is the exact kind of
 * lie this product is built to make impossible.
 */
export interface PlatformCapabilities {
  /** Prompts for the device passkey. Resolves false when unavailable or refused. */
  authenticate(reason: string): Promise<boolean>;
  /** Whether a passkey prompt exists at all on this platform. */
  hasBiometrics: boolean;
}

const unavailable: PlatformCapabilities = {
  authenticate: async () => false,
  hasBiometrics: false,
};

const PlatformContext = createContext<PlatformCapabilities>(unavailable);

export function PlatformProvider({
  capabilities,
  children,
}: {
  capabilities: PlatformCapabilities;
  children: ReactNode;
}) {
  return (
    <PlatformContext.Provider value={capabilities}>{children}</PlatformContext.Provider>
  );
}

export const usePlatform = () => useContext(PlatformContext);
