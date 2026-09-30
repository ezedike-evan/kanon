import { describe, expect, it } from 'vitest';
import { fromScaled, toScaledNumber } from './scaling';

describe('safe-integer boundaries', () => {
  it('toScaledNumber accepts 2^53-1 and refuses 2^53', () => {
    expect(toScaledNumber({ atoms: '9007199254740991', decimals: 0 }, 0)).toBe(9007199254740991);
    expect(() => toScaledNumber({ atoms: '9007199254740992', decimals: 0 }, 0)).toThrow(RangeError);
  });

  it('toScaledNumber refuses a value that scaling pushes past the limit', () => {
    expect(() => toScaledNumber({ atoms: '9007199254740993', decimals: 2 }, 2)).toThrow(RangeError);
  });

  it('toScaledNumber refuses negatives', () => {
    expect(() => toScaledNumber({ atoms: '-1', decimals: 0 }, 0)).toThrow(RangeError);
  });

  it('fromScaled refuses an unsafe or non-integer number', () => {
    expect(() => fromScaled(2 ** 53, 2)).toThrow(RangeError);
    expect(() => fromScaled(1.5, 2)).toThrow(RangeError);
    expect(() => fromScaled(NaN, 2)).toThrow(RangeError);
  });

  it('fromScaled keeps a bigint or string exact at any size', () => {
    expect(fromScaled(123456789012345678901234567890n, 6).atoms).toBe('123456789012345678901234567890');
    expect(fromScaled('9007199254740993', 0).atoms).toBe('9007199254740993');
    expect(fromScaled(Number.MAX_SAFE_INTEGER, 0).atoms).toBe('9007199254740991');
  });
});
