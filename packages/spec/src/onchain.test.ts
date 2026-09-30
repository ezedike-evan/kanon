import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { RULE_04 } from './fixtures';
import { inferred, stated, SPEC_VERSION, type StrategySpec } from './spec';
import {
  encodePredicates,
  isOnchainTightening,
  isSpecOnchainTightening,
  predicateSide,
  predicatesCommitment,
  toPredicateDefinitions,
} from './onchain';

/**
 * A three-predicate spec whose ABI encoding was generated with Foundry:
 *
 *   cast abi-encode "f((uint8,bytes32,uint8,uint256,uint256,uint8,uint8,uint256)[])" \
 *     "[(0,<bos_bullish>,0,5,0,0,0,900),(1,<fvg_present>,0,0,25,0,0,900),(2,<sweep_swing_low>,0,0,0,4,1,900)]"
 *
 * The identical vector is asserted in packages/contracts/test/RefusalGate.t.sol
 * (`test_EncodingVector_MatchesTypeScript`), so a change to either side that is
 * not mirrored on the other fails one of the two test suites.
 */
const VECTOR_SPEC: StrategySpec = {
  ...RULE_04,
  predicates: [
    {
      kind: 'break_of_structure',
      id: 'p1',
      direction: 'long',
      swingLookbackCandles: stated(5),
      timeframe: stated('15m'),
    },
    {
      kind: 'fair_value_gap',
      id: 'p2',
      direction: 'long',
      minGapBps: inferred(25),
      timeframe: stated('15m'),
    },
    {
      kind: 'liquidity_sweep',
      id: 'p3',
      direction: 'long',
      referenceExtreme: stated('swing_low'),
      lookback: stated('1h'),
      timeframe: stated('15m'),
    },
  ],
};

const VECTOR_ENCODING =
  '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000626f735f62756c6c69736800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000038400000000000000000000000000000000000000000000000000000000000000016676675f70726573656e74000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000019000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000384000000000000000000000000000000000000000000000000000000000000000273776565705f7377696e675f6c6f770000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000384' as const;
const VECTOR_COMMITMENT = '0x7262d284aebd8e34968cb3a99cafa494e403ec861b314b104bb9147bae191dce' as const;

describe('encodePredicates', () => {
  it('matches the bytes Foundry produces for abi.encode(PredicateDefinition[])', () => {
    expect(encodePredicates(VECTOR_SPEC)).toBe(VECTOR_ENCODING);
  });

  it('commits with keccak256 of exactly those bytes', () => {
    expect(predicatesCommitment(VECTOR_SPEC)).toBe(VECTOR_COMMITMENT);
    expect(predicatesCommitment(VECTOR_SPEC)).toBe(keccak256(VECTOR_ENCODING));
  });

  it('encodes enum members by their Solidity position', () => {
    const [bos, fvg, sweep] = toPredicateDefinitions(VECTOR_SPEC);
    expect(bos).toMatchObject({ kind: 0, direction: 0, swingLookbackCandles: 5n, timeframeSeconds: 900n });
    expect(fvg).toMatchObject({ kind: 1, minGapBps: 25n });
    // swing_low is ReferenceExtreme index 4, '1h' is Lookback index 1, long is 0.
    expect(sweep).toMatchObject({ kind: 2, direction: 0, referenceExtreme: 4, lookback: 1 });
  });

  it('is order-sensitive: reordering predicates changes the commitment', () => {
    const reversed: StrategySpec = { ...VECTOR_SPEC, predicates: [...VECTOR_SPEC.predicates].reverse() };
    expect(predicatesCommitment(reversed)).not.toBe(predicatesCommitment(VECTOR_SPEC));
  });

  it('changes when any predicate parameter changes (a cheaper rule is a different commitment)', () => {
    const cheaper: StrategySpec = {
      ...VECTOR_SPEC,
      predicates: [
        { ...(VECTOR_SPEC.predicates[0] as (typeof VECTOR_SPEC.predicates)[0]), swingLookbackCandles: stated(2) } as never,
        ...VECTOR_SPEC.predicates.slice(1),
      ],
    };
    expect(predicatesCommitment(cheaper)).not.toBe(predicatesCommitment(VECTOR_SPEC));
  });

  it('refuses a predicate whose timeframe does not match the series bucket', () => {
    const wrong: StrategySpec = {
      ...VECTOR_SPEC,
      series: { ...VECTOR_SPEC.series, bucketSeconds: 3_600 },
    };
    expect(() => encodePredicates(wrong)).toThrow(/does not match the series bucket/);
  });

  it('maps each predicate to the side the contract authorizes', () => {
    expect(predicateSide(VECTOR_SPEC.predicates[0]!)).toBe('long');
    expect(predicateSide(VECTOR_SPEC.predicates[1]!)).toBe('long');
    // a sweep of a LOW reference is a long setup ...
    expect(predicateSide(VECTOR_SPEC.predicates[2]!)).toBe('long');
    // ... and of a HIGH reference a short one, whatever direction was written.
    const high = { ...VECTOR_SPEC.predicates[2]!, referenceExtreme: stated('prev_session_high') } as never;
    expect(predicateSide(high)).toBe('short');
  });

  it('refuses a rule that mixes sides (the gate would revert MixedDirections)', () => {
    const mixed: StrategySpec = {
      ...VECTOR_SPEC,
      predicates: [
        VECTOR_SPEC.predicates[0]!,
        { ...(VECTOR_SPEC.predicates[0] as object), id: 'p9', direction: 'short' } as never,
      ],
    };
    expect(() => encodePredicates(mixed)).toThrow(/authorizes short trades/);
  });

  it('refuses predicates whose side disagrees with the spec direction', () => {
    const shortSpec: StrategySpec = { ...VECTOR_SPEC, direction: 'short' };
    expect(() => encodePredicates(shortSpec)).toThrow(/spec's direction is short/);
  });

  it('refuses a sweep whose direction contradicts its reference extreme', () => {
    const bad: StrategySpec = {
      ...VECTOR_SPEC,
      predicates: [
        { ...(VECTOR_SPEC.predicates[2] as object), referenceExtreme: stated('swing_high') } as never,
      ],
    };
    // long spec, sweep of a HIGH reference is a short setup with direction 'long'
    expect(() => encodePredicates(bad)).toThrow(/authorizes short trades|is a short setup/);
  });

  it('encodes the demo rule (RULE_04) without throwing', () => {
    expect(encodePredicates(RULE_04)).toMatch(/^0x[0-9a-f]+$/);
  });
});

describe('isOnchainTightening (mirror of StrategyRegistry._requireTightening)', () => {
  const base = toPredicateDefinitions(RULE_04);
  const clone = () => base.map((d) => ({ ...d }));

  it('accepts identical predicates', () => {
    expect(isOnchainTightening(base, clone())).toBe(true);
  });
  it('accepts a raised minGapBps', () => {
    const n = clone();
    n[1]!.minGapBps += 5n;
    expect(isOnchainTightening(base, n)).toBe(true);
  });
  it('accepts an appended predicate', () => {
    expect(isOnchainTightening(base.slice(0, 2), base)).toBe(true);
  });
  it('rejects a lowered minGapBps', () => {
    const n = clone();
    n[1]!.minGapBps -= 1n;
    expect(isOnchainTightening(base, n)).toBe(false);
  });
  it('rejects a changed lookback or swing lookback', () => {
    const a = clone();
    a[2]!.lookback += 1;
    expect(isOnchainTightening(base, a)).toBe(false);
    const b = clone();
    b[0]!.swingLookbackCandles += 1n;
    expect(isOnchainTightening(base, b)).toBe(false);
  });
  it('rejects removal and reorder', () => {
    expect(isOnchainTightening(base, base.slice(0, 2))).toBe(false);
    expect(isOnchainTightening(base, [base[1]!, base[0]!, base[2]!])).toBe(false);
  });
  it('spec-level helper agrees and is false for an unencodable spec', () => {
    expect(isSpecOnchainTightening(RULE_04, RULE_04)).toBe(true);
    const bad = { ...RULE_04, series: { ...RULE_04.series, bucketSeconds: 1 } };
    expect(isSpecOnchainTightening(RULE_04, bad)).toBe(false);
  });
});
