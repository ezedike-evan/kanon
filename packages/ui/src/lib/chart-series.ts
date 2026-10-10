/**
 * From the canonical `Series` to what the chart draws, and back to the
 * numbers the header shows.
 *
 * The float boundary is drawn here and nowhere earlier: candle maths upstream
 * stays on `Decimal`. Nothing this file returns is ever fed back into spec
 * arithmetic. The header's change is computed on `Decimal` so it cannot
 * disagree with the last digit of the price beside it.
 */
import type { Decimal, Series } from '@kanon/spec';
import { compareDecimal, subDecimal } from '@kanon/spec';
import type { Candle5, EnginePriceLine } from './chart-protocol';
import { displayDecimals, formatAtoms } from './chart-format';

export { applyPatch, diffCandles, type SeriesDiff } from './chart-candles';

export function decimalToNumber(d: Decimal): number {
  return Number(d.atoms) / 10 ** d.decimals;
}

/** A horizontal level across the chart, as a screen supplies it: exact until the moment it is drawn. */
export interface PriceLevel {
  id: string;
  price: Decimal;
  label: string;
  tone: EnginePriceLine['tone'];
}

/** Levels as the runtime draws them. A price that is not a number has no place on the axis and is left out. */
export function toEnginePriceLines(levels: readonly PriceLevel[]): EnginePriceLine[] {
  const lines: EnginePriceLine[] = [];
  for (const level of levels) {
    const price = decimalToNumber(level.price);
    if (Number.isFinite(price)) lines.push({ id: level.id, price, label: level.label, tone: level.tone });
  }
  return lines;
}

/** All candles of a series as compact rows. */
export function seriesToCandle5(series: Series): Candle5[] {
  return series.candles.map((c) => [
    c.timestamp,
    decimalToNumber(c.open),
    decimalToNumber(c.high),
    decimalToNumber(c.low),
    decimalToNumber(c.close),
  ]);
}

/** Decimal places the feed carries its prices in (Pyth's raw precision, often 8). */
export function seriesDecimals(series: Series): number {
  const last = series.candles[series.candles.length - 1];
  return last ? last.close.decimals : 2;
}

/**
 * Decimal places to *show* the series at: its magnitude's convention, capped by
 * the feed's own precision. Every price on the chart uses this one number.
 */
export function seriesDisplayDecimals(series: Series): number {
  const last = series.candles[series.candles.length - 1];
  if (!last) return 2;
  return displayDecimals(decimalToNumber(last.close), last.close.decimals);
}

/** A `Decimal` at `dp` places, rounded for display only. */
export function formatDecimalAt(d: Decimal, dp: number, opts: { signed?: boolean } = {}): string {
  return formatAtoms(d.atoms, d.decimals, dp, opts);
}

export interface Change {
  abs: Decimal;
  /** Signed basis points of the reference close. */
  bps: number;
  /** Text for the header. */
  absText: string;
  percentText: string;
  direction: 'up' | 'down' | 'flat';
}

const DAY = 86_400;

/**
 * The move over the last day: the last close against the close of the last
 * candle at least a day older, or the first open when the series is shorter
 * than a day. Done in `Decimal`, so the figure matches the price beside it.
 */
export function changeOver24h(series: Series, dp?: number): Change | null {
  const candles = series.candles;
  const last = candles[candles.length - 1];
  if (!last) return null;
  let reference: Decimal | null = null;
  for (let i = candles.length - 2; i >= 0; i--) {
    if (candles[i]!.timestamp <= last.timestamp - DAY) {
      reference = candles[i]!.close;
      break;
    }
  }
  reference ??= candles[0]!.open;
  const abs = subDecimal(last.close, reference);
  const scale = BigInt(Math.max(last.close.decimals, reference.decimals));
  const refAtoms = BigInt(reference.atoms) * 10n ** (scale - BigInt(reference.decimals));
  const absAtoms = BigInt(abs.atoms) * 10n ** (scale - BigInt(abs.decimals));
  const bps = refAtoms === 0n ? 0 : Number((absAtoms * 10_000n) / refAtoms);
  const cmp = compareDecimal(last.close, reference);
  const percent = `${(Math.abs(bps) / 100).toFixed(2)}%`;
  return {
    abs,
    bps,
    absText: formatDecimalAt(abs, dp ?? seriesDisplayDecimals(series), { signed: true }),
    percentText: bps < 0 ? `−${percent}` : bps > 0 ? `+${percent}` : percent,
    direction: cmp > 0 ? 'up' : cmp < 0 ? 'down' : 'flat',
  };
}
