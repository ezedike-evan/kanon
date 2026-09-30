/**
 * Exact integer scaling between Kanon `Decimal`s and venue wire integers.
 *
 * Venues quote price and size as integers at a per-market decimal count
 * (Perpl: `price_decimals` / `size_decimals` from `GET /v1/pub/context`;
 * Kuru: log10 of `pricePrecision` / `sizePrecision`). Converting between
 * scales is where silent rounding creeps in, so every conversion here names
 * its rounding mode. `exact` refuses to drop a non-zero digit.
 *
 * BigInt only. No `number` is ever produced from a price or a size except at
 * the venue boundary, and only when the venue's own wire format is a JSON
 * number (Perpl's `p` / `s`).
 */

import type { Decimal } from '@kanon/spec';

/** `exact` throws on precision loss. `floor` / `ceil` round toward -inf / +inf. */
export type RoundingMode = 'exact' | 'floor' | 'ceil';

export class PrecisionLossError extends Error {
  constructor(value: Decimal, targetDecimals: number) {
    super(`${value.atoms}e-${value.decimals} cannot be represented exactly at ${targetDecimals} decimals`);
    this.name = 'PrecisionLossError';
  }
}

/** The integer `value` becomes when rescaled to `targetDecimals`. */
export function toScaledBigInt(value: Decimal, targetDecimals: number, mode: RoundingMode = 'exact'): bigint {
  const atoms = BigInt(value.atoms);
  if (targetDecimals >= value.decimals) return atoms * 10n ** BigInt(targetDecimals - value.decimals);
  const divisor = 10n ** BigInt(value.decimals - targetDecimals);
  const quotient = atoms / divisor; // truncates toward zero
  const remainder = atoms % divisor;
  if (remainder === 0n) return quotient;
  if (mode === 'exact') throw new PrecisionLossError(value, targetDecimals);
  // Adjust the truncated quotient to a true floor / ceil (matters only for negatives).
  if (mode === 'floor') return atoms < 0n ? quotient - 1n : quotient;
  return atoms > 0n ? quotient + 1n : quotient;
}

/** `toScaledBigInt`, as a JSON number for venues whose wire format is one.
 * Throws rather than silently losing integer precision above 2^53. */
export function toScaledNumber(value: Decimal, targetDecimals: number, mode: RoundingMode = 'exact'): number {
  const scaled = toScaledBigInt(value, targetDecimals, mode);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER) || scaled < 0n) {
    throw new RangeError(`scaled value ${scaled} does not fit a safe JSON integer`);
  }
  const n = Number(scaled);
  if (!Number.isSafeInteger(n)) throw new RangeError(`scaled value ${scaled} does not fit a safe JSON integer`);
  return n;
}

/**
 * A venue wire integer as a `Decimal`. A `number` must already be a safe
 * integer: a float, NaN, or an integer past 2^53 has lost digits before it got
 * here, so it is refused rather than turned into a plausible-looking price.
 */
export function fromScaled(scaled: bigint | number | string, decimals: number): Decimal {
  if (typeof scaled === 'number' && !Number.isSafeInteger(scaled)) {
    throw new RangeError(`wire value ${scaled} is not a safe integer`);
  }
  return { atoms: BigInt(scaled).toString(), decimals };
}

/** A plain base-10 string ("68412.50") with no grouping and no exponent, for
 * SDKs that take human-readable strings. Every decimal place is kept. */
export function toPlainString(value: Decimal): string {
  const negative = value.atoms.startsWith('-');
  const digits = (negative ? value.atoms.slice(1) : value.atoms).padStart(value.decimals + 1, '0');
  const cut = digits.length - value.decimals;
  const body = value.decimals > 0 ? `${digits.slice(0, cut)}.${digits.slice(cut)}` : digits;
  return negative ? `-${body}` : body;
}

/** `value` multiplied by an integer basis-point factor, rounded per `mode`. */
export function mulBps(value: Decimal, bps: number, mode: 'floor' | 'ceil' = 'floor'): Decimal {
  const num = BigInt(value.atoms) * BigInt(bps);
  const den = 10_000n;
  let q = num / den;
  if (num % den !== 0n) {
    if (mode === 'floor' && num < 0n) q -= 1n;
    if (mode === 'ceil' && num > 0n) q += 1n;
  }
  return { atoms: q.toString(), decimals: value.decimals };
}

export function isPositive(value: Decimal): boolean {
  return BigInt(value.atoms) > 0n;
}
