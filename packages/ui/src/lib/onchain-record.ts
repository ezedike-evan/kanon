import { abbreviateHash } from '@kanon/spec';
import { explorerUrl, stampLabel } from './profile-logic';
import type { TxRef } from './venue-trade';

/**
 * The pure half of Profile's on-chain record: what the chain holds for a
 * wallet's rules, as the Kanon indexer on Envio HyperIndex serves it
 * (`packages/indexer`: `schema.graphql` is the shape, `src/handlers/` is how a
 * row comes to be). No React, no I/O and no clock, so every rule here is pinned
 * down in `onchain-record.test.ts`.
 *
 * The indexer's GraphQL API is Hasura's: a root field per entity, filtered with
 * `where`, ordered with `order_by`. Its ids are `${chainId}_…` and its
 * addresses are lowercase.
 *
 * Two requests, because the schema gives a rule's events no owner and no
 * relation to the rule: the wallet's rules are found first (`Strategy.owner`),
 * then every event and every refusal of those rules. Filtering events by who
 * sent them would be one request and would be wrong: finalizing a loosening is
 * open to any sender, so a rule's own finalization can carry another address.
 *
 * Nothing here is a profit or a loss, and a refusal is not a fault: it is a row
 * like a pin is, with the predicate and the number the contract gave for it.
 */

// --- What is asked --------------------------------------------------------------

/** One GraphQL request, as it is posted. */
export interface IndexerRequest {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
}

/** A wallet has a handful of rules. Past this many the newest are read and the record says it is cut. */
export const ONCHAIN_STRATEGY_LIMIT = 100;
/** How many rule events, and how many refusals, one read asks for. */
export const ONCHAIN_ROW_LIMIT = 50;

export const ONCHAIN_STRATEGIES_QUERY = `query KanonOnchainStrategies($chainId: Int!, $owner: String!, $limit: Int!) {
  Strategy(
    where: { chainId: { _eq: $chainId }, owner: { _eq: $owner } }
    order_by: [{ pinnedAt: desc }]
    limit: $limit
  ) {
    id
    strategyId
    activeSpecHash
    pendingSpecHash
  }
}`;

// Monad makes a block every 400 ms and a block's time is in whole seconds, so several blocks
// share a timestamp: the block number has to break the tie before the log index does.
export const ONCHAIN_RECORD_QUERY = `query KanonOnchainRecord($chainId: Int!, $strategies: [String!]!, $limit: Int!) {
  StrategyEvent(
    where: { chainId: { _eq: $chainId }, strategy_id: { _in: $strategies } }
    order_by: [{ timestamp: desc }, { blockNumber: desc }, { logIndex: desc }]
    limit: $limit
  ) {
    id
    strategy_id
    kind
    oldSpecHash
    newSpecHash
    cooldownEndsAt
    timestamp
    blockNumber
    logIndex
    txHash
  }
  Refusal(
    where: { chainId: { _eq: $chainId }, strategy_id: { _in: $strategies } }
    order_by: [{ timestamp: desc }, { blockNumber: desc }, { logIndex: desc }]
    limit: $limit
  ) {
    id
    strategy_id
    specHash
    predicate
    decidingValue
    timestamp
    blockNumber
    logIndex
    txHash
  }
}`;

/** A wallet's address as the indexer stores it: lowercase. Null for anything that is not an address. */
export function ownerKey(address: string | null | undefined): string | null {
  const a = address?.trim() ?? '';
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
}

/** The rules `owner` pinned on `chainId`, newest pin first. `owner` is an `ownerKey`. */
export function strategiesRequest(chainId: number, owner: string): IndexerRequest {
  return {
    operationName: 'KanonOnchainStrategies',
    query: ONCHAIN_STRATEGIES_QUERY,
    variables: { chainId, owner, limit: ONCHAIN_STRATEGY_LIMIT },
  };
}

/** Every event and every refusal of the rules named by `strategyKeys` (the indexer's own ids), newest first. */
export function recordRequest(
  chainId: number,
  strategyKeys: readonly string[],
  limit: number = ONCHAIN_ROW_LIMIT,
): IndexerRequest {
  return {
    operationName: 'KanonOnchainRecord',
    query: ONCHAIN_RECORD_QUERY,
    variables: { chainId, strategies: [...strategyKeys], limit },
  };
}

// --- What comes back ------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const hashOrNull = (v: unknown): string | null => (isHash(v) ? v : null);

/**
 * A `BigInt` column, as the exact digits the chain emitted. Hasura sends it as a
 * string, or as a JSON number when it is not told to stringify. A number past
 * the safe range has already been rounded, so it is null and not a figure.
 */
const exactInteger = (v: unknown): string | null =>
  typeof v === 'string' && /^-?\d+$/.test(v)
    ? v
    : typeof v === 'number' && Number.isSafeInteger(v)
      ? String(v)
      : null;

/** A GraphQL answer's `data`. Null when the answer carries errors, or is not an answer. */
function dataOf(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (Array.isArray(body.errors) && body.errors.length > 0) return null;
  return isRecord(body.data) ? body.data : null;
}

/** One of the wallet's rules, as the registry holds it now. */
export interface OnchainStrategy {
  /** The indexer's id for it: `${chainId}_${registryId}`. */
  key: string;
  /** The id the registry gave it, a decimal string. */
  registryId: string;
  /** The spec hash the gate enforces now. */
  activeSpecHash: string | null;
  /** The hash of a loosening waiting out its hold. Null when none is. */
  pendingSpecHash: string | null;
}

/**
 * The answer to `strategiesRequest`. A row from another chain, or one with no
 * registry id, is left out; a body that is not that answer is null.
 */
export function readStrategies(
  body: unknown,
  chainId: number,
): { strategies: OnchainStrategy[]; seen: number } | null {
  const data = dataOf(body);
  if (!data || !Array.isArray(data.Strategy)) return null;
  const prefix = `${chainId}_`;
  const strategies: OnchainStrategy[] = [];
  for (const s of data.Strategy) {
    if (!isRecord(s) || typeof s.id !== 'string' || !s.id.startsWith(prefix)) continue;
    const registryId = s.id.slice(prefix.length);
    if (!/^\d+$/.test(registryId)) continue;
    strategies.push({
      key: s.id,
      registryId,
      activeSpecHash: hashOrNull(s.activeSpecHash),
      pendingSpecHash: hashOrNull(s.pendingSpecHash),
    });
  }
  return { strategies, seen: data.Strategy.length };
}

export type OnchainKind = 'pinned' | 'tightened' | 'loosening_proposed' | 'loosening_finalized' | 'refused';

/** The schema's `StrategyEventKind`. A map, so a kind named like an object's own method is not found on one. */
const EVENT_KIND: ReadonlyMap<unknown, OnchainKind> = new Map<unknown, OnchainKind>([
  ['PINNED', 'pinned'],
  ['TIGHTENED', 'tightened'],
  ['LOOSENING_PROPOSED', 'loosening_proposed'],
  ['LOOSENING_FINALIZED', 'loosening_finalized'],
]);

/** One thing the chain recorded about a rule: a change to it, or a trade it refused. */
export interface OnchainRow {
  id: string;
  kind: OnchainKind;
  /** The indexer's id of the rule it belongs to. */
  strategyKey: string;
  /** The block's own time, in milliseconds. */
  at: number;
  blockNumber: number;
  logIndex: number;
  /** The transaction that carries it. */
  txHash: string;
  /** The spec hash the row is about: the one pinned, the one a change leads to, the one a trade was checked against. */
  specHash: string;
  /** The hash before a change. Null for a pin and a refusal, and where the indexer never saw the pin. */
  fromHash: string | null;
  /** When a proposed loosening's hold ends, in milliseconds. Null on every other row. */
  holdEndsAt: number | null;
  /** A refusal's predicate, as the contract emitted it. Null on every other row. */
  predicate: string | null;
  /** The number the contract gave for that predicate, digit for digit. Null when the read could not carry it exactly. */
  decidingValue: string | null;
  /** `enforcing`: this is the change that set the hash in force now. `cooling_off`: this proposal is the one waiting. */
  mark: 'enforcing' | 'cooling_off' | null;
}

/** Where and when a row happened. A row without all four has no evidence to link to, so it is not drawn. */
function anchorOf(v: Record<string, unknown>): Pick<OnchainRow, 'at' | 'blockNumber' | 'logIndex' | 'txHash'> | null {
  if (!isCount(v.timestamp) || !isCount(v.blockNumber) || !isCount(v.logIndex) || !isHash(v.txHash)) return null;
  return { at: v.timestamp * 1000, blockNumber: v.blockNumber, logIndex: v.logIndex, txHash: v.txHash };
}

export interface OnchainRecordRead {
  events: OnchainRow[];
  refusals: OnchainRow[];
  /** How many rows each list came back with, before any was left out: what says a list was cut at its limit. */
  eventsSeen: number;
  refusalsSeen: number;
}

/**
 * The answer to `recordRequest`. A row missing what it cannot be drawn without
 * (its rule, its hash, its time, its transaction, and for a refusal its
 * predicate) is left out, not guessed at. A refusal whose number did not
 * arrive exactly keeps its row and loses the figure. A body that is not that
 * answer is null.
 */
export function readRecord(body: unknown): OnchainRecordRead | null {
  const data = dataOf(body);
  if (!data || !Array.isArray(data.StrategyEvent) || !Array.isArray(data.Refusal)) return null;

  const events: OnchainRow[] = [];
  for (const e of data.StrategyEvent) {
    if (!isRecord(e) || typeof e.id !== 'string' || typeof e.strategy_id !== 'string') continue;
    const kind = EVENT_KIND.get(e.kind);
    const anchor = anchorOf(e);
    if (!kind || !anchor || !isHash(e.newSpecHash)) continue;
    events.push({
      id: `event:${e.id}`,
      kind,
      strategyKey: e.strategy_id,
      ...anchor,
      specHash: e.newSpecHash,
      fromHash: kind === 'pinned' ? null : hashOrNull(e.oldSpecHash),
      holdEndsAt: kind === 'loosening_proposed' && isCount(e.cooldownEndsAt) ? e.cooldownEndsAt * 1000 : null,
      predicate: null,
      decidingValue: null,
      mark: null,
    });
  }

  const refusals: OnchainRow[] = [];
  for (const r of data.Refusal) {
    if (!isRecord(r) || typeof r.id !== 'string' || typeof r.strategy_id !== 'string') continue;
    const anchor = anchorOf(r);
    if (!anchor || !isHash(r.specHash) || typeof r.predicate !== 'string' || r.predicate.trim() === '') continue;
    refusals.push({
      id: `refusal:${r.id}`,
      kind: 'refused',
      strategyKey: r.strategy_id,
      ...anchor,
      specHash: r.specHash,
      fromHash: null,
      holdEndsAt: null,
      predicate: r.predicate.trim(),
      decidingValue: exactInteger(r.decidingValue),
      mark: null,
    });
  }

  return { events, refusals, eventsSeen: data.StrategyEvent.length, refusalsSeen: data.Refusal.length };
}

// --- The record -----------------------------------------------------------------

/** Newest first: by block time, then block, then position in the block. */
export function newestFirst(
  a: Pick<OnchainRow, 'at' | 'blockNumber' | 'logIndex'>,
  b: Pick<OnchainRow, 'at' | 'blockNumber' | 'logIndex'>,
): number {
  return b.at - a.at || b.blockNumber - a.blockNumber || b.logIndex - a.logIndex;
}

export interface OnchainRecord {
  rows: OnchainRow[];
  /** A list came back full, so older rows exist that this record does not show. */
  truncated: boolean;
}

/**
 * The two lists as one record, newest first.
 *
 * A list that came back at its limit was cut there, and what it holds past its
 * oldest row is unknown. Rows of the other list from before that point would
 * read as a whole stretch of history with half of it missing, so the record
 * stops at the newest such point and says it is cut.
 */
export function recordRows(
  strategies: readonly OnchainStrategy[],
  read: OnchainRecordRead,
  limit: number = ONCHAIN_ROW_LIMIT,
): OnchainRecord {
  const byKey = new Map(strategies.map((s) => [s.key, s]));
  // Only the rules that were asked about: anything else is not this wallet's.
  const mine = (rows: readonly OnchainRow[]) => rows.filter((r) => byKey.has(r.strategyKey)).sort(newestFirst);
  const events = mine(read.events);
  const refusals = mine(read.refusals);

  const eventsCut = read.eventsSeen >= limit;
  const refusalsCut = read.refusalsSeen >= limit;
  const cuts: OnchainRow[] = [];
  const oldestEvent = events[events.length - 1];
  const oldestRefusal = refusals[refusals.length - 1];
  if (eventsCut && oldestEvent) cuts.push(oldestEvent);
  if (refusalsCut && oldestRefusal) cuts.push(oldestRefusal);

  const rows = [...events, ...refusals]
    .sort(newestFirst)
    .filter((row) => cuts.every((cut) => newestFirst(row, cut) <= 0));

  // The change that set the hash in force now, and the proposal still waiting: one of each per rule.
  const marked = new Set<string>();
  const out = rows.map((row): OnchainRow => {
    const strategy = byKey.get(row.strategyKey);
    if (!strategy || row.kind === 'refused') return row;
    const want =
      row.kind === 'loosening_proposed'
        ? strategy.pendingSpecHash && row.specHash === strategy.pendingSpecHash
          ? 'cooling_off'
          : null
        : strategy.activeSpecHash && row.specHash === strategy.activeSpecHash
          ? 'enforcing'
          : null;
    if (!want || marked.has(`${row.strategyKey}:${want}`)) return row;
    marked.add(`${row.strategyKey}:${want}`);
    return { ...row, mark: want };
  });

  return { rows: out, truncated: eventsCut || refusalsCut };
}

// --- How a row reads ------------------------------------------------------------

/** The chain's own names for what happened, as its events spell them. */
export const ONCHAIN_KIND_WORD: Record<OnchainKind, string> = {
  pinned: 'Pinned',
  tightened: 'Tightened',
  loosening_proposed: 'Loosening proposed',
  loosening_finalized: 'Loosening finalized',
  refused: 'Refused',
};

/** A spec hash at the length the rule cards above the record show it, so the two can be matched by eye. */
export const shortSpecHash = (hash: string): string => abbreviateHash(hash, 6, 4);

/** The id the registry gave a row's rule: what is left of the indexer's id after the chain. */
export function registryIdOf(strategyKey: string): string {
  const cut = strategyKey.indexOf('_');
  return cut < 0 ? strategyKey : strategyKey.slice(cut + 1);
}

/** `2026-10-11 14:32 UTC`: a block's time, as the rule cards state a pin's. */
export const blockTimeLabel = (ms: number): string => `${stampLabel(ms)} UTC`;

/**
 * A predicate as the contract emitted it. The indexer decodes the symbol to
 * text; one that is not text comes through as its raw 32 bytes, shortened here.
 */
export function predicateLabel(predicate: string): string {
  return isHash(predicate) ? abbreviateHash(predicate, 6, 4) : predicate;
}

export interface DecidingReading {
  /** The number, digit for digit as emitted. Null when words say it better, or when there is none to show. */
  figure: string | null;
  /** The figure's unit, where the contract fixes one. */
  unit: string | null;
  /** A sentence in place of the figure. */
  words: string | null;
}

export const DECIDING_NOT_EXACT = 'The number did not arrive exactly. It is in the transaction.';

/**
 * What a refusal's number is, by the predicate that produced it. The contracts
 * say what each means (`RefusalGate.sol`, `PredicateEngine.sol`): a close for a
 * break of structure, a gap in basis points for a fair value gap, a wick for a
 * sweep, and for the two refusals that are not a predicate's, the rule's side
 * or nothing. A price is the series' own integer and the refusal carries no
 * exponent for it, so it is shown as emitted and never as a formatted price.
 */
export function decidingReading(predicate: string, value: string | null): DecidingReading {
  if (predicate === 'SIDE_MISMATCH' && (value === '1' || value === '0')) {
    return { figure: null, unit: null, words: value === '1' ? 'The rule takes longs only.' : 'The rule takes shorts only.' };
  }
  if (predicate === 'RETIRED') return { figure: null, unit: null, words: 'The rule is retired.' };
  if (value === null) return { figure: null, unit: null, words: DECIDING_NOT_EXACT };
  return { figure: value, unit: /^fvg(_|$)/.test(predicate) ? 'bps' : null, words: null };
}

/** A row's transaction on the configured chain's explorer. */
export function recordTx(explorer: { name: string; url: string }, txHash: string): TxRef {
  return {
    hash: txHash,
    short: abbreviateHash(txHash, 6, 4),
    url: explorerUrl(explorer.url, 'tx', encodeURIComponent(txHash)),
    explorer: explorer.name,
  };
}

/** One row said in a sentence, for a screen reader: what, which predicate, when, and where the evidence is. */
export function rowSummary(row: OnchainRow, tx: TxRef): string {
  const what =
    row.kind === 'refused' && row.predicate
      ? `${ONCHAIN_KIND_WORD.refused}, ${predicateLabel(row.predicate)}`
      : ONCHAIN_KIND_WORD[row.kind];
  return `${what}, ${blockTimeLabel(row.at)}, transaction ${tx.short} on ${tx.explorer}`;
}
