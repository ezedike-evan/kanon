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
  },
};

/** The pending loosening shown on the cooling-off screen. */
export const RULE_04_LOOSENED: StrategySpec = {
  ...RULE_04,
  risk: {
    riskPerTradeBps: stated(75),
    stopDistanceBps: stated(90),
  },
};
