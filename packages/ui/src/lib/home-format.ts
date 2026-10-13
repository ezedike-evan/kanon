import { formatDecimal, type Decimal } from '@kanon/spec';
import type { ActivityItem } from './domain-types';
import { baseOf } from './chart-assets';

export { baseOf };

/**
 * Words and short forms Home writes, pure so each is pinned down in
 * `home-format.test.ts`. Nothing here reads a clock or a float price: a caller
 * hands in the time, and every price and size stays integer atoms until it is
 * printed.
 */

/** `0x9fE2…41Ab`. An address is identified by its ends; the middle is what a reader skips. */
export function shortAddress(address: string): string {
  const a = address.trim();
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * What Home's header chip says, and where it leads.
 *
 * Signed in it states the wallet: a short address, `Wallet ready` when a signer
 * exists and its address is not known yet, `No wallet` when there is none. It
 * opens Profile, where the account is managed. Signed out there is no wallet to
 * report on, and "Not connected" read as one that had failed: the chip is the
 * way to sign in, and says so. `null` while auth is still resolving, so nothing
 * is said that has to be taken back.
 */
export interface WalletChip {
  label: string;
  /** `signin` leads to the front door, `profile` to the account. */
  to: 'signin' | 'profile';
  /** A wallet exists and can sign: the chip carries the lit dot. */
  connected: boolean;
  accessibilityLabel: string;
}

export function walletChip(input: {
  pending: boolean;
  signedIn: boolean;
  hasWallet: boolean;
  address: string | null;
}): WalletChip | null {
  if (input.pending) return null;
  if (!input.signedIn) return { label: 'Sign in', to: 'signin', connected: false, accessibilityLabel: 'Sign in' };
  if (!input.hasWallet) {
    return { label: 'No wallet', to: 'profile', connected: false, accessibilityLabel: 'No wallet yet. Open profile.' };
  }
  return {
    label: input.address ? shortAddress(input.address) : 'Wallet ready',
    to: 'profile',
    connected: true,
    accessibilityLabel: `Wallet ${input.address ?? 'connected'}. Open profile.`,
  };
}

/** The name a greeting uses: the first word of the name, else the handle, else nothing. */
export function greetingName(settings: { name: string; username: string } | null): string | null {
  if (!settings) return null;
  const first = settings.name.trim().split(/\s+/)[0] ?? '';
  if (first) return first;
  const handle = settings.username.trim().replace(/^@/, '');
  return handle || null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `Sep 02`, in UTC so a row reads the same in every timezone. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * How long ago, in the fewest characters that stay exact: `now`, `5m`, `3h`, `2d`,
 * then the date once it is a week or more. A time in the future (the clock and a
 * server disagree) reads `now` rather than a negative age. With no clock yet
 * (`nowMs` 0, the server render) it is the date, so hydration has nothing to
 * disagree about.
 */
export function relativeTime(atMs: number, nowMs: number): string {
  if (nowMs <= 0) return shortDate(atMs);
  const seconds = Math.floor((nowMs - atMs) / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return shortDate(atMs);
}

/**
 * A size without the zeros the atoms are padded with: `0.05000000` is `0.05`.
 * At least two decimals stay, so a size lines up with the one above it.
 */
export function formatSize(size: Decimal): string {
  const full = formatDecimal(size);
  if (size.decimals <= 2) return full;
  const [whole = full, frac = ''] = full.split('.');
  const trimmed = frac.replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${trimmed}`;
}

export interface ActivityCopy {
  /** `BTC/USD · Long`. */
  title: string;
  /** One plain line. A refusal names the predicate that held the trade and is never worded as a fault. */
  sub: string;
  badge: string;
}

/**
 * The words for an activity row. A refusal is the rule doing its job: it says
 * which predicate held the trade and stops there. No "failed", no "error".
 *
 * A row autopilot wrote says so, and is worded for what happened to it: nobody
 * was waited on, nobody undid anything, and the entry and size on the row are
 * the rule's own sizing of the setup, so neither is stated as a fill.
 */
export function activityCopy(item: ActivityItem): ActivityCopy {
  const side = item.direction === 'long' ? 'Long' : 'Short';
  const title = `${item.asset} · ${side}`;
  if (item.origin === 'autopilot') {
    switch (item.kind) {
      case 'executed':
        return { title, badge: 'Opened', sub: 'By autopilot · a timed trade was opened for it' };
      case 'refused':
        return {
          title,
          badge: 'Refused',
          sub: item.refusedBy ? `By autopilot · your rule held this entry: ${item.refusedBy}` : 'By autopilot · your rule held this entry',
        };
      case 'proposed':
        return { title, badge: 'Waiting', sub: 'By autopilot · waiting for the gateway to open it' };
      case 'undone':
        return { title, badge: 'Not opened', sub: 'By autopilot · not opened. The reason is with its evidence' };
    }
  }
  switch (item.kind) {
    case 'executed':
      return { title, badge: 'Executed', sub: `Entered at ${formatDecimal(item.entry)} · ${formatSize(item.size)} ${baseOf(item.asset)}` };
    case 'refused':
      return {
        title,
        badge: 'Refused',
        sub: item.refusedBy ? `Your rule held this entry: ${item.refusedBy}` : 'Your rule held this entry',
      };
    case 'proposed':
      return { title, badge: 'Proposed', sub: `At ${formatDecimal(item.entry)} · waiting on you` };
    case 'undone':
      return { title, badge: 'Undone', sub: `You undid it inside the window · ${formatDecimal(item.entry)}` };
  }
}

const DAY_MS = 86_400_000;
const utcDay = (ms: number) => Math.floor(ms / DAY_MS);

/**
 * The heading a day of activity sits under: `Today`, `Yesterday`, then the UTC
 * date. With no clock yet (`nowMs` 0) it is always the date, for the same reason
 * as `relativeTime`.
 */
export function dayLabel(atMs: number, nowMs: number): string {
  if (nowMs <= 0) return shortDate(atMs);
  const age = utcDay(nowMs) - utcDay(atMs);
  if (age <= 0) return 'Today';
  if (age === 1) return 'Yesterday';
  return shortDate(atMs);
}

export interface DayGroup<T> {
  label: string;
  items: T[];
}

/**
 * Consecutive items that fall on the same UTC day, under one label. Input order
 * is kept (newest first stays newest first): this only draws the day lines.
 */
export function groupByDay<T extends { at: number }>(items: readonly T[], nowMs: number): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  let lastDay: number | null = null;
  for (const item of items) {
    const day = utcDay(item.at);
    if (day !== lastDay) {
      groups.push({ label: dayLabel(item.at, nowMs), items: [] });
      lastDay = day;
    }
    groups[groups.length - 1]!.items.push(item);
  }
  return groups;
}
