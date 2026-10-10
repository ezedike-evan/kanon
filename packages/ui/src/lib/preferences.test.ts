import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  getPreferences,
  hydratePreferences,
  parsePreferences,
  preferredTimeframe,
  resetPreferences,
  serializePreferences,
  updatePreferences,
} from './preferences';

function memoryStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(PREFERENCES_STORAGE_KEY, initial);
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

beforeEach(() => resetPreferences());

describe('parsePreferences', () => {
  it('falls back to the defaults for nothing, junk or the wrong type', () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('{not json')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('42')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('{"haptics":"yes"}')).toEqual(DEFAULT_PREFERENCES);
  });

  it('accepts only a timeframe the chart offers', () => {
    expect(parsePreferences('{"chartBucketSeconds":900}').chartBucketSeconds).toBe(900);
    expect(parsePreferences('{"chartBucketSeconds":123}').chartBucketSeconds).toBeNull();
    expect(parsePreferences('{"chartBucketSeconds":"900"}').chartBucketSeconds).toBeNull();
  });

  it('round-trips', () => {
    const p = {
      haptics: false,
      chartBucketSeconds: 14_400,
      chartPanelOpen: false,
      predictMarketsPanelOpen: true,
      predictSettlePanelOpen: false,
    };
    expect(parsePreferences(serializePreferences(p))).toEqual(p);
  });

  it('opens every side panel until one has been collapsed', () => {
    expect(DEFAULT_PREFERENCES).toMatchObject({
      chartPanelOpen: true,
      predictMarketsPanelOpen: true,
      predictSettlePanelOpen: true,
    });
    // Stored before the panels could collapse: the keys are absent, and the panels stay open.
    expect(parsePreferences('{"haptics":false,"chartBucketSeconds":900}')).toEqual({
      ...DEFAULT_PREFERENCES,
      haptics: false,
      chartBucketSeconds: 900,
    });
  });

  it('reads a collapsed panel, one panel at a time', () => {
    expect(parsePreferences('{"chartPanelOpen":false}')).toEqual({ ...DEFAULT_PREFERENCES, chartPanelOpen: false });
    expect(parsePreferences('{"predictMarketsPanelOpen":false}')).toEqual({
      ...DEFAULT_PREFERENCES,
      predictMarketsPanelOpen: false,
    });
    expect(parsePreferences('{"predictSettlePanelOpen":false}')).toEqual({
      ...DEFAULT_PREFERENCES,
      predictSettlePanelOpen: false,
    });
  });

  it('keeps a panel open when its stored value is not a yes or a no', () => {
    const junk = '{"chartPanelOpen":"false","predictMarketsPanelOpen":0,"predictSettlePanelOpen":null}';
    expect(parsePreferences(junk)).toEqual(DEFAULT_PREFERENCES);
  });

  it('carries nothing through that the app does not offer', () => {
    expect(parsePreferences('{"chartPanelOpen":false,"somethingElse":true}')).toEqual({
      ...DEFAULT_PREFERENCES,
      chartPanelOpen: false,
    });
  });
});

describe('the store', () => {
  it('hydrates from storage', async () => {
    await hydratePreferences(memoryStorage('{"haptics":false,"chartBucketSeconds":3600}'));
    expect(getPreferences()).toEqual({ ...DEFAULT_PREFERENCES, haptics: false, chartBucketSeconds: 3600 });
    expect(preferredTimeframe()?.label).toBe('1H');
  });

  it('remembers a collapsed panel across a reload, and leaves the other panels as they were', async () => {
    const storage = memoryStorage();
    updatePreferences({ chartPanelOpen: false }, storage);
    expect(getPreferences()).toMatchObject({ chartPanelOpen: false, predictMarketsPanelOpen: true });
    await Promise.resolve();

    resetPreferences(); // a new page load: the store starts from the defaults, panels open
    expect(getPreferences().chartPanelOpen).toBe(true);
    await hydratePreferences(storage);
    expect(getPreferences()).toEqual({ ...DEFAULT_PREFERENCES, chartPanelOpen: false });
  });

  it('writes a change through to storage and applies it at once', async () => {
    const storage = memoryStorage();
    updatePreferences({ haptics: false }, storage);
    expect(getPreferences().haptics).toBe(false);
    await Promise.resolve();
    expect(parsePreferences(storage.map.get(PREFERENCES_STORAGE_KEY))).toMatchObject({ haptics: false });
  });

  it('does not let a slow read of storage undo a change made meanwhile', async () => {
    const storage = memoryStorage('{"haptics":true}');
    const pending = hydratePreferences(storage);
    updatePreferences({ haptics: false });
    await pending;
    expect(getPreferences().haptics).toBe(false);
  });

  it('has no preferred timeframe until one is chosen: the chart keeps the rule\'s own', () => {
    expect(preferredTimeframe()).toBeNull();
    updatePreferences({ chartBucketSeconds: 300 });
    expect(preferredTimeframe()?.bucketSeconds).toBe(300);
    updatePreferences({ chartBucketSeconds: null });
    expect(preferredTimeframe()).toBeNull();
  });

  it('survives storage that throws', async () => {
    const broken = {
      get: async () => {
        throw new Error('blocked');
      },
      set: async () => {
        throw new Error('blocked');
      },
    };
    await expect(hydratePreferences(broken)).resolves.toBeUndefined();
    expect(() => updatePreferences({ haptics: false }, broken)).not.toThrow();
    expect(getPreferences().haptics).toBe(false);
  });
});
