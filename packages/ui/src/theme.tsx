import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { View, useColorScheme } from 'react-native';
import { vars } from 'nativewind';
import {
  THEME_STORAGE_KEY,
  themeVars,
  themes,
  type ThemeMode,
  type ThemeScheme,
} from '@kanon/tokens';
import { isWeb, syncDocumentTheme, syncNativeAppearance, usePlatform } from './platform';
import { isThemeMode, resolveScheme } from './lib/theme-logic';

/** The resolved palette for the active scheme: hex strings, for JS-side uses. */
export type ThemeColors = (typeof themes)[ThemeScheme];

export interface ThemeState {
  /** What the user chose: dark, light or system. */
  mode: ThemeMode;
  /** Persists the choice and applies it immediately. */
  setMode(mode: ThemeMode): void;
  /** What is actually drawn: `system` resolved against the OS. */
  scheme: ThemeScheme;
  /**
   * Resolved colours by token name. Use these wherever a class cannot reach:
   * `placeholderTextColor`, SVG strokes, chart layouts, shadow colours.
   * Everywhere else use the Tailwind utilities (`bg-panel`), which switch by
   * themselves.
   */
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeState>({
  mode: 'dark',
  setMode: () => undefined,
  scheme: 'dark',
  colors: themes.dark,
});

/**
 * Dark is the default. Colour utilities resolve from CSS variables, so switching
 * theme re-themes the whole tree without re-rendering it:
 *
 * - Web: `theme.css` defines the variables per `data-theme` on <html>, which
 *   this provider keeps in step (an inline boot script sets it before first
 *   paint so a light-mode user never sees a dark flash).
 * - Native: the same variables are handed to NativeWind's `vars()` on a root
 *   view, and the OS appearance is pinned so system chrome matches.
 *
 * The choice persists through the `storage` capability.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { storage } = usePlatform();
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('dark');
  const [ready, setReady] = useState(isWeb);

  useEffect(() => {
    let live = true;
    storage
      .get(THEME_STORAGE_KEY)
      .then((stored) => {
        if (live && isThemeMode(stored)) setModeState(stored);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, [storage]);

  const scheme = resolveScheme(mode, system);

  useEffect(() => {
    syncDocumentTheme(scheme);
    syncNativeAppearance(mode, scheme);
  }, [mode, scheme]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      storage.set(THEME_STORAGE_KEY, next).catch(() => undefined);
    },
    [storage],
  );

  const value = useMemo<ThemeState>(
    () => ({ mode, setMode, scheme, colors: themes[scheme] }),
    [mode, setMode, scheme],
  );
  const style = useMemo(() => (isWeb ? undefined : vars(themeVars(scheme))), [scheme]);

  // Native holds its first frame until the stored choice is read, so a light-mode
  // user does not see one dark frame. The web reads it in <head> instead.
  if (!ready) return <View style={{ flex: 1, backgroundColor: themes.dark.void }} />;

  return (
    <ThemeContext.Provider value={value}>
      {isWeb ? (
        children
      ) : (
        <View className="flex-1" style={style}>
          {children}
        </View>
      )}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
