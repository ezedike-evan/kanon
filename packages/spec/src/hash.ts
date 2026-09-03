/**
 * The spec hash pinned on-chain.
 *
 * Canonical serialisation first — object key order must not change the hash,
 * or the same rule pins to two different commitments.
 */

import type { StrategySpec } from './spec';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function canonicalizeSpec(spec: StrategySpec): string {
  return canonical(spec);
}

/** sha-256 over the canonical form, as `0x…`. */
export async function specHash(spec: StrategySpec): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeSpec(spec));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `0x${hex}`;
}

/** `0x7f3c…c31a` — the form the UI shows when the full hash will not fit. */
export function abbreviateHash(hash: string, head = 4, tail = 4): string {
  const body = hash.startsWith('0x') ? hash.slice(2) : hash;
  if (body.length <= head + tail) return `0x${body}`;
  return `0x${body.slice(0, head)}…${body.slice(-tail)}`;
}
