import { describe, expect, it } from 'vitest';
import {
  SUGGESTED_DAILY_DRAWDOWN_BPS,
  VAULT_LOOSENING_HOLD_SECONDS,
  checkDrawdown,
  classifyVaultChange,
  decodeBytes32Text,
  describeVaultRefusal,
  drawdownFloorFor,
  drawdownState,
  looseningRemainingMs,
  normalizeAssets,
  stageLoosening,
  utcDay,
  validateVaultLimits,
  vaultAssetKey,
  vaultAssetSymbol,
  type VaultEquityPoint,
} from './vault';
import { COOLING_OFF_SECONDS } from './diff';

const limits = (assets: string[], bps: number) => ({ assets, maxDailyDrawdownBps: bps });
const DAY0 = 20_000 * 86_400; // a UTC midnight
const usdc = (n: number) => BigInt(n) * 1_000_000n;

describe('asset keys', () => {
  it('maps a symbol to the string the contract hashes, and back', () => {
    expect(vaultAssetKey('BTC/USD')).toBe('BTC-USD');
    expect(vaultAssetSymbol('BTC-USD')).toBe('BTC/USD');
  });

  it('dedupes, orders by the universe and drops unknowns', () => {
    expect(normalizeAssets(['eth/usd', 'BTC/USD', 'BTC/USD', 'DOGE/USD'])).toEqual([
      'BTC/USD',
      'ETH/USD',
    ]);
  });
});

describe('validateVaultLimits', () => {
  it('accepts a normal vault', () => {
    expect(validateVaultLimits(limits(['BTC/USD'], SUGGESTED_DAILY_DRAWDOWN_BPS))).toEqual([]);
  });
  it('mirrors the constructor: empty whitelist, zero and >100% drawdown', () => {
    expect(validateVaultLimits(limits([], 200)).map((i) => i.field)).toEqual(['assets']);
    expect(validateVaultLimits(limits(['BTC/USD'], 0)).map((i) => i.field)).toEqual([
      'maxDailyDrawdownBps',
    ]);
    expect(validateVaultLimits(limits(['BTC/USD'], 10_001))).toHaveLength(1);
    expect(validateVaultLimits(limits(['BTC/USD'], 10_000))).toEqual([]);
  });
  it('rejects fractional bps and unlisted assets', () => {
    expect(validateVaultLimits(limits(['BTC/USD'], 1.5))).toHaveLength(1);
    expect(validateVaultLimits(limits(['PEPE/USD'], 200))[0]?.message).toContain('PEPE/USD');
  });
});

describe('classifyVaultChange: tightening is immediate, loosening waits', () => {
  const base = limits(['BTC/USD', 'ETH/USD'], 300);

  it('no change', () => {
    const c = classifyVaultChange(base, base);
    expect(c.kind).toBe('none');
    expect(c.holdSeconds).toBe(0);
  });
  it('a smaller drawdown is a tightening with no hold', () => {
    const c = classifyVaultChange(base, limits(['BTC/USD', 'ETH/USD'], 100));
    expect(c.kind).toBe('tighten');
    expect(c.holdSeconds).toBe(0);
  });
  it('fewer assets is a tightening', () => {
    const c = classifyVaultChange(base, limits(['BTC/USD'], 300));
    expect(c.kind).toBe('tighten');
    expect(c.items).toEqual([
      { field: 'assets', direction: 'tighten', added: [], removed: ['ETH/USD'] },
    ]);
  });
  it('a bigger drawdown is a loosening and waits the cooling-off', () => {
    const c = classifyVaultChange(base, limits(['BTC/USD', 'ETH/USD'], 301));
    expect(c.kind).toBe('loosen');
    expect(c.holdSeconds).toBe(VAULT_LOOSENING_HOLD_SECONDS);
    expect(VAULT_LOOSENING_HOLD_SECONDS).toBe(COOLING_OFF_SECONDS);
  });
  it('an added asset is a loosening', () => {
    const c = classifyVaultChange(base, limits(['BTC/USD', 'ETH/USD', 'SOL/USD'], 300));
    expect(c.kind).toBe('loosen');
  });
  it('a mixed edit waits as a whole', () => {
    const c = classifyVaultChange(base, limits(['BTC/USD', 'SOL/USD'], 100));
    expect(c.kind).toBe('loosen');
    expect(c.items.map((i) => i.direction).sort()).toEqual(['loosen', 'tighten', 'tighten']);
  });
  it('honours a custom hold', () => {
    expect(classifyVaultChange(base, limits(['BTC/USD', 'ETH/USD'], 400), 60).holdSeconds).toBe(60);
  });
});

describe('staged loosening', () => {
  it('ends after the hold and counts down without going negative', () => {
    const p = stageLoosening(limits(['BTC/USD'], 500), 1_000_000);
    expect(p.endsAt).toBe(1_000_000 + VAULT_LOOSENING_HOLD_SECONDS * 1000);
    expect(looseningRemainingMs(p, 1_000_000)).toBe(VAULT_LOOSENING_HOLD_SECONDS * 1000);
    expect(looseningRemainingMs(p, p.endsAt)).toBe(0);
    expect(looseningRemainingMs(p, p.endsAt + 5)).toBe(0);
  });
});

describe('drawdownState / checkDrawdown', () => {
  const bps = 200; // 2%

  it('with no activity today, snapshots the current equity', () => {
    const s = drawdownState({ history: [], nowSeconds: DAY0 + 100, currentEquity: usdc(1000), maxDailyDrawdownBps: bps });
    expect(s.referenceBalance).toBe(usdc(1000));
    expect(s.lossBudget).toBe(usdc(20));
    expect(s.realizedToday).toBe(0n);
    expect(s.remaining).toBe(usdc(20));
    expect(s.usedBps).toBe(0);
  });

  it('uses the first point of the UTC day as the reference and sums that day only', () => {
    const history: VaultEquityPoint[] = [
      { at: DAY0 - 50, equity: usdc(900), realizedPnl: -usdc(500) }, // yesterday, ignored
      { at: DAY0 + 10, equity: usdc(1000), realizedPnl: -usdc(6) },
      { at: DAY0 + 500, equity: usdc(1200), realizedPnl: -usdc(4) }, // deposit before this one
    ];
    const s = drawdownState({ history, nowSeconds: DAY0 + 900, currentEquity: usdc(1190), maxDailyDrawdownBps: bps });
    expect(s.referenceBalance).toBe(usdc(1000));
    expect(s.realizedToday).toBe(-usdc(10));
    expect(s.remaining).toBe(usdc(10));
    expect(s.usedBps).toBe(100);
  });

  it('is order independent', () => {
    const a: VaultEquityPoint = { at: DAY0 + 10, equity: usdc(1000), realizedPnl: 0n };
    const b: VaultEquityPoint = { at: DAY0 + 20, equity: usdc(1100), realizedPnl: -usdc(1) };
    const s1 = drawdownState({ history: [a, b], nowSeconds: DAY0 + 30, currentEquity: 0n, maxDailyDrawdownBps: bps });
    const s2 = drawdownState({ history: [b, a], nowSeconds: DAY0 + 30, currentEquity: 0n, maxDailyDrawdownBps: bps });
    expect(s1).toEqual(s2);
  });

  it('a new UTC day resets the reference and the ledger', () => {
    const history: VaultEquityPoint[] = [{ at: DAY0 + 10, equity: usdc(1000), realizedPnl: -usdc(19) }];
    const next = drawdownState({ history, nowSeconds: DAY0 + 86_400 + 1, currentEquity: usdc(981), maxDailyDrawdownBps: bps });
    expect(next.referenceBalance).toBe(usdc(981));
    expect(next.realizedToday).toBe(0n);
    expect(utcDay(DAY0 + 86_400 + 1)).toBe(utcDay(DAY0) + 1);
  });

  it('floors the budget: 199 atoms at 1% is 1 atom, not 1.99', () => {
    const s = drawdownState({ history: [], nowSeconds: DAY0, currentEquity: 199n, maxDailyDrawdownBps: 100 });
    expect(s.lossBudget).toBe(1n);
  });

  it('allows a proposal that lands exactly on the floor, refuses one atom past it', () => {
    const s = drawdownState({ history: [], nowSeconds: DAY0, currentEquity: usdc(1000), maxDailyDrawdownBps: bps });
    expect(checkDrawdown(s, -usdc(20)).allowed).toBe(true);
    const past = checkDrawdown(s, -usdc(20) - 1n);
    expect(past.allowed).toBe(false);
    expect(past.floor).toBe(-usdc(20));
    expect(past.projectedCumulative).toBe(-usdc(20) - 1n);
  });

  it('counts P&L already realized today against the floor', () => {
    const history: VaultEquityPoint[] = [{ at: DAY0 + 1, equity: usdc(1000), realizedPnl: -usdc(15) }];
    const s = drawdownState({ history, nowSeconds: DAY0 + 2, currentEquity: usdc(1000), maxDailyDrawdownBps: bps });
    expect(checkDrawdown(s, -usdc(5)).allowed).toBe(true);
    expect(checkDrawdown(s, -usdc(5) - 1n).allowed).toBe(false);
  });

  it('a profit today widens what a later loss may be, as on chain', () => {
    const history: VaultEquityPoint[] = [{ at: DAY0 + 1, equity: usdc(1000), realizedPnl: usdc(50) }];
    const s = drawdownState({ history, nowSeconds: DAY0 + 2, currentEquity: usdc(1000), maxDailyDrawdownBps: bps });
    expect(s.remaining).toBe(usdc(20));
    expect(checkDrawdown(s, -usdc(70)).allowed).toBe(true);
  });

  it('a zero-balance vault allows only non-negative days', () => {
    const s = drawdownState({ history: [], nowSeconds: DAY0, currentEquity: 0n, maxDailyDrawdownBps: bps });
    expect(s.usedBps).toBe(0);
    expect(checkDrawdown(s, 0n).allowed).toBe(true);
    expect(checkDrawdown(s, -1n).allowed).toBe(false);
  });

  it('drawdownFloorFor matches the budget', () => {
    expect(drawdownFloorFor(usdc(1000), 200)).toBe(-usdc(20));
  });
});

describe('refusal text', () => {
  const l = limits(['BTC/USD', 'ETH/USD'], 200);

  it('decodes a right-padded bytes32', () => {
    const hex = '0x' + Buffer.from('DAILY_DRAWDOWN_EXCEEDED').toString('hex').padEnd(64, '0');
    expect(decodeBytes32Text(hex)).toBe('DAILY_DRAWDOWN_EXCEEDED');
  });

  it('a whitelist refusal names the asset and the list', () => {
    const v = describeVaultRefusal({
      reason: 'ASSET_NOT_WHITELISTED', decidingValue: 0n, collateralDecimals: 6, limits: l, assetLabel: 'DOGE/USD',
    });
    expect(v.predicate).toBe('asset ∈ whitelist');
    expect(v.failing).toBe('DOGE/USD');
    expect(v.required).toBe('BTC/USD · ETH/USD');
  });

  it('a drawdown refusal shows the failing cumulative and the floor', () => {
    const v = describeVaultRefusal({
      reason: 'DAILY_DRAWDOWN_EXCEEDED', decidingValue: -25_000_000n, collateralDecimals: 6, limits: l,
      assetLabel: 'BTC/USD', floor: -20_000_000n,
    });
    expect(v.predicate).toContain('2.00%');
    expect(v.failing).toBe('−25.000000');
    expect(v.required).toBe('≥ −20.000000');
  });

  it('a predicate refusal carries the RefusalGate symbol and value', () => {
    const v = describeVaultRefusal({
      reason: 'PREDICATE_NOT_SATISFIED', decidingValue: 0n, collateralDecimals: 6, limits: l, assetLabel: 'BTC/USD',
      gate: { symbol: 'BOS_CONFIRMATION', decidingValue: 6_820_730_000_000n, decimals: 8 },
    });
    expect(v.predicate).toBe('BOS_CONFIRMATION');
    expect(v.failing).toBe('68,207.30000000');
  });

  it('a predicate refusal without the gate log still says where the evidence is', () => {
    const v = describeVaultRefusal({
      reason: 'PREDICATE_NOT_SATISFIED', decidingValue: 0n, collateralDecimals: 6, limits: l, assetLabel: 'BTC/USD',
    });
    expect(v.failing).toBe('see evidence');
  });
});
