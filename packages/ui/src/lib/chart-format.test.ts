import { describe, expect, it } from 'vitest';
import {
  displayDecimals,
  formatAtoms,
  formatClock,
  formatCountdown,
  formatPercent,
  formatPrice,
  formatSigned,
  formatSpan,
  formatStamp,
  withAlpha,
} from './chart-format';

describe('chart formatting', () => {
  it('keeps every decimal and groups thousands', () => {
    expect(formatPrice(68207.3, 2)).toBe('68,207.30');
    expect(formatPrice(0.0342, 5)).toBe('0.03420');
    expect(formatPrice(1234567, 0)).toBe('1,234,567');
  });

  it('uses a true minus and an explicit plus', () => {
    expect(formatPrice(-1234.5, 2)).toBe('−1,234.50');
    expect(formatSigned(41.2, 2)).toBe('+41.20');
    expect(formatSigned(-41.2, 2)).toBe('−41.20');
    expect(formatSigned(0, 2)).toBe('0.00');
  });

  it('never prints NaN', () => {
    expect(formatPrice(NaN, 2)).toBe('—');
    expect(formatPercent(Infinity)).toBe('—');
  });

  it('formats percentages', () => {
    expect(formatPercent(1.9234, { signed: true })).toBe('+1.92%');
    expect(formatPercent(-0.05)).toBe('−0.05%');
  });

  it('counts down mm:ss, h:mm:ss and d hh:mm:ss, never negative', () => {
    expect(formatCountdown(252)).toBe('04:12');
    expect(formatCountdown(3_729)).toBe('1:02:09');
    expect(formatCountdown(2 * 86_400 + 4 * 3_600)).toBe('2d 04:00:00');
    expect(formatCountdown(-5)).toBe('00:00');
  });

  it('writes spans the way a trader reads them', () => {
    expect(formatSpan(2_700)).toBe('45m');
    expect(formatSpan(24_300)).toBe('6h 45m');
    expect(formatSpan(3 * 86_400 + 4 * 3_600)).toBe('3d 4h');
  });

  it('writes UTC clocks and stamps', () => {
    expect(formatClock(1_760_400_000)).toBe('00:00');
    expect(formatStamp(1_760_400_000)).toBe('14 Oct 00:00');
  });

  it('turns a token hex into rgba and leaves anything else alone', () => {
    expect(withAlpha('#1FA97A', 0.5)).toBe('rgba(31, 169, 122, 0.5)');
    expect(withAlpha('#fff', 1)).toBe('rgba(255, 255, 255, 1)');
    expect(withAlpha('rgb(1, 2, 3)', 0.5)).toBe('rgb(1, 2, 3)');
  });
});

describe('display precision', () => {
  it('quotes by magnitude, the way a terminal does', () => {
    expect(displayDecimals(85_965.87774282, 8)).toBe(2);
    expect(displayDecimals(3_419.55, 8)).toBe(2);
    expect(displayDecimals(162.4, 8)).toBe(2);
    expect(displayDecimals(10, 8)).toBe(2);
    expect(displayDecimals(2.3456789, 8)).toBe(4);
    expect(displayDecimals(0.0342, 8)).toBe(5);
    expect(displayDecimals(0.00001234, 8)).toBe(6);
  });

  it('the feed precision only caps it, never raises it', () => {
    expect(displayDecimals(85_965, 1)).toBe(1);
    expect(displayDecimals(0.0342, 3)).toBe(3);
    expect(displayDecimals(85_965, 0)).toBe(0);
    expect(displayDecimals(0.5, 8)).toBe(5);
  });

  it('is symmetric for negative references and safe at zero', () => {
    expect(displayDecimals(-3_400, 8)).toBe(2);
    expect(displayDecimals(0, 8)).toBe(6);
  });
});

describe('formatAtoms', () => {
  it('rounds Pyth-raw 8 decimals to the display precision', () => {
    // 85,965.87774282 at 8 decimals
    expect(formatAtoms('8596587774282', 8, 2)).toBe('85,965.88');
    expect(formatAtoms('8000000000000', 8, 2)).toBe('80,000.00');
  });

  it('rounds half away from zero, on integers', () => {
    expect(formatAtoms('12345', 3, 2)).toBe('12.35'); // 12.345
    expect(formatAtoms('12344', 3, 2)).toBe('12.34');
    expect(formatAtoms('-12345', 3, 2)).toBe('\u221212.35');
  });

  it('carries across the decimal point and the thousands group', () => {
    expect(formatAtoms('999999', 6, 2)).toBe('1.00');
    expect(formatAtoms('999995000', 6, 2)).toBe('1,000.00');
  });

  it('pads when the requested places exceed the source', () => {
    expect(formatAtoms('6820730', 2, 4)).toBe('68,207.3000');
    expect(formatAtoms('5', 0, 2)).toBe('5.00');
  });

  it('handles values below one and zero places', () => {
    expect(formatAtoms('342', 4, 5)).toBe('0.03420');
    expect(formatAtoms('4', 4, 2)).toBe('0.00');
    expect(formatAtoms('68207', 2, 0)).toBe('682');
  });

  it('signs a move, and never prints a signed or negative zero', () => {
    expect(formatAtoms('41200', 3, 2, { signed: true })).toBe('+41.20');
    expect(formatAtoms('-41200', 3, 2, { signed: true })).toBe('\u221241.20');
    expect(formatAtoms('-4', 3, 2, { signed: true })).toBe('0.00');
    expect(formatAtoms('0', 2, 2, { signed: true })).toBe('0.00');
  });

  it('is exact past the float range', () => {
    expect(formatAtoms('123456789012345678901', 18, 2)).toBe('123.46');
    expect(formatAtoms('90071992547409930000000', 8, 2)).toBe('900,719,925,474,099.30');
  });

  it('a non-integer string is a dash, not a throw', () => {
    expect(formatAtoms('12.5', 2, 2)).toBe('—');
    expect(formatAtoms('', 2, 2)).toBe('—');
  });
});
