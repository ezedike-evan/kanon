import { useSyncExternalStore } from 'react';
import { readSpotMarketAnswer, type SpotMarket } from './spot';

/**
 * The market Kanon listed on Kuru's testnet, as the spot screen reads it: one
 * public request to the gateway (`GET /kuru/market`) that answers with the
 * market's terms and its book, or says in words that there is none. No sign-in
 * is involved, so a visitor sees the book too.
 *
 * It is a request, not a subscription, so a store polls it, and only while
 * something is mounted that reads it: the first subscriber starts the timer and
 * the last one stops it.
 *
 * Two kinds of "no answer" are kept apart. When the gateway itself says there
 * is no book to show (nothing listed, or it could not read the chain), its
 * sentence replaces the book: the gateway does not serve an old book as the
 * book, and neither does this. When the request never arrived or came back
 * unreadable, the last good book stays on screen, marked as such, and the
 * ticket holds until a read succeeds. A book is never made up either way.
 */

export const SPOT_MARKET_PATH = '/kuru/market';
/** The gateway answers every caller from one read of the chain for about three seconds. */
export const SPOT_EVERY_MS = 4_000;

export const SPOT_NOT_CONNECTED = 'Market data is not connected in this build.';
export const SPOT_UNREACHABLE = 'The market could not be reached. Trying again.';
export const SPOT_UNKNOWN_SHAPE = 'The market came back in a shape this screen does not know.';

export type SpotUnavailable = 'not_connected' | 'not_listed' | 'unreachable' | 'unknown_shape';

export type SpotMarketState =
  | { status: 'loading' }
  | { status: 'unavailable'; code: SpotUnavailable; message: string }
  /** `failed` is set while the newest read did not succeed: the book is then the last good one, not the current one. */
  | { status: 'ready'; market: SpotMarket; failed: boolean };

/** One public GET against the gateway, as parsed JSON. Rejects when it cannot be read. */
export type SpotGet = (path: string) => Promise<unknown>;

export interface SpotStoreDeps {
  get: SpotGet;
  everyMs?: number | undefined;
  setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearTimer?: ((handle: unknown) => void) | undefined;
}

export interface SpotStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SpotMarketState;
  getServerSnapshot(): SpotMarketState;
}

const LOADING: SpotMarketState = { status: 'loading' };
const NOT_CONNECTED: SpotMarketState = { status: 'unavailable', code: 'not_connected', message: SPOT_NOT_CONNECTED };

/** A store that says market data is not connected, for a build with no gateway address. */
export const DISCONNECTED_SPOT_STORE: SpotStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => NOT_CONNECTED,
  getServerSnapshot: () => LOADING,
};

export function createSpotStore(deps: SpotStoreDeps): SpotStore {
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const listeners = new Set<() => void>();
  let state: SpotMarketState = LOADING;
  let last: SpotMarket | null = null;
  let timer: unknown = null;
  // Bumped each time the store starts or stops, so an answer to an earlier run's request is dropped.
  let run = 0;
  // One request at a time within a run: a slow answer is waited for, not raced by the next tick.
  // Held per run, so a request left over from an earlier run does not hold up this one's first read.
  let reading = -1;

  const publish = (next: SpotMarketState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  // The request itself failed. With a book already read, that book stays, said to be the last good one.
  const failed = (code: SpotUnavailable, message: string) => {
    publish(last ? { status: 'ready', market: last, failed: true } : { status: 'unavailable', code, message });
  };

  async function read(mine: number): Promise<void> {
    if (reading === mine) return;
    reading = mine;
    try {
      const answer = readSpotMarketAnswer(await deps.get(SPOT_MARKET_PATH));
      if (mine !== run) return;
      if (!answer) return failed('unknown_shape', SPOT_UNKNOWN_SHAPE);
      if (!answer.ok) {
        // The gateway's own word that there is no book to show. An older one is not kept in its place.
        last = null;
        return publish({ status: 'unavailable', code: answer.code, message: answer.message });
      }
      last = answer.market;
      publish({ status: 'ready', market: answer.market, failed: false });
    } catch {
      if (mine === run) failed('unreachable', SPOT_UNREACHABLE);
    } finally {
      if (reading === mine) reading = -1;
    }
  }

  function start(): void {
    const mine = ++run;
    void read(mine);
    timer = setTimer(() => void read(mine), deps.everyMs ?? SPOT_EVERY_MS);
  }

  function stop(): void {
    run += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    // Nobody is looking. The next reader starts from a fresh read, not from a book of unknown age.
    last = null;
    state = LOADING;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => state,
    getServerSnapshot: () => LOADING,
  };
}

/** The listed market with its book, read only while the caller is mounted. */
export function useSpotStore(store: SpotStore): SpotMarketState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
