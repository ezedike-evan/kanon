import { useSyncExternalStore } from 'react';
import {
  ONCHAIN_STRATEGY_LIMIT,
  newestFirst,
  ownerKey,
  readRecord,
  readStrategies,
  recordRequest,
  recordRows,
  strategiesRequest,
  type IndexerRequest,
  type OnchainRow,
} from './onchain-record';
import { shareStructure } from './store';

/**
 * Profile's on-chain record, as it is read: two GraphQL requests to the Kanon
 * indexer on Envio HyperIndex (`onchain-record.ts` says why two), for one
 * wallet's rules.
 *
 * They are requests, not a subscription, so a store polls them, and only while
 * something is mounted that reads it: the first subscriber starts the timer and
 * the last one stops it. A read that fails keeps the last good record on screen
 * and says that the newest read failed; before there is one, it says the record
 * could not be read.
 *
 * The indexer is public data keyed by address, so no sign-in token is sent. The
 * address is the signed-in wallet's own, and signed out nothing is read at all.
 */

export const ONCHAIN_NOT_CONNECTED = 'The on-chain record is not connected in this build.';
export const ONCHAIN_UNREACHABLE = 'The on-chain record could not be read. Trying again.';
export const ONCHAIN_UNKNOWN_SHAPE = 'The indexer answered in a shape this screen does not know.';

/** How often the record is read again. A pin or a refusal is minutes apart, not seconds. */
export const ONCHAIN_EVERY_MS = 30_000;
const POST_TIMEOUT_MS = 15_000;

export type OnchainRecordState =
  | { status: 'loading' }
  /** No indexer address is set in this build. */
  | { status: 'not_connected' }
  | { status: 'signed_out' }
  /** Signed in, with no wallet to have pinned anything. */
  | { status: 'no_wallet' }
  /** Nothing has been read yet and the last try failed. */
  | { status: 'unavailable'; message: string }
  | {
      status: 'ready';
      rows: OnchainRow[];
      /** Older rows exist that the read did not reach. */
      truncated: boolean;
      /** Milliseconds this record was read. */
      readAt: number;
      /** Why the newest read failed, while the record on screen is from `readAt`. Null when the newest read is the one shown. */
      problem: string | null;
    };

/** One GraphQL request to the indexer, as parsed JSON. Rejects when it cannot be read. */
export type IndexerPost = (request: IndexerRequest) => Promise<unknown>;

// --- The client -----------------------------------------------------------------

export interface IndexerClientOptions {
  /** The indexer's GraphQL endpoint: Envio's hosted address, or `http://localhost:8080/v1/graphql`. */
  url: string;
  fetchImpl?: typeof fetch;
}

export function createIndexerPost(opts: IndexerClientOptions): IndexerPost {
  const url = opts.url.trim();
  return async (request) => {
    // `AbortSignal.timeout` is not on every device this runs on.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const res = await (opts.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`the indexer answered ${res.status}`);
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The indexer for a configured address, or `undefined` when none is set, in
 * which case the record says it is not connected. Each app passes its own
 * `*_PUBLIC_INDEXER_URL`, already checked by `assertPublicEnv`.
 */
export function resolveIndexer(indexerUrl: string | undefined): IndexerPost | undefined {
  const url = indexerUrl?.trim();
  return url ? createIndexerPost({ url }) : undefined;
}

// --- The store ------------------------------------------------------------------

export interface OnchainRecordStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): OnchainRecordState;
  getServerSnapshot(): OnchainRecordState;
}

export interface OnchainRecordStoreDeps {
  post: IndexerPost;
  /** The chain the app is configured for: the indexer's ids start with it. */
  chainId: () => number;
  /** The wallet whose rules are read, as an `ownerKey`. */
  owner: string;
  everyMs?: number | undefined;
  now?: (() => number) | undefined;
  setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearTimer?: ((handle: unknown) => void) | undefined;
}

const LOADING: OnchainRecordState = { status: 'loading' };

/** A store that only ever says one thing, for the states with nothing to read. */
const fixed = (state: OnchainRecordState): OnchainRecordStore => ({
  subscribe: () => () => undefined,
  getSnapshot: () => state,
  getServerSnapshot: () => LOADING,
});

export const NOT_CONNECTED_RECORD_STORE = fixed({ status: 'not_connected' });
const LOADING_STORE = fixed(LOADING);
const SIGNED_OUT_STORE = fixed({ status: 'signed_out' });
const NO_WALLET_STORE = fixed({ status: 'no_wallet' });

const sameRow = (a: OnchainRow, b: OnchainRow) =>
  a.txHash === b.txHash && a.mark === b.mark && a.decidingValue === b.decidingValue && newestFirst(a, b) === 0;

export function createOnchainRecordStore(deps: OnchainRecordStoreDeps): OnchainRecordStore {
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let state: OnchainRecordState = LOADING;
  let timer: unknown = null;
  // Bumped each time the store starts, so an answer to an earlier run's request is dropped.
  let run = 0;
  // The run whose read is still out. A tick that finds its own read out waits for it.
  let reading = -1;

  const publish = (next: OnchainRecordState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const good = (rows: OnchainRow[], truncated: boolean) => {
    // A read that changed nothing hands back the rows it already had, so a drawn row is not drawn again.
    const kept = state.status === 'ready' ? shareStructure(state.rows, rows, (r) => r.id, sameRow) : rows;
    publish({ status: 'ready', rows: kept, truncated, readAt: now(), problem: null });
  };
  // Before there is a record the failure is the whole answer; after, the record stays and carries it.
  const failed = (message: string) => {
    if (state.status === 'ready') publish({ ...state, problem: message });
    else publish({ status: 'unavailable', message });
  };

  async function read(mine: number): Promise<void> {
    if (reading === mine) return;
    reading = mine;
    try {
      const chainId = deps.chainId();
      const found = readStrategies(await deps.post(strategiesRequest(chainId, deps.owner)), chainId);
      if (mine !== run) return;
      if (!found) return failed(ONCHAIN_UNKNOWN_SHAPE);
      const rulesCut = found.seen >= ONCHAIN_STRATEGY_LIMIT;
      // No rule of this wallet's is on-chain, so there is nothing to ask the second question about.
      if (found.strategies.length === 0) return good([], rulesCut);
      const record = readRecord(await deps.post(recordRequest(chainId, found.strategies.map((s) => s.key))));
      if (mine !== run) return;
      if (!record) return failed(ONCHAIN_UNKNOWN_SHAPE);
      const { rows, truncated } = recordRows(found.strategies, record);
      good(rows, truncated || rulesCut);
    } catch {
      if (mine === run) failed(ONCHAIN_UNREACHABLE);
    } finally {
      if (reading === mine) reading = -1;
    }
  }

  function start(): void {
    const mine = ++run;
    void read(mine);
    timer = setTimer(() => void read(mine), deps.everyMs ?? ONCHAIN_EVERY_MS);
  }

  function stop(): void {
    run += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
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

// --- The read -------------------------------------------------------------------

export interface OnchainRecordSession {
  /** Whether anyone is signed in has not been said yet. */
  pending: boolean;
  signedIn: boolean;
}

export interface OnchainRecordStores {
  /** The one store for a wallet, made on first asking: two readers of the same wallet share its requests. */
  for(owner: string): OnchainRecordStore;
}

/** A store per wallet for the life of the app: a session holds one wallet, a second after a new sign-in. */
export function createOnchainRecordStores(
  deps: Omit<OnchainRecordStoreDeps, 'owner'>,
): OnchainRecordStores {
  const stores = new Map<string, OnchainRecordStore>();
  return {
    for(owner) {
      const existing = stores.get(owner);
      if (existing) return existing;
      const made = createOnchainRecordStore({ ...deps, owner });
      stores.set(owner, made);
      return made;
    },
  };
}

/**
 * Which store answers for `address`, in order of what makes the rest moot: no
 * indexer in this build, then nobody signed in, then no wallet, then the
 * wallet's own record.
 */
export function pickOnchainRecordStore(
  stores: OnchainRecordStores | null,
  session: OnchainRecordSession,
  address: string | null,
): OnchainRecordStore {
  if (!stores) return NOT_CONNECTED_RECORD_STORE;
  if (session.pending) return LOADING_STORE;
  if (!session.signedIn) return SIGNED_OUT_STORE;
  const owner = ownerKey(address);
  return owner ? stores.for(owner) : NO_WALLET_STORE;
}

/** The record a store holds, read only while the caller is mounted. */
export function useOnchainRecordStore(store: OnchainRecordStore): OnchainRecordState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/** The data source's `useOnchainRecord`, for an indexer (or none) and a session. */
export function createOnchainRecordReads(deps: {
  stores: OnchainRecordStores | null;
  session: OnchainRecordSession;
}): { useOnchainRecord(address: string | null): OnchainRecordState } {
  const { stores, session } = deps;
  return {
    useOnchainRecord(address) {
      return useOnchainRecordStore(pickOnchainRecordStore(stores, session, address));
    },
  };
}
