/**
 * Where a person's chart drawings live between sessions, keyed by asset and
 * timeframe.
 *
 * They are written through the platform's `storage` capability (see
 * `platform.tsx`), so a phone and a browser each use their own durable store.
 * Where no capability is supplied they fall back to memory: drawings survive
 * switching asset or timeframe inside a session but not a restart. The
 * WebView's own storage is deliberately not used; it is not durable enough to
 * trust.
 */
import { parseDrawings, type Drawing } from './chart-drawings';

export interface DrawingStore {
  load(key: string): Promise<Drawing[]>;
  save(key: string, drawings: readonly Drawing[]): void;
}

/** The shape of `usePlatform().storage`: an async string store. */
export interface StringStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const PREFIX = 'kanon.chart.drawings.v1';

/** `BTC / USD`, `btc/usd` and `BTC/USD` are the same chart. */
export function drawingsKey(asset: string, bucketSeconds: number): string {
  return `${PREFIX}:${asset.replace(/\s+/g, '').toUpperCase()}:${bucketSeconds}`;
}

export function storeFromStringStorage(storage: StringStorage): DrawingStore {
  return {
    async load(key) {
      try {
        const raw = await storage.get(key);
        return raw ? parseDrawings(JSON.parse(raw)) : [];
      } catch {
        return [];
      }
    },
    save(key, drawings) {
      try {
        void Promise.resolve(storage.set(key, JSON.stringify(drawings))).catch(() => undefined);
      } catch {
        // Storage can throw in a private window or when full. The chart works without it.
      }
    },
  };
}

export function createMemoryStore(): DrawingStore {
  const map = new Map<string, Drawing[]>();
  return {
    async load(key) {
      return map.get(key) ?? [];
    },
    save(key, drawings) {
      map.set(key, [...drawings]);
    },
  };
}

function isStringStorage(value: unknown): value is StringStorage {
  const v = value as Partial<StringStorage> | null | undefined;
  return !!v && typeof v.get === 'function' && typeof v.set === 'function';
}

const memory = createMemoryStore();

/**
 * The store to use. `platform` is whatever `usePlatform()` returned: its
 * `storage` capability (localStorage on the web, secure storage on a device,
 * a per-session map where neither is allowed) is the durable home. Without one
 * the drawings live in memory for the session.
 */
export function resolveDrawingStore(platform?: unknown): DrawingStore {
  const capability = (platform as { storage?: unknown } | null | undefined)?.storage;
  return isStringStorage(capability) ? storeFromStringStorage(capability) : memory;
}
