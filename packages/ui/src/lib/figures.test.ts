import { describe, expect, it } from 'vitest';
import { splitFigures } from './figures';

/** A sentence's figures, picked out so they can be set monospaced. */
const figures = (text: string): string[] => splitFigures(text).filter((p) => p.mono).map((p) => p.text);

describe('splitFigures', () => {
  it('picks out a sum, a duration, a multiple and a percent with their signs and units', () => {
    expect(figures('A pass opens $10 for 15m at 5x, within 1.00% of the mark.')).toEqual(['$10', '15m', '5x', '1.00%']);
  });

  it('keeps a grouped figure whole, and leaves the comma that ends a clause to the sentence', () => {
    expect(figures('Size $1,250, 5x the stake.')).toEqual(['$1,250', '5x']);
    expect(figures('It closes itself after 1h.')).toEqual(['1h']);
  });

  it('takes a bare number without the word after it', () => {
    expect(splitFigures('not opened within 2 minutes is dropped')).toEqual([
      { text: 'not opened within ', mono: false },
      { text: '2', mono: true },
      { text: ' minutes is dropped', mono: false },
    ]);
  });

  it('loses nothing: the parts put back together are the sentence', () => {
    const text = 'The hold is the shortest of 1m, 5m, 15m and 1h that is not shorter than one candle.';
    expect(splitFigures(text).map((p) => p.text).join('')).toBe(text);
  });

  it('is one plain part for a sentence with no figure, and nothing for no sentence', () => {
    expect(splitFigures('Recorded as a refusal')).toEqual([{ text: 'Recorded as a refusal', mono: false }]);
    expect(splitFigures('')).toEqual([]);
  });
});
