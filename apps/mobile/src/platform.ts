import * as LocalAuthentication from 'expo-local-authentication';
import type { PlatformCapabilities } from '@kanon/ui';

/**
 * The device passkey, for real.
 *
 * `hasBiometrics` reports what this handset can actually do, so the pinning
 * ceremony can say what it is about to take a signature with instead of showing
 * a Face ID badge on a device that has none.
 */
export const devicePlatform: PlatformCapabilities = {
  hasBiometrics: true,
  authenticate: async (reason) => {
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!enrolled) return false;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      disableDeviceFallback: false,
    });
    return result.success;
  },
};
