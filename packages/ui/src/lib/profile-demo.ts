import { parseDecimal } from '@kanon/spec';
import type { ActivityItem, ProfileFollow, ProfileSettings, RuleHistoryItem } from './domain-types';
import { mergeRecords, tradeRecords, type LedgerRecord } from './profile-logic';

/**
 * The signed-out Profile: enough to look like a running account, and nothing
 * that is not labelled as a demo. Constants, built once, and fixed in time (the
 * same way `domain-demo.ts` is), so it re-renders on nothing.
 *
 * The counts agree with Home's demo stats (24 taken, 9 blocked) so the account
 * reads as one across tabs: the record below is exactly those 33 setups.
 */

export const DEMO_PROFILE: ProfileSettings = {
  name: 'Kanon Demo',
  username: 'demo',
  email: null,
  hasWallet: false,
};

/** Milliseconds for the demo account's creation: a fixed month, never "today". */
export const DEMO_JOINED_AT = Date.parse('2026-06-11T09:00:00Z');

interface AssetSpec {
  asset: string;
  base: number;
  /** Price step in whole units, so entries wobble without looking random. */
  step: number;
  size: string;
  sizeDecimals: number;
}

const ASSETS: readonly AssetSpec[] = [
  { asset: 'BTC/USD', base: 67_900, step: 173, size: '0.05000000', sizeDecimals: 8 },
  { asset: 'ETH/USD', base: 3_390, step: 11, size: '0.90000000', sizeDecimals: 8 },
  { asset: 'SOL/USD', base: 161, step: 1, size: '12.00000000', sizeDecimals: 8 },
];

/** Which of the 33 setups were refused, and by which predicate. 9 of them: the demo's `blocked`. */
const REFUSED: Readonly<Record<number, string>> = {
  0: 'bos_bullish',
  2: 'fvg_present',
  4: 'sweep_prev_day_low',
  7: 'fvg_present',
  11: 'bos_bullish',
  15: 'sweep_prev_day_low',
  19: 'bos_bullish',
  24: 'fvg_present',
  30: 'sweep_prev_day_low',
};

/** Hours between one setup and the one before it. A fixed table: the demo never changes. */
const GAPS_H = [0, 5.4, 6.1, 15.2, 4.3, 8.8, 13.7, 3.9, 9.5, 17.1, 5.2, 7.7, 11.4, 6.6, 20.3, 4.8, 9.1, 12.9, 5.7, 8.2, 14.6, 6.3, 10.8, 4.1, 7.4, 16.2, 5.9, 9.7, 13.1, 6.8, 8.5, 11.9, 5.3];

const START = Date.parse('2026-09-02T14:32:00Z');

function buildTrades(): ActivityItem[] {
  const out: ActivityItem[] = [];
  let at = START;
  for (let i = 0; i < GAPS_H.length; i++) {
    at -= Math.round((GAPS_H[i] ?? 0) * 3_600_000);
    const spec = ASSETS[i % ASSETS.length]!;
    const wobble = ((i * 7) % 9) - 4;
    const direction: ActivityItem['direction'] = i % 5 === 3 ? 'short' : 'long';
    const refusedBy = REFUSED[i];
    out.push({
      id: `demo-${i + 1}`,
      kind: refusedBy ? 'refused' : 'executed',
      asset: spec.asset,
      direction,
      entry: parseDecimal((spec.base + wobble * spec.step).toFixed(2), 2),
      size: parseDecimal(spec.size, spec.sizeDecimals),
      at,
      ...(refusedBy ? { refusedBy } : {}),
    });
  }
  return out;
}

export const DEMO_TRADES: ActivityItem[] = buildTrades();

/**
 * The demo record is the 33 setups put to the rule, and nothing else. It lists
 * no Predict row: Predict is a timed trade now, a sample one would be a made-up
 * trade with a made-up result, and the threshold-market stakes it used to list
 * describe a screen that no longer exists. (A real stake left from those markets
 * still reaches the record, through `stakeRecords`.)
 */
export const DEMO_RECORDS: LedgerRecord[] = mergeRecords(tradeRecords(DEMO_TRADES));

const rule = (
  id: string,
  status: RuleHistoryItem['status'],
  active: boolean,
  name: string,
  asset: string,
  hash: string,
  pinnedAt: string | null,
): RuleHistoryItem => ({
  id,
  status,
  active,
  specHash: hash,
  name,
  asset,
  pinnedAt: pinnedAt ? Date.parse(pinnedAt) : null,
});

/** Newest first, as the profile domain returns them. */
export const DEMO_RULES: RuleHistoryItem[] = [
  rule('demo-r5', 'draft', false, 'bos_bullish + fvg_present', 'ETH/USD', '0x3d19a07be4c25f8916de0a4b7c6e83f2d1a5906b47ce88e3f0a1d29b6c754e08', null),
  rule('demo-r4', 'pinned', true, 'bos_bullish + fvg_present + sweep_prev_day_low', 'BTC/USD', '0x7f3c9a41b8e2d055c31a6e94b07d2fa813c5e60d94ab7c1e3382f5d0a61b9c31a', '2026-08-14T08:20:00Z'),
  rule('demo-r3', 'pinned', false, 'bos_bullish + sweep_prev_day_low', 'BTC/USD', '0xa2e8514cd07b93f6e1240a5c8d3b79fe06c412a89d5e7b30f1c68a2d4e9057b3', '2026-07-29T15:45:00Z'),
  rule('demo-r2', 'pinned', false, 'fvg_present', 'SOL/USD', '0x51c0e97a3fb842d6058e1ac7b9d43e26f0a85c17d3be964a02f7c1e58d3a6b94', '2026-07-03T10:05:00Z'),
  rule('demo-r1', 'pinned', false, 'bos_bullish', 'BTC/USD', '0x0be4d7196a5c38f2e07b41d9a86c52e3fd10a7b49c8e3562d1f0a9b74e5c8d26', '2026-06-12T12:30:00Z'),
];

export const DEMO_FOLLOWING: ProfileFollow[] = [
  { address: '0x9a4Fc02d18e3B76c5A0fE41d8b93C6a2E7d05f13', leaderStrategyId: 'k7d2x9m4', allocationBps: 2500, active: true },
  { address: '0x31bE8c6f04D9a2A57e1C83b06f4d9E27a5c08B64', leaderStrategyId: 'm3q8a1c7', allocationBps: 1000, active: true },
];
