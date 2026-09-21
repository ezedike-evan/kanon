import { describe, expect, it } from 'vitest';
import { DEMO_ANALYTICS as R } from './analytics-demo';
import { BLOCKED, HOME } from './demo';

const atoms = (d: { atoms: string }) => BigInt(d.atoms);

/**
 * The demo report is hand-entered, so these checks are what stop its figures
 * drifting apart from each other, or from the demo screens around it.
 */
describe('demo analytics agree with themselves', () => {
  it('breaks the refusals down without losing or inventing one', () => {
    expect(R.byPredicate.reduce((n, p) => n + p.count, 0)).toBe(R.avoided.refused);
    expect(R.adherence.refused).toBe(R.avoided.refused);
    expect(R.byPredicate.reduce((n, p) => n + p.lostCount, 0)).toBe(R.avoided.wouldHaveLostCount);
    expect(R.byPredicate.reduce((n, p) => n + atoms(p.lossAvoided), 0n)).toBe(
      atoms(R.avoided.lossAvoided),
    );
    const shares = R.byPredicate.reduce((n, p) => n + p.shareBps, 0);
    expect(Math.abs(shares - 10_000)).toBeLessThanOrEqual(R.byPredicate.length);
  });

  it('judges every refusal it counts', () => {
    expect(R.avoided.judged + R.avoided.pending).toBe(R.avoided.refused);
    expect(R.avoided.wouldHaveLostCount + R.avoided.wouldHaveWonCount).toBeLessThanOrEqual(
      R.avoided.judged,
    );
  });

  it('computes adherence as satisfied over attempts, rounded half up', () => {
    const a = R.adherence;
    expect(a.attempts).toBe(a.executed + a.refused);
    expect(a.adherenceBps).toBe(Math.floor((a.satisfied * 20_000 + a.attempts) / (a.attempts * 2)));
  });

  it('reads the margin account the way MarginAccount.healthFactor does', () => {
    if (R.risk.status !== 'ok') throw new Error('demo risk should be priced');
    const r = R.risk;
    expect(r.lines.reduce((n, l) => n + atoms(l.notional), 0n)).toBe(atoms(r.gross));
    expect(atoms(r.equity)).toBe(atoms(r.collateral) - atoms(r.debt) + atoms(r.unrealizedPnl));
    expect(r.lines.reduce((n, l) => n + atoms(l.pnl!), 0n)).toBe(atoms(r.unrealizedPnl));
    expect(atoms(r.maintenance)).toBe((atoms(r.gross) * BigInt(r.maintenanceBps)) / 10_000n);
    expect(atoms(r.healthFactor!)).toBe((atoms(r.equity) * 10n ** 18n) / atoms(r.maintenance));
    expect(r.leverageBps).toBe(Number((atoms(r.gross) * 10_000n) / atoms(r.equity)));
  });

  it('draws a drawdown that is the deepest fall on its own curve', () => {
    if (R.drawdown.status !== 'ok') throw new Error('demo drawdown should be present');
    let peak = atoms(R.equityCurve[0]!.equity);
    let worst = 0n;
    for (const p of R.equityCurve) {
      const eq = atoms(p.equity);
      if (eq > peak) peak = eq;
      const bps = ((peak - eq) * 10_000n * 2n + peak) / (peak * 2n);
      if (bps > worst) worst = bps;
    }
    expect(R.drawdown.maxDrawdownBps).toBe(Number(worst));
    expect(R.drawdown.points).toBe(R.equityCurve.length);
    const last = R.equityCurve[R.equityCurve.length - 1]!;
    expect(atoms(last.equity) - atoms(R.equityCurve[0]!.equity)).toBe(atoms(R.pnl.total));
  });

  it('holds a cooling-off clock that adds up to its hold', () => {
    const c = R.coolingOff;
    expect(c.elapsedMs + c.remainingMs).toBe(c.holdMs);
  });
});

describe('demo analytics agree with the demo screens around them', () => {
  it('matches the blocked log and the home counts', () => {
    expect(R.avoided.refused).toBe(BLOCKED.refused);
    expect(R.adherence.refused).toBe(HOME.blocked);
    expect(R.adherence.executed).toBe(HOME.taken);
    // The log stores the loss as a negative figure; this report states it as a positive one.
    expect(-atoms(BLOCKED.wouldHaveLost)).toBe(atoms(R.avoided.lossAvoided));
    expect(R.pnl.total).toEqual(HOME.pnl30d);
  });
});
