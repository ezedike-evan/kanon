import { describe, expect, it } from 'vitest';
import { decodeSourcePrice, planMirror, type PythPrice } from './mirror';

const source: PythPrice = { price: 8_445_841_985_312n, conf: 1_333_014_688n, expo: -8, publishTime: 1_000n };

describe('planMirror', () => {
  it('writes the source price stamped with the testnet block time', () => {
    const plan = planMirror(source, 1_030n, 5_000n, 7_200n);
    expect(plan).toEqual({
      ok: true,
      price: { ...source, publishTime: 5_000n },
      sourceAgeSeconds: 30n,
    });
  });

  it('accepts a source exactly at the age limit and refuses one second past it', () => {
    expect(planMirror(source, 1_000n + 7_200n, 5_000n, 7_200n).ok).toBe(true);
    expect(planMirror(source, 1_000n + 7_201n, 5_000n, 7_200n)).toMatchObject({
      ok: false,
      reason: 'source_stale',
    });
  });

  it('refuses a zero or negative source price', () => {
    expect(planMirror({ ...source, price: 0n }, 1_030n, 5_000n, 7_200n)).toMatchObject({
      ok: false,
      reason: 'source_not_positive',
    });
    expect(planMirror({ ...source, price: -1n }, 1_030n, 5_000n, 7_200n)).toMatchObject({
      ok: false,
      reason: 'source_not_positive',
    });
  });

  it('refuses a source published after the source chain\'s own clock', () => {
    expect(planMirror(source, 900n, 5_000n, 7_200n)).toMatchObject({
      ok: false,
      reason: 'source_from_future',
    });
  });

  it('keeps confidence and exponent untouched', () => {
    const plan = planMirror(source, 1_010n, 5_000n, 7_200n);
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.price.conf).toBe(source.conf);
    expect(plan.price.expo).toBe(-8);
  });
});

describe('decodeSourcePrice', () => {
  // The reference vector `pyth-rpc.test.ts` pins against viem's encoder: 68,412.34 at expo -8.
  const RET_BTC =
    '0x00000000000000000000000000000000000000000000000000000638d952888000000000000000000000000000000000000000000000000000000000004e2d80fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff80000000000000000000000000000000000000000000000000000000068e77800';

  it('reads getPriceUnsafe return data into the mirror\'s exact integers', () => {
    expect(decodeSourcePrice(RET_BTC)).toEqual({
      price: 6_841_234_000_000n,
      conf: 5_123_456n,
      expo: -8,
      publishTime: 1_760_000_000n,
    });
  });

  it('throws on return data that is not a price, rather than mirror it', () => {
    expect(() => decodeSourcePrice('0x')).toThrow(/4 words/);
  });
});
