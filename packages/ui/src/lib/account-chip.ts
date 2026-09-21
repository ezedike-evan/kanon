import type { KanonSession, ProfileState } from './domain-types';
import { DEMO_PROFILE } from './profile-demo';
import { handleOf } from './profile-logic';

/**
 * What the desktop rail's account chip says: a name, a line under it, and
 * whether it is the demo account. Signed out is the demo account, and says so;
 * a profile that has not loaded yet says nothing it might have to take back.
 */
export function accountChipOf(
  profile: ProfileState,
  session: Pick<KanonSession, 'pending'>,
): { name: string; sub: string; demo: boolean } {
  if (profile.status === 'loading' || session.pending) return { name: 'Loading', sub: '', demo: false };
  if (profile.status === 'empty') return { name: 'Finish signing up', sub: 'NO NAME YET', demo: false };
  if (profile.status === 'demo') return { name: DEMO_PROFILE.name, sub: 'DEMO ACCOUNT', demo: true };
  const name = profile.settings.name.trim() || 'Unnamed';
  const handle = handleOf(profile.settings.username) || profile.settings.email || '';
  return { name, sub: handle, demo: false };
}
