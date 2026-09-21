import { describe, expect, it } from 'vitest';
import { createJsonLogger } from './log';

describe('createJsonLogger', () => {
  it('writes one JSON object per line, with a timestamp, and bigints as strings', () => {
    const lines: string[] = [];
    createJsonLogger((l) => lines.push(l))({ level: 'info', event: 'x', health: 10n ** 20n });
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0]!);
    expect(o).toMatchObject({ level: 'info', event: 'x', health: '100000000000000000000' });
    expect(typeof o.ts).toBe('string');
  });
});
