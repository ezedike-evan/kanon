import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import type { HapticPattern, PlatformCapabilities } from '@kanon/ui';

/**
 * Named patterns to expo-haptics. `refusal` is the heaviest impact on purpose:
 * a block should be felt before it is read. Every call is fire-and-forget and
 * swallows failure, since a device without a haptic engine must not break a tap.
 */
const PATTERNS: Record<HapticPattern, () => Promise<void>> = {
  tap: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  select: () => Haptics.selectionAsync(),
  success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  warning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  refusal: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy),
};

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
  storage: {
    get: (key) => SecureStore.getItemAsync(key),
    set: (key, value) => SecureStore.setItemAsync(key, value),
    remove: (key) => SecureStore.deleteItemAsync(key),
  },
  haptics: {
    play: (pattern) => {
      PATTERNS[pattern]().catch(() => undefined);
    },
  },
  copy: async (text) => {
    try {
      return await Clipboard.setStringAsync(text);
    } catch {
      return false;
    }
  },
};
