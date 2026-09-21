import { describe, expect, it } from 'vitest';
import {
  allocateLeaderTrade,
  distributeExact,
  mirrorPnl,
  mirrorRemainder,
  mirrorSize,
  previewFollow,
  proportionalAllocationBps,
  splitProfit,
  validateCopyTerms,
} from './copy';

describe('validateCopyTerms', () => {
  it('mirrors the constructor', () => {
    expect(validateCopyTerms({ allocationBps: 2500, feeShareBps: 1000 })).toEqual([]);
    expect(validateCopyTerms({ allocationBps: 0, feeShareBps: 0 }).map((i) => i.field)).toEqual(['allocationBps']);
    expect(validateCopyTerms({ allocationBps: 10_001, feeShareBps: 0 })).toHaveLength(1);
    expect(validateCopyTerms({ allocationBps: 10_000, feeShareBps: 10_000 })).toEqual([]);
    expect(validateCopyTerms({ allocationBps: 100, feeShareBps: -1 })).toHaveLength(1);
    expect(validateCopyTerms({ allocationBps: 100, feeShareBps: 0.5 })).toHaveLength(1);
  });
});

describe('mirrorSize', () => {
  it('is proportional to the leader size, rounded down', () => {
    expect(mirrorSize(1_000_000n, 2500)).toBe(250_000n);
    expect(mirrorSize(1_000_000n, 10_000)).toBe(1_000_000n);
    expect(mirrorSize(3n, 3333)).toBe(0n); // 0.9999 rounds down, never up
    expect(mirrorSize(10_001n, 1)).toBe(1n);
  });

  it('never exceeds the leader and reports exactly what the floor dropped', () => {
    for (const size of [1n, 7n, 999n, 1_234_567n, 10n ** 18n + 3n]) {
      for (const bps of [1, 3333, 5000, 9999, 10_000]) {
        const s = mirrorSize(size, bps);
        const r = mirrorRemainder(size, bps);
        expect(s <= size).toBe(true);
        expect(r >= 0n && r < 10_000n).toBe(true);
        expect(s * 10_000n + r).toBe(size * BigInt(bps));
      }
    }
  });

  it('scales linearly: doubling the leader at most doubles the follower, within one atom', () => {
    const a = mirrorSize(123_457n, 3333);
    const b = mirrorSize(246_914n, 3333);
    expect(b - 2n * a).toBeGreaterThanOrEqual(0n);
    expect(b - 2n * a).toBeLessThanOrEqual(1n);
  });
});

describe('proportionalAllocationBps', () => {
  it('is follower capital over leader capital, in bps, rounded down', () => {
    expect(proportionalAllocationBps(1_000n, 10_000n)).toBe(1000);
    expect(proportionalAllocationBps(1n, 3n)).toBe(3333);
  });
  it('clamps to 1..10_000 and never levers a bigger follower', () => {
    expect(proportionalAllocationBps(50_000n, 10_000n)).toBe(10_000);
    expect(proportionalAllocationBps(1n, 1_000_000n)).toBe(1);
    expect(proportionalAllocationBps(0n, 10n)).toBe(1);
    expect(proportionalAllocationBps(10n, 0n)).toBe(1);
  });
});

describe('mirrorPnl (parity with CopyVault.mirrorClose)', () => {
  const entry = 100_000_000n;
  it('a long gains when price rises', () => {
    expect(mirrorPnl({ followerSize: 1_000_000n, entryPrice: entry, exitPrice: 110_000_000n, isLong: true })).toBe(100_000n);
  });
  it('a short is the mirror image', () => {
    expect(mirrorPnl({ followerSize: 1_000_000n, entryPrice: entry, exitPrice: 110_000_000n, isLong: false })).toBe(-100_000n);
    expect(mirrorPnl({ followerSize: 1_000_000n, entryPrice: entry, exitPrice: 90_000_000n, isLong: false })).toBe(100_000n);
  });
  it('truncates toward zero on both sides, like Solidity', () => {
    // 7 * (101-100)/100 = 0.07 -> 0 ; 7 * (99-100)/100 = -0.07 -> 0 (not -1)
    expect(mirrorPnl({ followerSize: 7n, entryPrice: 100n, exitPrice: 101n, isLong: true })).toBe(0n);
    expect(mirrorPnl({ followerSize: 7n, entryPrice: 100n, exitPrice: 99n, isLong: true })).toBe(0n);
    expect(mirrorPnl({ followerSize: 150n, entryPrice: 100n, exitPrice: 99n, isLong: true })).toBe(-1n);
  });
  it('refuses a zero entry price', () => {
    expect(() => mirrorPnl({ followerSize: 1n, entryPrice: 0n, exitPrice: 1n, isLong: true })).toThrow();
  });
});

describe('splitProfit', () => {
  it('a profit pays the leader the fee, rounded down, and the follower the rest', () => {
    expect(splitProfit(1_000n, 1000)).toEqual({ fee: 100n, followerNet: 900n });
    expect(splitProfit(19n, 1000)).toEqual({ fee: 1n, followerNet: 18n });
    expect(splitProfit(9n, 1000)).toEqual({ fee: 0n, followerNet: 9n });
  });
  it('a loss or a flat close charges no fee, and the follower bears all of it', () => {
    expect(splitProfit(-1_000n, 5000)).toEqual({ fee: 0n, followerNet: -1_000n });
    expect(splitProfit(0n, 10_000)).toEqual({ fee: 0n, followerNet: 0n });
  });
  it('creates and loses no atom: fee + net equals the profit for every rate', () => {
    for (const pnl of [1n, 2n, 99n, 12_345n, 10n ** 15n + 7n]) {
      for (const bps of [0, 1, 999, 1000, 3333, 9999, 10_000]) {
        const { fee, followerNet } = splitProfit(pnl, bps);
        expect(fee + followerNet).toBe(pnl);
        expect(fee >= 0n && followerNet >= 0n).toBe(true);
      }
    }
  });
  it('0% shares nothing and 100% shares all', () => {
    expect(splitProfit(500n, 0).fee).toBe(0n);
    expect(splitProfit(500n, 10_000)).toEqual({ fee: 500n, followerNet: 0n });
  });
});

describe('distributeExact (largest remainder)', () => {
  it('sums to the total exactly', () => {
    expect(distributeExact(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(distributeExact(10n, [3n, 3n, 4n]).reduce((a, b) => a + b, 0n)).toBe(10n);
  });
  it('ties go to the lower index; a zero weight gets nothing', () => {
    expect(distributeExact(2n, [1n, 1n, 1n])).toEqual([1n, 1n, 0n]);
    expect(distributeExact(5n, [0n, 1n, 1n])).toEqual([0n, 3n, 2n]);
  });
  it('holds the invariant across many shapes', () => {
    const shapes: bigint[][] = [[1n], [7n, 13n, 29n], [1n, 1n, 1n, 1n, 1n, 1n, 1n], [10n ** 12n, 1n, 3n]];
    for (const w of shapes) {
      for (const total of [0n, 1n, 17n, 1_000_003n, 10n ** 18n]) {
        const parts = distributeExact(total, w);
        expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
        expect(parts.every((p) => p >= 0n)).toBe(true);
      }
    }
  });
  it('rejects nonsense', () => {
    expect(distributeExact(5n, [])).toEqual([]);
    expect(() => distributeExact(5n, [0n, 0n])).toThrow();
    expect(() => distributeExact(-1n, [1n])).toThrow();
    expect(() => distributeExact(1n, [-1n, 2n])).toThrow();
  });
});

describe('allocateLeaderTrade', () => {
  it('gives each follower their own proportional floor, larger allocations get larger fills', () => {
    const fills = allocateLeaderTrade(1_000_000n, [
      { id: 'a', allocationBps: 1000 },
      { id: 'b', allocationBps: 2500 },
      { id: 'c', allocationBps: 10_000 },
    ]);
    expect(fills.map((f) => f.size)).toEqual([100_000n, 250_000n, 1_000_000n]);
    expect(fills.every((f) => f.remainder === 0n)).toBe(true);
  });
  it('reports the dropped fraction rather than reallocating it', () => {
    const [f] = allocateLeaderTrade(3n, [{ id: 'x', allocationBps: 3333 }]);
    expect(f).toEqual({ id: 'x', size: 0n, remainder: 9_999n });
  });
});

describe('previewFollow', () => {
  it('prints allocation, fee and net for a gain, and no fee for the same move down', () => {
    const p = previewFollow({ terms: { allocationBps: 2500, feeShareBps: 1000 }, leaderSize: 1_000_000_000n, moveBps: 500 });
    expect(p.followerSize).toBe(250_000_000n);
    expect(p.exampleProfit).toBe(12_500_000n);
    expect(p.fee).toBe(1_250_000n);
    expect(p.followerNet).toBe(11_250_000n);
    expect(p.fee + p.followerNet).toBe(p.exampleProfit);
    expect(p.exampleLoss).toBe(-12_500_000n);
  });
});
