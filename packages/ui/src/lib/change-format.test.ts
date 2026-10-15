import { describe, expect, it } from 'vitest';
import { CHANGE_TAG, formatChangeValue } from './change-format';

describe('formatChangeValue', () => {
  it('writes basis-point parameters as percentages', () => {
    expect(formatChangeValue('risk_per_trade', '50')).toBe('0.50%');
    expect(formatChangeValue('stop_distance', '90')).toBe('0.90%');
    expect(formatChangeValue('target_distance', '400')).toBe('4.00%');
    expect(formatChangeValue('fvg_present.min_gap_size', '15')).toBe('0.15%');
  });

  it('writes a lookback in candles and leaves enums as they are', () => {
    expect(formatChangeValue('bos_bullish.swing_lookback', '5')).toBe('5 candles');
    expect(formatChangeValue('sweep_prev_day_low.sweep_lookback', '1D')).toBe('1D');
    expect(formatChangeValue('bos_bullish.timeframe', '15m')).toBe('15m');
  });

  it('a side with no value is a dash, not a zero', () => {
    expect(formatChangeValue('risk_per_trade', null)).toBe('—');
  });

  it('names every kind of change', () => {
    expect(Object.keys(CHANGE_TAG).sort()).toEqual(['add', 'loosen', 'remove', 'tighten']);
  });
});
