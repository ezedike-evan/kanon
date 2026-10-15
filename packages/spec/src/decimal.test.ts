import { describe, expect, it } from 'vitest';
import { compareDecimal, dec, type Decimal } from './decimal';

/** The comparison as integers, the slow and obvious way: what the fast path must always agree with. */
function byIntegers(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const decimals = Math.max(a.decimals, b.decimals);
  const x = BigInt(a.atoms) * 10n ** BigInt(decimals - a.decimals);
  const y = BigInt(b.atoms) * 10n ** BigInt(decimals - b.decimals);
  return x < y ? -1 : x > y ? 1 : 0;
}

describe('compareDecimal', () => {
  const cases: Array<[Decimal, Decimal]> = [
    [dec('6844120', 2), dec('6844120', 2)],
    [dec('6844120', 2), dec('6844121', 2)],
    [dec('999', 2), dec('1000', 2)],
    [dec('10000', 2), dec('9999', 2)],
    [dec('0', 2), dec('0', 2)],
    [dec('0', 2), dec('1', 2)],
    [dec('91', 2), dec('100', 2)],
    // Not canonical: a leading zero, a sign, or two scales. These take the integer path.
    [dec('007', 2), dec('7', 2)],
    [dec('0100', 2), dec('99', 2)],
    [dec('-5', 2), dec('3', 2)],
    [dec('-5', 2), dec('-50', 2)],
    [dec('105', 0), dec('10500', 2)],
    [dec('1051', 1), dec('10500', 2)],
  ];

  it('agrees with the integer comparison, both ways round', () => {
    for (const [a, b] of cases) {
      expect(compareDecimal(a, b), `${a.atoms}e-${a.decimals} vs ${b.atoms}e-${b.decimals}`).toBe(byIntegers(a, b));
      expect(compareDecimal(b, a), `${b.atoms}e-${b.decimals} vs ${a.atoms}e-${a.decimals}`).toBe(byIntegers(b, a));
    }
  });

  it('agrees with it across a seeded spread of same-scale prices', () => {
    let s = 11;
    const next = () => {
      s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
      return s;
    };
    for (let i = 0; i < 2_000; i++) {
      const a = dec(String(next() % 10_000_000), 2);
      const b = dec(String(next() % 10_000_000), 2);
      expect(compareDecimal(a, b)).toBe(byIntegers(a, b));
    }
  });
});
