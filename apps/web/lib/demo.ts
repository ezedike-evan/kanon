/**
 * The demo state the screens render.
 *
 * Every figure here matches the design canvas. Prices are fixed-point, never
 * floats, and percentages are basis points — the same representation the
 * contract and `@kanon/spec` use, so the UI cannot quietly disagree with the
 * arithmetic that decided a trade.
 */

import { parseDecimal, RULE_04, RULE_04_LOOSENED, type Decimal } from '@kanon/spec';

const usd = (n: string): Decimal => parseDecimal(n, 2);
const btc = (n: string): Decimal => parseDecimal(n, 4);

export const SPEC = RULE_04;
export const PENDING_SPEC = RULE_04_LOOSENED;

export const RULE = {
  ordinal: 'RULE 04',
  id: 'rule-04',
  name: 'BOS_CONFIRMATION / LONG',
  asset: 'BTC / USD',
  timeframe: '15M',
  pinnedOn: 'PINNED 08-14',
  specHash: '0x7f3c9a41b8e2d055c31a',
  txAbbrev: '0x7f…c31a',
  contract: 'kanon.enforcer.v2',
  /** English rendering of the three compiled predicates, in SMC language. */
  predicates: [
    'Bullish break of structure confirmed',
    'Fair value gap present',
    'Liquidity sweep confirmed',
  ],
} as const;

/** 00 · REFUSAL — the hero moment. Names the predicate and the failing number. */
export const REFUSAL = {
  predicate: 'BOS_CONFIRMATION / LONG',
  reason:
    'Bullish break of structure not confirmed. Entry requires a closed candle above the prior swing high.',
  requiredHigh: usd('68412.50'),
  currentPrice: usd('68207.30'),
  shortfall: usd('-205.20'),
  shortfallBps: -30,
  at: '2026-09-02 14:32:07 UTC',
  block: '21,884,301',
} as const;

/** 01 · RULE CARD — the home screen. The rule outranks the chart. */
export const HOME = {
  taken: 24,
  blocked: 9,
  adherenceBps: 9620,
  pnl30d: usd('1842.90'),
  price: usd('68207.30'),
  changeBps: -42,
  /** A price line, deliberately small and deliberately last. */
  sparkline: [46, 58, 52, 71, 64, 82, 76, 94, 88, 68, 74, 61, 55, 48, 57, 43, 51, 39],
  /** How many bars at the end read as "now". */
  sparklineHead: 2,
} as const;

/** 02 · CHAT-TO-SPEC COMPILER */
export const COMPILER = {
  draft: 'DRAFT · RULE 07',
  transcript: [
    {
      from: 'KANON',
      at: '14:29',
      text: 'You have break of structure and fair value gap conditions. Anything about where liquidity should be taken first?',
    },
    {
      from: 'YOU',
      at: '14:31',
      text: "Only take longs after a sweep of the previous day's low.",
    },
    {
      from: 'KANON',
      at: '14:31',
      text: 'Compiled. Added one predicate and one parameter. Lookback set to the prior daily session.',
    },
  ],
  /** The live spec, with the lines this turn changed. */
  lines: [
    { text: 'direction: long', changed: false },
    { text: 'timeframe: 15m', changed: false },
    { text: 'require: bos_bullish', changed: false },
    { text: 'require: fvg_present', changed: false },
    { text: 'require: sweep_prev_day_low', changed: true },
    { text: 'sweep_lookback: 1D', changed: true },
    { text: 'risk_per_trade: 0.50%', changed: false },
  ],
} as const;

/** 03 · SPEC REVIEW — plain English by default, parametric one toggle away. */
export const REVIEW = {
  /** Segments split so bound parameters can be rendered as editable chips. */
  plain: [
    [
      'Enter long only after price closes above the prior swing high, measured over a lookback of ',
      { param: '5 candles' },
      ' on the ',
      { param: '15m' },
      ' timeframe.',
    ],
    [
      'An unfilled fair value gap must exist below entry, no smaller than ',
      { param: '0.15%' },
      ' of price.',
    ],
    [
      "Liquidity must be swept below the previous day's low within ",
      { param: '1D' },
      ' of entry.',
    ],
  ],
  parametric: [
    'direction: long',
    'timeframe: 15m',
    'require: bos_bullish',
    'swing_lookback: 5',
    'require: fvg_present',
    'min_gap_size: 0.15%',
    'require: sweep_prev_day_low',
    'sweep_lookback: 1D',
    'risk_per_trade: 0.50%',
    'stop_distance: 0.50%',
  ],
  inferred: [
    { name: 'swing_lookback', value: '5 candles' },
    { name: 'min_gap_size', value: '0.15%' },
    { name: 'sweep_lookback', value: '1D' },
  ],
} as const;

/** 04 · PINNING CEREMONY */
export const PINNING = {
  step: 'STEP 3 / 3',
  bond: parseDecimal('0.2500', 4),
  bondUnit: 'ETH',
  agreements: [
    'This rule will be enforced on every trade. Kanon will refuse setups that fail it.',
    'Tightening the rule takes effect immediately.',
    'Loosening it requires a 24-hour cooling-off period before it applies.',
  ],
} as const;

/** 05 · TRADE PROPOSAL · UNDO WINDOW */
export const PROPOSAL = {
  entry: usd('68441.20'),
  stop: usd('68102.00'),
  target: usd('69118.40'),
  size: btc('0.1840'),
  riskBps: 50,
  undoSeconds: 7,
  checks: [
    { label: 'Break of structure', evidence: '68,441.20 > 68,412.50' },
    { label: 'Fair value gap', evidence: '0.22% > 0.15%' },
    { label: 'Liquidity sweep', evidence: '67,980.10 < 68,015.00' },
  ],
} as const;

/** 06 · TRADE DETAIL · EVIDENCE — the chain that decided the trade. */
export const TRADE_ID = '0247';

export const TRADE = {
  id: TRADE_ID,
  side: 'LONG · CLOSED',
  result: usd('412.60'),
  entry: usd('68441.20'),
  exit: usd('69118.40'),
  returnBps: 99,
  claims: [
    {
      symbol: 'bos_bullish',
      summary: '14:36:02 UTC · 68,441.20',
      fields: [
        ['attested price', '68,441.20'],
        ['threshold', '68,412.50'],
        ['timestamp', '14:36:02 UTC'],
        ['oracle', 'pyth / btc-usd'],
        ['signature', '0x91b4…7e08'],
      ],
    },
    {
      symbol: 'fvg_present',
      summary: '14:35:47 UTC · 0.22%',
      fields: [
        ['attested gap', '0.22%'],
        ['threshold', '0.15%'],
        ['timestamp', '14:35:47 UTC'],
        ['oracle', 'pyth / btc-usd'],
        ['signature', '0x4c2a…91df'],
      ],
    },
    {
      symbol: 'sweep_prev_day_low',
      summary: '14:31:19 UTC · 67,980.10',
      fields: [
        ['attested low', '67,980.10'],
        ['threshold', '68,015.00'],
        ['timestamp', '14:31:19 UTC'],
        ['oracle', 'pyth / btc-usd'],
        ['signature', '0xa70e…3b55'],
      ],
    },
  ],
} as const;

/** 07 · BLOCKED TRADES LOG — the retention metric, and the best screenshot. */
export const BLOCKED = {
  period: 'SEP 2026 ▾',
  refused: 9,
  wouldHaveLost: usd('-1284.40'),
  note: "Modelled to each setup's own stop. 7 of 9 would have closed at a loss.",
  rows: [
    { symbol: 'bos_bullish', at: '09-02 14:32', detail: 'req 68,412.50 · got 68,207.30 · −205.20' },
    { symbol: 'fvg_present', at: '09-01 21:04', detail: 'req 0.15% · got 0.09% · −0.06%' },
    { symbol: 'sweep_prev_day_low', at: '08-31 11:47', detail: 'req 68,015.00 · got 68,104.60 · +89.60' },
    { symbol: 'risk_per_trade', at: '08-30 09:12', detail: 'max 0.50% · got 1.40% · +0.90%' },
    { symbol: 'bos_bullish', at: '08-29 16:20', detail: 'req 67,884.00 · got 67,720.10 · −163.90' },
  ],
} as const;

/** 08 · COOLING-OFF — friction made beautiful rather than hidden. */
export const COOLING_OFF = {
  /** Requested 09-02 14:41 UTC. The countdown runs off this, not off a tick. */
  requestedAt: Date.parse('2026-09-02T14:41:00Z'),
  /** Where the demo clock stands, so the screen opens on 23:41:12 like the design. */
  nowAt: Date.parse('2026-09-02T15:00:48Z'),
  requestedLabel: 'REQUESTED 09-02 14:41 UTC · 24H HOLD',
} as const;

/** 09 · SHAREABLE STRATEGY CARD — the growth loop, and it must verify. */
export const SHARE_CARD = {
  window: 'PINNED 90D',
  summary: [
    'bos_bullish · fvg ≥ 0.15% · sweep_prev_day_low',
    'risk ≤ 0.50% · lookback 5 · tf 15m',
  ],
  adherenceBps: 9620,
  verifiedPnlBps: 840,
  taken: 142,
  blocked: 31,
  overrides: 0,
  url: 'kanon.xyz/v/7fc31a',
  disclaimer:
    'Anyone can verify these figures against the contract. Nothing here is self-reported.',
} as const;

/** 10 · ONBOARDING */
export const ONBOARDING = {
  fund: [
    {
      title: 'CONNECT EXCHANGE',
      sub: 'Read + trade keys · no withdrawal',
      muted: false,
    },
    { title: 'FUND WALLET', sub: 'USDC · minimum 250.00', muted: false },
    {
      title: 'PAPER MODE',
      sub: 'Enforced, unfunded · 25,000.00 sim',
      muted: true,
    },
  ],
  starters: ['No trades before 09:30', 'Max 0.5% risk', 'Stop losses only'],
} as const;
