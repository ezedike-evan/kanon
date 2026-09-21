import { describe, expect, it } from 'vitest';
import { DEMO_MARKETS } from './domain-demo';
import { DEMO_LEADS, demoLine, demoSparkline } from './home-demo';

describe('demoLine', () => {
  it('is deterministic', () => {
    expect(demoLine(7, 120)).toEqual(demoLine(7, 120));
    expect(demoLine(7, 120)).not.toEqual(demoLine(8, 120));
  });

  it('lands exactly on the move it was asked for', () => {
    for (const bps of [-131, -42, 0, 87, 214]) {
      const line = demoLine(3, bps);
      expect(line).toHaveLength(24);
      expect(line[0]).toBeCloseTo(100, 9);
      expect(line.at(-1)).toBeCloseTo(100 * (1 + bps / 10_000), 9);
    }
  });
});

describe('demoSparkline', () => {
  it('draws every demo pair in the direction its 24-hour move says', () => {
    if (DEMO_MARKETS.status !== 'demo') throw new Error('demo markets expected');
    for (const pair of DEMO_MARKETS.pairs) {
      const line = demoSparkline(pair.asset);
      expect(line.status).toBe('demo');
      if (line.status !== 'demo') continue;
      const delta = (line.points.at(-1) ?? 0) - (line.points[0] ?? 0);
      expect(Math.sign(delta)).toBe(Math.sign(pair.changeBps ?? 0));
    }
  });

  it('answers to any spelling of the pair, and has no line for an asset that is not a market', () => {
    expect(demoSparkline('btc / usd').status).toBe('demo');
    expect(demoSparkline('AVAX/USD').status).toBe('empty');
  });
});

describe('DEMO_LEADS', () => {
  it('states an adherence that its own counts produce, and names each rule in SMC language', () => {
    for (const lead of DEMO_LEADS) {
      const attempts = lead.taken + lead.blocked;
      expect(lead.adherenceBps).toBe(Math.round((lead.taken / attempts) * 10_000));
      expect(lead.name).toMatch(/bos_|fvg_|sweep_/);
    }
  });

  it('has unique ids and never lists an asset without a feed', () => {
    expect(new Set(DEMO_LEADS.map((l) => l.leadId)).size).toBe(DEMO_LEADS.length);
    for (const lead of DEMO_LEADS) expect(lead.asset).not.toMatch(/AVAX/);
  });
});
