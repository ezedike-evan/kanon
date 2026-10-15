/**
 * The rule the design canvas is drawn against: RULE 04, BOS_CONFIRMATION / LONG,
 * BTC/USD 15m. Shared by the tests and by the web app's demo state so the two
 * cannot disagree about what the pinned spec says.
 */

import type { StrategySpec } from './spec';
import { inferred, stated, SPEC_VERSION } from './spec';

export const BTC_15M_SERIES = {
  asset: 'BTC/USD',
  feed: 'pyth/btc-usd',
  cadenceSeconds: 60,
  bucketSeconds: 900,
} as const;

export const RULE_04: StrategySpec = {
  version: SPEC_VERSION,
  id: 'rule-04',
  name: 'BOS_CONFIRMATION / LONG',
  direction: 'long',
  series: { ...BTC_15M_SERIES },
  predicates: [
    {
      kind: 'break_of_structure',
      id: 'p1',
      direction: 'long',
      swingLookbackCandles: inferred(5),
      timeframe: stated('15m'),
    },
    {
      kind: 'fair_value_gap',
      id: 'p2',
      direction: 'long',
      minGapBps: inferred(15),
      timeframe: stated('15m'),
    },
    {
      kind: 'liquidity_sweep',
      id: 'p3',
      direction: 'long',
      referenceExtreme: stated('prev_day_low'),
      lookback: inferred('1D'),
      timeframe: stated('15m'),
    },
  ],
  risk: {
    riskPerTradeBps: stated(50),
    stopDistanceBps: stated(50),
    targetDistanceBps: stated(100),
  },
};

/** The pending loosening shown on the cooling-off screen. */
export const RULE_04_LOOSENED: StrategySpec = {
  ...RULE_04,
  risk: {
    riskPerTradeBps: stated(75),
    stopDistanceBps: stated(90),
    targetDistanceBps: stated(100),
  },
};

/** RULE 04 as it would have been pinned before targets existed: a stop, and no target. */
export const RULE_04_NO_TARGET: StrategySpec = {
  ...RULE_04,
  risk: {
    riskPerTradeBps: stated(50),
    stopDistanceBps: stated(50),
  },
};

/**
 * Shaped like the first rule pinned from the live site (strategy 0): one break
 * of structure over 20 candles on BTC/USD 15m, 1% risk, a 2% stop, and no
 * target, because it was compiled before targets existed.
 */
export const BOS20_15M_NO_TARGET: StrategySpec = {
  version: SPEC_VERSION,
  id: 'btc-long-bos-20',
  name: 'BTC Long 15m Break of Structure',
  direction: 'long',
  series: { asset: 'BTC/USD', feed: 'default', cadenceSeconds: 900, bucketSeconds: 900 },
  predicates: [
    {
      kind: 'break_of_structure',
      id: 'bos-20',
      direction: 'long',
      swingLookbackCandles: stated(20),
      timeframe: stated('15m'),
    },
  ],
  risk: {
    riskPerTradeBps: stated(100),
    stopDistanceBps: stated(200),
  },
};
