import { ASSETS } from '@kanon/spec';

/**
 * Display names for the tradeable assets. `packages/spec/src/assets.ts` owns
 * *which* assets exist; this only says what to call them on the chart.
 */

const NAMES: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  MON: 'Monad',
  AVAX: 'Avalanche',
};

/** `BTC / USD`, `btc/usd` and `BTC/USD` are the same asset. */
export function normalizeSymbol(symbol: string): string {
  return symbol.replace(/\s+/g, '').toUpperCase();
}

/** `BTC/USD` -> `BTC`. */
export function baseOf(symbol: string): string {
  return normalizeSymbol(symbol).split('/')[0] ?? symbol;
}

/** `BTC/USD` -> `BTCUSD`, the way the watermark and the bottom bar write it. */
export function compactSymbol(symbol: string): string {
  return normalizeSymbol(symbol).replace('/', '');
}

/** `BTC/USD` -> `Bitcoin / U.S. Dollar`. Unknown assets fall back to their ticker. */
export function assetTitle(symbol: string): string {
  const [base = symbol, quote = 'USD'] = normalizeSymbol(symbol).split('/');
  const quoteName = quote === 'USD' ? 'U.S. Dollar' : quote;
  return `${NAMES[base] ?? base} / ${quoteName}`;
}

/** A predicate sentence to the short code the legend shows. */
export function predicateCode(text: string): string {
  if (/break of structure/i.test(text)) return 'BOS';
  if (/fair value gap/i.test(text)) return 'FVG';
  if (/sweep/i.test(text)) return 'SWEEP';
  return (text.split(/\s+/)[0] ?? text).toUpperCase().slice(0, 6);
}

/**
 * A route parameter (`?asset=`) to a tradeable symbol, or `undefined`. Accepts
 * how a link is likely to spell it (`BTC/USD`, `btc-usd`, `BTCUSD`, `BTC_USD`)
 * and only ever returns an asset the spec lists, so a stray value in the address
 * bar can never send an unknown symbol to the series query.
 */
export function parseAssetParam(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A malformed escape is just text: it will match no asset.
  }
  const squashed = decoded.replace(/[\s/_-]/g, '').toUpperCase();
  return ASSETS.find((a) => a.symbol.replace('/', '') === squashed)?.symbol;
}
