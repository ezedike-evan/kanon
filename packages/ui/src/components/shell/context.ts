import { createContext, useContext, useLayoutEffect } from 'react';
import type { TabKey } from './tabs';

/**
 * How a `TabBar` tells the `Screen` around it which destination is current, so
 * the desktop rail can light the same item without the screen saying it twice.
 * The default is inert: on a phone there is no rail to tell, and a `TabBar`
 * rendered outside a `Screen` must still work.
 */
export interface ShellRegistry {
  register(active: TabKey | null): void;
}

const inert: ShellRegistry = { register: () => undefined };

export const ShellContext = createContext<ShellRegistry>(inert);

/**
 * Registers `active` with the enclosing `Screen` for as long as the caller is
 * mounted. A layout effect, so a client-side navigation paints with the rail
 * already lit instead of lighting it a frame late.
 */
export function useRegisterActiveTab(active: TabKey) {
  const { register } = useContext(ShellContext);
  useLayoutEffect(() => {
    register(active);
    return () => register(null);
  }, [register, active]);
}
