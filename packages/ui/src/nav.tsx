import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, type PressableProps } from 'react-native';

/**
 * The one place the two routers meet.
 *
 * Screens live in this package and are rendered by both apps, so they cannot
 * import `next/link` or `expo-router` directly. Each app supplies the three
 * operations it can perform; everything above this line is router-agnostic.
 */
export interface Navigator {
  push(href: string): void;
  replace(href: string): void;
  back(): void;
  /**
   * Optional: reads one query or route parameter of the current route. It is a
   * hook (it is called during render), so an implementation is a hook such as
   * expo-router's `useLocalSearchParams`, and its identity must not change.
   * The web needs none: `useRouteParam` reads the address bar itself.
   */
  useParam?(name: string): string | undefined;
}

const NavContext = createContext<Navigator | null>(null);

export function NavProvider({
  navigator,
  children,
}: {
  navigator: Navigator;
  children: ReactNode;
}) {
  return <NavContext.Provider value={navigator}>{children}</NavContext.Provider>;
}

const noParam = (): undefined => undefined;

/**
 * One optional parameter of the current route, e.g. `/chart?asset=ETH/USD`.
 *
 * On a device the app's navigator supplies it (`Navigator.useParam`). On the
 * web it is read from the address bar after mount, never during the first
 * render, so a server-rendered page and its hydrated twin agree; it follows
 * back/forward too. A screen mounted by a link from another screen sees the
 * value on its first effect. Returns `undefined` when the parameter is absent.
 */
export function useRouteParam(name: string): string | undefined {
  const nav = useContext(NavContext);
  const useRouterParam = nav?.useParam ?? noParam;
  const fromRouter = useRouterParam(name);
  const [fromLocation, setFromLocation] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const read = () =>
      setFromLocation(new URLSearchParams(window.location.search).get(name) ?? undefined);
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [name]);
  return fromRouter ?? fromLocation;
}

export function useNavigator(): Navigator {
  const nav = useContext(NavContext);
  if (!nav) throw new Error('useNavigator: no <NavProvider> above this screen');
  return nav;
}

/**
 * A tappable region that navigates.
 *
 * On the web react-native-web turns the `href` into a real anchor, so a link
 * still opens in a new tab and still reads as a link to a screen reader. On a
 * device the press handler is the whole story.
 */
export function Link({
  href,
  className,
  children,
  ...rest
}: { href: string; className?: string | undefined; children: ReactNode } & Omit<
  PressableProps,
  'onPress' | 'children'
>) {
  const nav = useNavigator();
  return (
    <Pressable
      role="link"
      {...(className ? { className } : {})}
      onPress={() => nav.push(href)}
      {...(Platform.OS === 'web' ? ({ href } as object) : null)}
      {...rest}
    >
      {children}
    </Pressable>
  );
}
