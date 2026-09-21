import { dec, type AnalyticsReport, type Decimal, type EquityPoint } from '@kanon/spec';
import { COOLING_OFF, RULE, TRADE_ID } from './demo';

/**
 * The analytics screen's signed-out data.
 *
 * Every figure agrees with the demo blocked log (9 refused, 7 of them would have
 * lost, 1,284.40 avoided) and with the demo rule. The margin block was produced
 * by `assessRisk` itself from collateral 10,000.00, a BTC long of 12,000.00 at
 * 68,100.00 and an ETH short of 5,000.00 at 3,450.00, at the contract's default
 * 5% maintenance, so it is a real reading of those inputs and not a number
 * chosen to look reassuring. The equity curve is read by `maxDrawdown` the same
 * way.
 *
 * Nothing here comes from Nansen. The flow card in demo mode shows the same
 * "not connected" state as a live deployment with no key, because a made-up
 * smart-money figure is the one thing that card must never show.
 */

const usd = (atoms: number | string, decimals = 2): Decimal => dec(BigInt(atoms), decimals);

const DAY = 86_400_000;
const CURVE_START = Date.parse('2026-08-09T00:00:00Z');

/** Cumulative equity after each of the 24 modelled trades, from a 10,000.00 start, a day apart. */
const CURVE_ATOMS = [
  '1000000', '1041260', '1070070', '1056040', '1091190', '1064915', '1105435', '1085575',
  '1106815', '1096945', '1129135', '1107595', '1135375', '1102265', '1118555', '1131305',
  '1113845', '1122665', '1098285', '1128195', '1119545', '1142015', '1126095', '1162740',
  '1184290',
];

/** Point 0 is the start, stamped just before the first trade; point i is trade i, a day apart. */
const EQUITY_CURVE: EquityPoint[] = CURVE_ATOMS.map((atoms, i) => ({
  at: i === 0 ? CURVE_START - 1 : CURVE_START + (i - 1) * DAY,
  equity: usd(atoms),
}));

const HOLD_MS = 24 * 60 * 60 * 1000;
const ELAPSED_MS = COOLING_OFF.nowAt - COOLING_OFF.requestedAt;

export const DEMO_ANALYTICS: AnalyticsReport = {
  asOf: COOLING_OFF.nowAt,
  strategyId: RULE.id,
  specHash: RULE.specHash,
  asset: 'BTC/USD',
  adherence: {
    executed: 24,
    refused: 9,
    undone: 2,
    proposed: 0,
    attempts: 33,
    satisfied: 24,
    breaches: 0,
    adherenceBps: 7273,
    refusalBps: 2727,
  },
  avoided: {
    refused: 9,
    judged: 9,
    pending: 0,
    wouldHaveLostCount: 7,
    lossAvoided: usd(128_440),
    wouldHaveWonCount: 2,
    gainForegone: usd(21_230),
  },
  byPredicate: [
    {
      predicateId: 'p1',
      label: 'bos_bullish',
      kind: 'break_of_structure',
      count: 4,
      shareBps: 4444,
      lostCount: 3,
      lossAvoided: usd(56_130),
      latestTradeId: TRADE_ID,
      latestAt: Date.parse('2026-09-02T14:32:00Z'),
    },
    {
      predicateId: 'p2',
      label: 'fvg_present',
      kind: 'fair_value_gap',
      count: 2,
      shareBps: 2222,
      lostCount: 2,
      lossAvoided: usd(31_840),
      latestTradeId: TRADE_ID,
      latestAt: Date.parse('2026-09-01T21:04:00Z'),
    },
    {
      predicateId: 'p3',
      label: 'sweep_prev_day_low',
      kind: 'liquidity_sweep',
      count: 2,
      shareBps: 2222,
      lostCount: 1,
      lossAvoided: usd(24_170),
      latestTradeId: TRADE_ID,
      latestAt: Date.parse('2026-08-31T11:47:00Z'),
    },
    {
      predicateId: 'p4',
      label: 'risk_per_trade',
      kind: 'risk_per_trade',
      count: 1,
      shareBps: 1111,
      lostCount: 1,
      lossAvoided: usd(16_300),
      latestTradeId: TRADE_ID,
      latestAt: Date.parse('2026-08-30T09:12:00Z'),
    },
  ],
  risk: {
    status: 'ok',
    collateral: usd(1_000_000),
    lines: [
      {
        asset: 'BTC/USD',
        side: 'long',
        notional: usd(1_200_000),
        shareBps: 7059,
        entryPrice: usd(6_810_000),
        markPrice: usd(6_820_730),
        pnl: usd(1_890),
      },
      {
        asset: 'ETH/USD',
        side: 'short',
        notional: usd(500_000),
        shareBps: 2941,
        entryPrice: usd(345_000),
        markPrice: usd(341_260),
        pnl: usd(5_420),
      },
    ],
    debt: usd(0),
    unrealizedPnl: usd(7_310),
    equity: usd(1_007_310),
    maintenance: usd(85_000),
    maintenanceBps: 500,
    healthFactor: dec('11850705882352941176', 18),
    adlHealthThreshold: dec('1200000000000000000', 18),
    band: 'healthy',
    gross: usd(1_700_000),
    net: usd(700_000),
    leverageBps: 16_876,
  },
  drawdown: {
    status: 'ok',
    points: CURVE_ATOMS.length,
    maxDrawdownBps: 327,
    currentDrawdownBps: 0,
    peak: usd('1135375'),
    trough: usd('1098285'),
    peakAt: CURVE_START + 11 * DAY,
    troughAt: CURVE_START + 17 * DAY,
  },
  equityCurve: EQUITY_CURVE,
  coolingOff: {
    active: true,
    holdMs: HOLD_MS,
    elapsedMs: ELAPSED_MS,
    remainingMs: HOLD_MS - ELAPSED_MS,
    progressBps: Math.floor((ELAPSED_MS * 10_000) / HOLD_MS),
  },
  pnl: { total: usd(184_290), trades: 24 },
  truncated: false,
};
