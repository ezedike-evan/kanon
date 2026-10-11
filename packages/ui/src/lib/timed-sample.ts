import { DEMO_ASSETS } from './domain-demo';
import type { TimedStateView } from './timed-types';

/**
 * Predict for a visitor who has not signed in: the reel, as a labelled sample.
 *
 * The pairs are the demo's own (`DEMO_ASSETS`), so every slide has the demo
 * price and the demo line the chart and the pair lists already show. The
 * stakes, the times, the leverage and the slippage are fixed here, at the
 * figures the server offers by default; they are there to be looked at.
 * Nothing can be sent with them: signed out, `openTimedTrade` answers "Sign in
 * to trade." and calls nothing, and the screen sends a press on UP or DOWN to
 * sign-in instead.
 *
 * It is a state and not a trade. No market is busy, nothing is running, and no
 * result exists: the caller's trades stay `empty`. `sample: true` is what tells
 * a screen to label it and to take its actions off the order path.
 */
export const SAMPLE_TIMED_STATE: Extract<TimedStateView, { status: 'ready' }> = {
  status: 'ready',
  venue: 'perpl',
  network: 'testnet',
  limits: { stakesUsd: [10, 25, 50, 100], durations: [60, 300, 900, 3600], maxLeverage: 5, slippageBps: 100 },
  markets: DEMO_ASSETS.map((asset) => ({ asset, open: true, leverage: 5, busy: null })),
  sample: true,
};
