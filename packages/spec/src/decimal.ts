/**
 * Fixed-point money. Prices and sizes are integers with explicit decimals,
 * never floats — the contract does integer arithmetic and the UI must agree
 * with it exactly, including at the last digit.
 */

import { z } from 'zod';

export const Decimal = z.object({
  /** The integer value, base-10, as a string. May be negative. */
  atoms: z.string().regex(/^-?\d+$/, 'atoms must be a base-10 integer string'),
  /** How many of those digits sit after the point. */
  decimals: z.number().int().min(0).max(18),
});
export type Decimal = z.infer<typeof Decimal>;

export function dec(atoms: bigint | string, decimals: number): Decimal {
  return { atoms: atoms.toString(), decimals };
}

/** Parses a human figure ("68,412.50") into atoms at the given scale. */
export function parseDecimal(input: string, decimals: number): Decimal {
  const clean = input.replace(/[,\s_]/g, '');
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!m) throw new Error(`not a number: ${input}`);
  const [, sign = '', whole = '', frac = ''] = m;
  if (frac.length > decimals) {
    throw new Error(`${input} has more precision than ${decimals} decimals`);
  }
  const atoms = `${whole || '0'}${frac.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  return { atoms: `${sign}${atoms}`, decimals };
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const decimals = Math.max(a.decimals, b.decimals);
  const scale = (d: Decimal) => BigInt(d.atoms) * 10n ** BigInt(decimals - d.decimals);
  return [scale(a), scale(b), decimals];
}

/** -1, 0 or 1. Scale-independent. */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function subDecimal(a: Decimal, b: Decimal): Decimal {
  const [x, y, decimals] = align(a, b);
  return { atoms: (x - y).toString(), decimals };
}

/**
 * Renders with grouped thousands and every decimal place kept — a price that
 * drops its trailing zero stops lining up with the one above it.
 */
export function formatDecimal(
  d: Decimal,
  opts: { group?: boolean; signed?: boolean } = {},
): string {
  const { group = true, signed = false } = opts;
  const negative = d.atoms.startsWith('-');
  const digits = (negative ? d.atoms.slice(1) : d.atoms).padStart(d.decimals + 1, '0');
  const cut = digits.length - d.decimals;
  let whole = digits.slice(0, cut);
  const frac = digits.slice(cut);
  if (group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = d.decimals > 0 ? `${whole}.${frac}` : whole;
  // U+2212 minus, not a hyphen: it is the same width as the digits beside it.
  if (negative) return `−${body}`;
  return signed ? `+${body}` : body;
}

/** Basis points. 1 bp = 0.01%. Percentages are integers too. */
export function formatBps(
  bps: number,
  opts: { signed?: boolean; dp?: number } = {},
): string {
  const { signed = false, dp = 2 } = opts;
  const negative = bps < 0;
  const body = `${(Math.abs(bps) / 100).toFixed(dp)}%`;
  if (negative) return `\u2212${body}`;
  return signed ? `+${body}` : body;
}
