import { useSyncExternalStore } from 'react';
import { readContext, readTickers, withTickers, type RiskMarketTerms, type RiskState } from './perpl-risk';

/**
 * Perpl's public market data, as the risk screen reads it: the market list with
 * its margin terms and funding (`/v1/pub/context`, which changes slowly) and
 * every market's state (`/v1/market-data/ticker`, which changes with each
 * trade). Both come through the gateway, which serves them to any caller: no
 * sign-in is needed, so a visitor sees the markets too.
 *
 * They are requests, not a subscription, so a store polls them, and only while
 * something is mounted that reads it: the first subscriber starts the timers
 * and the last one stops them. A read that fails keeps the last good answer on
 * screen; the state's own stamp, which the screen shows, is what says how old
 * it is.
 */

export const RISK_NOT_CONNECTED = 'Market data is not connected in this build.';
export const RISK_UNREACHABLE = "Perpl's market data could not be reached. Trying again.";
export const RISK_UNKNOWN_SHAPE = "Perpl's market data came back in a shape this screen does not know.";

/** How often the slow half is read: terms and funding change by the hour. */
export const CONTEXT_EVERY_MS = 60_000;
/** How often the fast half is read. The gateway answers many callers from one read, so this costs the venue nothing extra. */
export const TICKERS_EVERY_MS = 5_000;

export type PerplRiskState =
  | { status: 'loading' }
  /** No gateway address is set, or nothing has been read yet and the last try failed. */
  | { status: 'unavailable'; message: string }
  | { status: 'ready'; markets: RiskMarketTerms[] };

/** One public GET against the gateway, as parsed JSON. Rejects when it cannot be read. */
export type RiskGet = (path: string) => Promise<unknown>;

export interface RiskStoreDeps {
  get: RiskGet;
  contextEveryMs?: number | undefined;
  tickersEveryMs?: number | undefined;
  setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearTimer?: ((handle: unknown) => void) | undefined;
}

export interface RiskStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PerplRiskState;
  getServerSnapshot(): PerplRiskState;
}

const LOADING: PerplRiskState = { status: 'loading' };
const NOT_CONNECTED: PerplRiskState = { status: 'unavailable', message: RISK_NOT_CONNECTED };

/** A store that says market data is not connected, for a build with no gateway address. */
export const DISCONNECTED_RISK_STORE: RiskStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => NOT_CONNECTED,
  getServerSnapshot: () => LOADING,
};

export function createRiskStore(deps: RiskStoreDeps): RiskStore {
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const listeners = new Set<() => void>();
  let state: PerplRiskState = LOADING;
  let terms: RiskMarketTerms[] | null = null;
  let tickers: Map<number, RiskState> | null = null;
  let timers: unknown[] = [];
  // Bumped each time the store starts, so an answer to an earlier run's request is dropped.
  let run = 0;

  const publish = (next: PerplRiskState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const merged = () => {
    if (terms) publish({ status: 'ready', markets: withTickers(terms, tickers) });
  };
  // A failure only shows while there is nothing to draw: after that the last good answer stays.
  const failed = (message: string) => {
    if (!terms) publish({ status: 'unavailable', message });
  };

  async function readTerms(mine: number): Promise<void> {
    try {
      const parsed = readContext(await deps.get('/v1/pub/context'));
      if (mine !== run) return;
      if (!parsed) return failed(RISK_UNKNOWN_SHAPE);
      terms = parsed;
      merged();
    } catch {
      if (mine === run) failed(RISK_UNREACHABLE);
    }
  }

  async function readStates(mine: number): Promise<void> {
    try {
      const parsed = readTickers(await deps.get('/v1/market-data/ticker'));
      if (mine !== run || !parsed) return;
      tickers = parsed;
      merged();
    } catch {
      // The context carries a state of its own, so a missed ticker leaves that one on screen.
    }
  }

  function start(): void {
    const mine = ++run;
    void readTerms(mine);
    void readStates(mine);
    timers = [
      setTimer(() => void readTerms(mine), deps.contextEveryMs ?? CONTEXT_EVERY_MS),
      setTimer(() => {
        // Until the market list has been read once there is nothing to draw, so it is asked for
        // again on the fast timer instead of leaving "trying again" on screen for a minute.
        if (!terms) void readTerms(mine);
        void readStates(mine);
      }, deps.tickersEveryMs ?? TICKERS_EVERY_MS),
    ];
  }

  function stop(): void {
    run += 1;
    for (const timer of timers) clearTimer(timer);
    timers = [];
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

/** Perpl's markets with their terms and newest state, read only while the caller is mounted. */
export function useRiskStore(store: RiskStore): PerplRiskState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
