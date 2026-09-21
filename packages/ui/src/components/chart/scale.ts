/**
 * `Decimal` -> float conversion for the candlestick chart.
 *
 * Everything upstream of this file (candle math) stays
 * on `Decimal` — integer atoms, never floats, per docs/DESIGN.md. Lightweight
 * Charts (like any canvas/DOM chart library) is itself a float coordinate and
 * value space, so the float boundary is drawn here and nowhere earlier: this
 * module converts a `Decimal` price to a plain number only at the last
 * possible step, for feeding the chart, never for comparison or arithmetic
 * that could disagree with the contract.
 *
 * Pixel-space scale math (price <-> y, index <-> x, gridline placement) used
 * to live here for the hand-rolled Skia renderer. Lightweight Charts owns its
 * own axes and pixel mapping now, so that math is gone — see
 * `docs/ARCHITECTURE.md` and this package's `chart/engine.tsx` /
 * `chart/engine.web.tsx` for what replaced it.
 */

import type { Decimal } from '@kanon/spec';

/** UI-only float read of a `Decimal`. Never feed this back into spec math. */
export function decimalToFloat(d: Decimal): number {
  return Number(d.atoms) / 10 ** d.decimals;
}
