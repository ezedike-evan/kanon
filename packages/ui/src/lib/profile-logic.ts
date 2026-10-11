/**
 * The pure half of the Profile tab: filtering, grouping and labelling. No
 * React, no clock (callers pass `now`), no I/O, so every rule here is pinned
 * down in `profile-logic.test.ts`. Nothing invents a figure: a stake whose
 * amount is not known is `null`, not zero.
 */

import { abbreviateHash, formatDecimal, type Decimal } from '@kanon/spec';
import type { ActivityItem, RuleHistoryItem } from './domain-types';
import type { PredictMarket } from './predict-types';
import type { TimedTrade } from './timed-types';
import type { ChartTrade } from './trade-records';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type RecordFilter = 'all' | 'chart' | 'predictions' | 'executed' | 'refused';

/**
 * A person trades three ways and the record holds all three: by hand from the
 * chart's ticket, on a timer from Predict, and through a pinned rule, which
 * either executes a setup or refuses it.
 */
export const RECORD_FILTERS: ReadonlyArray<{ value: RecordFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'chart', label: 'Chart' },
  { value: 'predictions', label: 'Predict' },
  { value: 'executed', label: 'By rule' },
  { value: 'refused', label: 'Refused' },
];

/** A stake the person took on a threshold market. */
export interface StakeRecord {
  id: string;
  marketId: string;
  asset: string;
  /** What the market asks: does the price reach a level above or below where it was. */
  direction: 'above' | 'below';
  target: Decimal;
  /** The side the person took. */
  side: 'above' | 'below';
  /** Null when the amount is not known: never drawn as zero. */
  stake: Decimal | null;
  result: 'won' | 'lost' | 'refunded' | null;
  /** The window length: `1H`, `4H`, `1D`. */
  window: string;
  /** Milliseconds: when the market's window began. A stake has no timestamp of its own. */
  at: number;
}

export type LedgerRecord =
  /** A setup put to the person's rule: executed, refused, proposed or undone. */
  | { type: 'trade'; id: string; at: number; item: ActivityItem }
  /** A stake on a threshold market, from before Predict became timed trades. */
  | { type: 'stake'; id: string; at: number; stake: StakeRecord }
  /** A position taken by hand from the chart's ticket. */
  | { type: 'chart'; id: string; at: number; trade: ChartTrade }
  /** A timed trade from Predict. */
  | { type: 'timed'; id: string; at: number; trade: TimedTrade };

export function tradeRecords(items: readonly ActivityItem[]): LedgerRecord[] {
  return items.map((item) => ({ type: 'trade' as const, id: item.id, at: item.at, item }));
}

/** Chart trades as records, dated by when each was opened. */
export function chartRecords(trades: readonly ChartTrade[]): LedgerRecord[] {
  return trades.map((trade) => ({ type: 'chart' as const, id: `chart:${trade.id}`, at: trade.openedAt, trade }));
}

/** Timed trades as records, dated by when each was opened, so a row does not move when its trade ends. */
export function timedRecords(trades: readonly TimedTrade[]): LedgerRecord[] {
  return trades.map((trade) => ({ type: 'timed' as const, id: `timed:${trade.id}`, at: trade.openedAt, trade }));
}

/** The person's own stakes across the markets they appear in. A fixture market is not a stake. */
export function stakeRecords(markets: readonly PredictMarket[]): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const m of markets) {
    if (m.demo) continue;
    m.positions.forEach((p, i) => {
      const stake: StakeRecord = {
        id: `${m.id}:${p.side}:${i}`,
        marketId: m.id,
        asset: m.asset,
        direction: m.direction,
        target: m.target,
        side: p.side,
        stake: p.stake,
        result: p.result,
        window: m.timeframe,
        at: m.windowStart * 1000,
      };
      out.push({ type: 'stake', id: stake.id, at: stake.at, stake });
    });
  }
  return out;
}

/** Newest first. A stable sort: equal times keep the order they arrived in. */
export function mergeRecords(...lists: ReadonlyArray<readonly LedgerRecord[]>): LedgerRecord[] {
  return lists
    .flat()
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.at - a.r.at || a.i - b.i)
    .map(({ r }) => r);
}

export function matchesFilter(record: LedgerRecord, filter: RecordFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'chart':
      return record.type === 'chart';
    case 'predictions':
      return record.type === 'timed' || record.type === 'stake';
    case 'executed':
      return record.type === 'trade' && record.item.kind === 'executed';
    case 'refused':
      return record.type === 'trade' && record.item.kind === 'refused';
  }
}

export function filterRecords(records: readonly LedgerRecord[], filter: RecordFilter): LedgerRecord[] {
  return filter === 'all' ? [...records] : records.filter((r) => matchesFilter(r, filter));
}

/** One count per filter, so a chip's count is the number of rows it shows. */
export type RecordTotals = Record<RecordFilter, number>;

export function recordTotals(records: readonly LedgerRecord[]): RecordTotals {
  const totals: RecordTotals = { all: records.length, chart: 0, predictions: 0, executed: 0, refused: 0 };
  for (const r of records) {
    if (r.type === 'chart') totals.chart += 1;
    else if (r.type === 'timed' || r.type === 'stake') totals.predictions += 1;
    else if (r.item.kind === 'executed') totals.executed += 1;
    else if (r.item.kind === 'refused') totals.refused += 1;
  }
  return totals;
}

/** UTC day, `2026-09-02`. The app states times in UTC everywhere a stamp is shown. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Today`, `Yesterday`, or `02 Sep 2026`. */
export function dayLabel(key: string, nowMs: number): string {
  if (key === dayKey(nowMs)) return 'Today';
  if (key === dayKey(nowMs - 86_400_000)) return 'Yesterday';
  const [y = '', m = '1', d = ''] = key.split('-');
  return `${d} ${MONTHS[Number(m) - 1] ?? ''} ${y}`;
}

/** `14:32`, UTC. */
export function timeLabel(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/**
 * A table's day cell: `Today`, `Yesterday`, `02 Sep`, or `02 Sep 2025` once it is not
 * this year. The year is dropped where it says nothing, so the column stays narrow.
 */
export function tableDayLabel(ms: number, nowMs: number): string {
  const label = dayLabel(dayKey(ms), nowMs);
  const year = String(new Date(nowMs).getUTCFullYear());
  return label.endsWith(` ${year}`) ? label.slice(0, -5) : label;
}

export interface DayHeader {
  type: 'day';
  id: string;
  label: string;
  count: number;
}

export type ListEntry = DayHeader | LedgerRecord;

/** Records (newest first) with a header before each UTC day. Flat, so a list can virtualise it. */
export function withDayHeaders(records: readonly LedgerRecord[], nowMs: number): ListEntry[] {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(dayKey(r.at), (counts.get(dayKey(r.at)) ?? 0) + 1);
  const out: ListEntry[] = [];
  let current = '';
  for (const r of records) {
    const key = dayKey(r.at);
    if (key !== current) {
      current = key;
      out.push({ type: 'day', id: `day:${key}`, label: dayLabel(key, nowMs), count: counts.get(key) ?? 0 });
    }
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type RuleState = 'pinned' | 'cooling_off' | 'superseded' | 'draft';

/**
 * What a rule is now. The store keeps three statuses; a `pinned` rule that is
 * no longer the one enforcing has been replaced by a newer one.
 */
export function ruleState(rule: Pick<RuleHistoryItem, 'status' | 'active'>): RuleState {
  if (rule.status === 'draft') return 'draft';
  if (!rule.active) return 'superseded';
  return rule.status === 'cooling_off' ? 'cooling_off' : 'pinned';
}

const STATE_ORDER: Record<RuleState, number> = { cooling_off: 0, pinned: 1, draft: 2, superseded: 3 };

/** The rule enforcing now first, then drafts, then the ones it replaced. Newest first within each. */
export function orderRules<T extends Pick<RuleHistoryItem, 'status' | 'active'>>(rules: readonly T[]): T[] {
  return rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => STATE_ORDER[ruleState(a.r)] - STATE_ORDER[ruleState(b.r)] || a.i - b.i)
    .map(({ r }) => r);
}

/** `RULE 04`: position among the person's rules, oldest first. `rules` is newest first. */
export function ruleOrdinals(rules: readonly { id: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  rules.forEach((r, i) => map.set(r.id, `RULE ${String(rules.length - i).padStart(2, '0')}`));
  return map;
}

export interface RuleSection {
  type: 'section';
  id: string;
  label: string;
  count: number;
}
export interface RuleEntry<T> {
  type: 'rule';
  id: string;
  rule: T;
  state: RuleState;
}

const SECTION_OF: Record<RuleState, { key: string; label: string }> = {
  cooling_off: { key: 'now', label: 'Enforcing now' },
  pinned: { key: 'now', label: 'Enforcing now' },
  draft: { key: 'draft', label: 'Drafts' },
  superseded: { key: 'replaced', label: 'Replaced by a newer rule' },
};

/** Rules with a header before each group, flat so a list can virtualise it. */
export function ruleSections<T extends Pick<RuleHistoryItem, 'id' | 'status' | 'active'>>(
  rules: readonly T[],
): Array<RuleSection | RuleEntry<T>> {
  const ordered = orderRules(rules);
  const counts = new Map<string, number>();
  for (const r of ordered) {
    const key = SECTION_OF[ruleState(r)].key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: Array<RuleSection | RuleEntry<T>> = [];
  let current = '';
  for (const rule of ordered) {
    const state = ruleState(rule);
    const { key, label } = SECTION_OF[state];
    if (key !== current) {
      current = key;
      out.push({ type: 'section', id: `section:${key}`, label, count: counts.get(key) ?? 0 });
    }
    out.push({ type: 'rule', id: rule.id, rule, state });
  }
  return out;
}

/** `2026-09-02 14:32`, UTC. */
export function stampLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** The number of rules that were ever pinned: everything but a draft. */
export function pinnedCount(rules: readonly Pick<RuleHistoryItem, 'status'>[]): number {
  return rules.filter((r) => r.status !== 'draft').length;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** `0x1234…abcd`. Case is kept: a checksummed address stays checksummed. */
export function shortAddress(address: string): string {
  return abbreviateHash(address, 4, 4);
}

/** `@ada`, from a stored handle that may or may not carry the `@`. */
export function handleOf(username: string): string {
  const bare = username.trim().replace(/^@+/, '');
  return bare ? `@${bare}` : '';
}

/** `Sep 2026`, UTC. */
export function memberSince(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

/** `1800` bps of a vault as `18%`; a whole percent has no decimals. */
export function allocationLabel(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

const LOGIN_LABELS: Record<string, string> = {
  email: 'Email',
  phone: 'Phone',
  google_oauth: 'Google',
  twitter_oauth: 'X',
  apple_oauth: 'Apple',
  discord_oauth: 'Discord',
  github_oauth: 'GitHub',
  farcaster: 'Farcaster',
  passkey: 'Passkey',
  wallet: 'External wallet',
};

export function loginLabel(type: string): string {
  return LOGIN_LABELS[type] ?? type.replace(/_oauth$/, '').replace(/_/g, ' ');
}

/** The explorer page for an address or a transaction. */
export function explorerUrl(base: string, kind: 'address' | 'tx', value: string): string {
  return `${base.replace(/\/+$/, '')}/${kind}/${value}`;
}

/** `1,234.50` for a price; a size loses its trailing zeros (`0.05000000` is `0.05`). */
export function compactDecimal(d: Decimal): string {
  const text = formatDecimal(d);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** A price to its own precision, grouped. */
export function priceLabel(d: Decimal): string {
  return formatDecimal(d);
}

/** A long id shortened to fit a line: `k7d2x9` stays, `jh72x…a9f3` is cut. */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
