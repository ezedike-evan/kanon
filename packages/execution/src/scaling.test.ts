import { describe, expect, it } from 'vitest';
import { dec } from '@kanon/spec';
import { PrecisionLossError, fromScaled, mulBps, toPlainString, toScaledBigInt, toScaledNumber } from './scaling';

describe('scaling', () => {
  it('widens exactly', () => {
    expect(toScaledBigInt(dec(6841250n, 2), 5)).toBe(6841250000n);
  });

  it('exact mode refuses to drop a non-zero digit', () => {
    expect(() => toScaledBigInt(dec(6841255n, 2), 1)).toThrow(PrecisionLossError);
    expect(toScaledBigInt(dec(6841250n, 2), 1)).toBe(684125n);
  });

  it('floor and ceil round to the named side', () => {
    expect(toScaledBigInt(dec(6841255n, 2), 1, 'floor')).toBe(684125n);
    expect(toScaledBigInt(dec(6841255n, 2), 1, 'ceil')).toBe(684126n);
    expect(toScaledBigInt(dec(-6841255n, 2), 1, 'floor')).toBe(-684126n);
    expect(toScaledBigInt(dec(-6841255n, 2), 1, 'ceil')).toBe(-684125n);
  });

  it('refuses a JSON number that would lose integer precision', () => {
    expect(() => toScaledNumber(dec(10n ** 20n, 0), 0)).toThrow(RangeError);
    expect(toScaledNumber(dec(123n, 0), 2)).toBe(12300);
  });

  it('renders plain strings with every decimal kept', () => {
    expect(toPlainString(dec(6841250n, 2))).toBe('68412.50');
    expect(toPlainString(dec(5n, 4))).toBe('0.0005');
    expect(toPlainString(dec(-5n, 1))).toBe('-0.5');
    expect(toPlainString(dec(42n, 0))).toBe('42');
  });

  it('fromScaled round-trips', () => {
    expect(fromScaled(950000, 1)).toEqual({ atoms: '950000', decimals: 1 });
  });

  it('mulBps floors and ceils', () => {
    expect(mulBps(dec(1001n, 0), 5000, 'floor').atoms).toBe('500');
    expect(mulBps(dec(1001n, 0), 5000, 'ceil').atoms).toBe('501');
  });
});
