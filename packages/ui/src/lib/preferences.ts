/**
 * Device preferences: the few settings that are this device's, not the
 * account's. Two exist, and both are applied somewhere real:
 *
 *   - `haptics`: gates every pattern `useHaptics()` plays.
 *   - `chartBucketSeconds`: the timeframe the Chart tab opens on. `null` means
 *     "the rule's own timeframe", which is what the chart did before this.
 *
 * Nothing here can loosen a pinned rule: a rule is on-chain and only the
 * cooling-off flow changes it. These are how the app feels, not what it allows.
 *
 * A module-level store rather than a context, so `platform.tsx` (which sits
 * above every provider) can gate haptics without importing React state from
 * below it. It is hydrated once, from the `storage` capability, by
 * `PlatformProvider`; until then the defaults apply, which are the app's
 * behaviour before this file existed.
 */

import { createStore, useStoreSelector } from './store';
import { timeframeByBucket, type Timeframe } from './chart-timeframes';

export interface Preferences {
  haptics: boolean;
  /** Seconds per candle, one of the chart's timeframes, or null for the rule's own. */
  chartBucketSeconds: number | null;
}

export const DEFAULT_PREFERENCES: Preferences = { haptics: true, chartBucketSeconds: null };

export const PREFERENCES_STORAGE_KEY = 'kanon.preferences.v1';

/** The shape of the platform `storage` capability, without importing it (platform imports this). */
interface StringStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Tolerant: anything unreadable, or outside what the app offers, falls back to the default. */
export function parsePreferences(raw: string | null | undefined): Preferences {
  if (!raw) return DEFAULT_PREFERENCES;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_PREFERENCES;
  const v = value as Record<string, unknown>;
  const bucket = v['chartBucketSeconds'];
  return {
    haptics: typeof v['haptics'] === 'boolean' ? v['haptics'] : DEFAULT_PREFERENCES.haptics,
    chartBucketSeconds:
      typeof bucket === 'number' && timeframeByBucket(bucket) ? bucket : DEFAULT_PREFERENCES.chartBucketSeconds,
  };
}

export function serializePreferences(p: Preferences): string {
  return JSON.stringify({ haptics: p.haptics, chartBucketSeconds: p.chartBucketSeconds });
}

export const preferencesStore = createStore<Preferences>(DEFAULT_PREFERENCES);

export const getPreferences = (): Preferences => preferencesStore.get();

/** A change made before the stored value has been read must win over it. */
let touched = false;

/** Reads the stored preferences once. Safe to call again: a later call re-reads unless a change was made. */
export async function hydratePreferences(storage: StringStorage): Promise<void> {
  try {
    const raw = await storage.get(PREFERENCES_STORAGE_KEY);
    if (!touched) preferencesStore.set(parsePreferences(raw));
  } catch {
    /* storage unavailable: the defaults stand */
  }
}

/** Applies a change now and writes it through. Storage failure never undoes the change. */
export function updatePreferences(patch: Partial<Preferences>, storage?: StringStorage): void {
  touched = true;
  const next = { ...preferencesStore.get(), ...patch };
  preferencesStore.set(next);
  if (!storage) return;
  try {
    void Promise.resolve(storage.set(PREFERENCES_STORAGE_KEY, serializePreferences(next))).catch(() => undefined);
  } catch {
    /* kept for this session */
  }
}

/** Test seam. */
export function resetPreferences(): void {
  touched = false;
  preferencesStore.set(DEFAULT_PREFERENCES);
}

/** One preference, re-rendering only when it changes. */
export function usePreference<K extends keyof Preferences>(key: K): Preferences[K] {
  return useStoreSelector(preferencesStore, (p) => p[key]);
}

/** The timeframe the chart should open on, or null to use the rule's own. */
export function preferredTimeframe(): Timeframe | null {
  const bucket = preferencesStore.get().chartBucketSeconds;
  return bucket === null ? null : (timeframeByBucket(bucket) ?? null);
}
