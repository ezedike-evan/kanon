import type { Icon as IconName } from '../icons';
import { routes } from '../../lib/routes';

export type TabKey = 'home' | 'chart' | 'create' | 'predict' | 'profile';

export interface TabDef {
  key: TabKey;
  /** The bottom bar's label: mono, uppercase. */
  label: string;
  /** The desktop rail's label: sentence case. */
  navLabel: string;
  href: string;
  icon: IconName;
}

/**
 * Home, Chart, AI, Predict, Profile. The middle one is the AI strategy builder.
 * One list drives the phone's bottom bar and the desktop's side rail, so the two
 * cannot disagree about what the destinations are or what order they come in.
 */
export const TABS: readonly TabDef[] = [
  { key: 'home', label: 'HOME', navLabel: 'Home', href: routes.home, icon: 'home' },
  { key: 'chart', label: 'CHART', navLabel: 'Chart', href: routes.chart, icon: 'chart' },
  { key: 'create', label: 'AI', navLabel: 'AI', href: routes.create, icon: 'sparkles' },
  { key: 'predict', label: 'PREDICT', navLabel: 'Predict', href: routes.predict, icon: 'zap' },
  { key: 'profile', label: 'PROFILE', navLabel: 'Profile', href: routes.profile, icon: 'user' },
];
