import { createContext, useContext, type ReactNode } from 'react';
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
      className={className}
      onPress={() => nav.push(href)}
      {...(Platform.OS === 'web' ? ({ href } as object) : null)}
      {...rest}
    >
      {children}
    </Pressable>
  );
}
