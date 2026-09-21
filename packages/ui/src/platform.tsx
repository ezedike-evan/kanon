import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Appearance, Platform } from 'react-native';
import { THEME_STORAGE_KEY, themes, type ThemeMode, type ThemeScheme } from '@kanon/tokens';
import { getPreferences, hydratePreferences } from './lib/preferences';

/**
 * Everything that differs between a browser and a phone lives in this file.
 * Screens and components ask `usePlatform()` for a capability, or import
 * `isWeb` from here; they never branch on `Platform.OS` themselves.
 */
export const isWeb = Platform.OS === 'web';
/** iOS does not resize the window for the keyboard; Android (Expo default) and the web do. */
export const isIOS = Platform.OS === 'ios';

/**
 * Haptic patterns, named for what happened rather than for how it feels.
 * `refusal` is deliberately the heaviest: it should be felt before it is read
 * (docs/DESIGN.md, Motion).
 */
export type HapticPattern = 'tap' | 'select' | 'success' | 'warning' | 'refusal';

export interface HapticsCapability {
  /** Plays a pattern. Fire and forget: never awaits, never throws. */
  play(pattern: HapticPattern): void;
}

/** A small async string store. Web: localStorage. Native: expo-secure-store. */
export interface StorageCapability {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

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
  /** Persistent key/value storage. Optional: the web default is localStorage. */
  storage?: StorageCapability;
  /** Haptics. Optional: the default is a no-op, which is correct on the web. */
  haptics?: HapticsCapability;
  /** Puts text on the clipboard. Resolves false when it could not. Optional: the web default is the async clipboard API. */
  copy?: (text: string) => Promise<boolean>;
}

/** What `usePlatform()` returns: the optional capabilities are always filled in. */
export type ResolvedPlatform = PlatformCapabilities & {
  storage: StorageCapability;
  haptics: HapticsCapability;
  copy: (text: string) => Promise<boolean>;
};

/** The async clipboard API where the browser has it and allows it. */
async function defaultCopy(text: string): Promise<boolean> {
  try {
    if (isWeb && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* blocked by permissions or an insecure context */
  }
  return false;
}

const noHaptics: HapticsCapability = { play: () => undefined };

/** localStorage where it exists and is allowed; a per-session map where it is not. */
function createDefaultStorage(): StorageCapability {
  const memory = new Map<string, string>();
  const local = (): Storage | null => {
    if (!isWeb) return null;
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null; // private window, blocked site data
    }
  };
  return {
    get: async (key) => {
      try {
        return local()?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    set: async (key, value) => {
      memory.set(key, value);
      try {
        local()?.setItem(key, value);
      } catch {
        /* kept in memory for the session */
      }
    },
    remove: async (key) => {
      memory.delete(key);
      try {
        local()?.removeItem(key);
      } catch {
        /* nothing to remove */
      }
    },
  };
}

const defaultStorage = createDefaultStorage();

const unavailable: ResolvedPlatform = {
  authenticate: async () => false,
  hasBiometrics: false,
  storage: defaultStorage,
  haptics: noHaptics,
  copy: defaultCopy,
};

const PlatformContext = createContext<ResolvedPlatform>(unavailable);

export function PlatformProvider({
  capabilities,
  children,
}: {
  capabilities: PlatformCapabilities;
  children: ReactNode;
}) {
  const value = useMemo<ResolvedPlatform>(
    () => ({
      ...capabilities,
      storage: capabilities.storage ?? defaultStorage,
      haptics: capabilities.haptics ?? noHaptics,
      copy: capabilities.copy ?? defaultCopy,
    }),
    [capabilities],
  );
  // Device preferences (haptics on or off, the chart's opening timeframe) live in storage.
  useEffect(() => {
    void hydratePreferences(value.storage);
  }, [value.storage]);
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export const usePlatform = () => useContext(PlatformContext);

/**
 * Named haptic patterns, ready to call from any handler:
 *
 *   const { tap, success, refusal } = useHaptics();
 *
 * The returned object is stable for the life of the provider.
 */
export function useHaptics() {
  const { haptics } = usePlatform();
  return useMemo(() => {
    // Read at the moment of the press, so Profile > Settings applies without a remount.
    const play = (pattern: HapticPattern) => {
      if (getPreferences().haptics) haptics.play(pattern);
    };
    return {
      /** Light impact: a press on a control. */
      tap: () => play('tap'),
      /** Selection tick: a segment, chip or picker changed. */
      select: () => play('select'),
      /** Success notification: a rule pinned, a stake taken. */
      success: () => play('success'),
      /** Warning notification: a cooling-off started, a limit approached. */
      warning: () => play('warning'),
      /** Heavy impact. A block; felt before it is read. */
      refusal: () => play('refusal'),
    };
  }, [haptics]);
}

/* ------------------------------------------------------------------ theme */

export { THEME_STORAGE_KEY };

/**
 * Web: reflect the scheme on <html> so the CSS variables in the generated
 * `theme.css` (keyed on `data-theme`) switch, and so scrollbars and form
 * controls follow. Native has no document; NativeWind variables are applied by
 * `ThemeProvider` through a style instead.
 */
export function syncDocumentTheme(scheme: ThemeScheme): void {
  if (!isWeb || typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', scheme);
  root.style.colorScheme = scheme;
  // Paint the overscroll and any gap around the artboard in the theme's ground.
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', themes[scheme].void);
}

/**
 * Native: pin the OS appearance to the chosen scheme so system chrome (dialogs,
 * keyboard, status bar with `style="auto"`) matches. `unspecified` hands control back
 * to the OS, which is what `system` means. Not available on the web.
 */
export function syncNativeAppearance(mode: ThemeMode, scheme: ThemeScheme): void {
  if (isWeb) return;
  try {
    Appearance.setColorScheme(mode === 'system' ? 'unspecified' : scheme);
  } catch {
    /* older runtime: the in-app theme still applies */
  }
}
