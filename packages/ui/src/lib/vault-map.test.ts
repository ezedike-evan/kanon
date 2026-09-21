import { describe, expect, it } from 'vitest';
import { RULE_04, formatDecimal } from '@kanon/spec';
import { assetIdOf, type CopyVaultState, type GuardedVaultState, type RawRefusal } from './vault-client';
import { copyFollowView, formatMoney, leadView, parseAmount, refusalRow, shortAddress, utcMinute, vaultView } from './vault-map';

const DAY = 20_000 * 86_400;
const state: GuardedVaultState = {
  address: '0x00000000000000000000000000000000000ba1ff',
  owner: '0x0000000000000000000000000000000000a11ce0',
  executor: '0x00000000000000000000000000000000000e0e0e',
  strategyChainId: '3',
  series: '0x00000000000000000000000000000000005e1000',
  limits: { assets: ['BTC/USD', 'ETH/USD'], maxDailyDrawdownBps: 200 },
  unknownAssetIds: [],
  balance: 1_000_000_000n,
  today: { utcDay: 20_000, referenceBalance: 1_000_000_000n, realizedPnl: -5_000_000n },
};

describe('parseAmount', () => {
  it('reads plain and grouped decimals into atoms', () => {
    expect(parseAmount('12.5', 6)).toEqual({ ok: true, atoms: 12_500_000n });
    expect(parseAmount('1,000', 6)).toEqual({ ok: true, atoms: 1_000_000_000n });
    expect(parseAmount('.5', 6)).toEqual({ ok: true, atoms: 500_000n });
    expect(parseAmount('7.', 6)).toEqual({ ok: true, atoms: 7_000_000n });
  });
  it('refuses zero, empty, negative, non-numeric and over-precise input rather than rounding', () => {
    for (const bad of ['', '0', '0.000', '-1', 'abc', '1e3', '.', '1.2.3']) {
      expect(parseAmount(bad, 6).ok, bad).toBe(false);
    }
    const over = parseAmount('1.0000001', 6);
    expect(over.ok).toBe(false);
  });
  it('never goes through a float', () => {
    expect(parseAmount('9007199254740993', 0)).toEqual({ ok: true, atoms: 9_007_199_254_740_993n });
  });
});

describe('formatMoney', () => {
  it('truncates to two places toward zero, signed only on request', () => {
    expect(formatMoney({ atoms: '1234567890', decimals: 6 })).toBe('1,234.56');
    expect(formatMoney({ atoms: '-9999', decimals: 6 })).toBe('0.00');
    expect(formatMoney({ atoms: '-118400000', decimals: 6 }, { signed: true })).toBe('−118.40');
    expect(formatMoney({ atoms: '5000000', decimals: 6 }, { signed: true })).toBe('+5.00');
  });
});

describe('helpers', () => {
  it('abbreviates an address and prints UTC minutes', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
    expect(utcMinute(Date.UTC(2026, 8, 2, 14, 32, 7) / 1000)).toBe('2026-09-02 14:32');
  });
});

describe('vaultView', () => {
  it('evaluates the guard over the vault ledger when no stored history exists', () => {
    const v = vaultView({ state, strategyLabel: 'BOS', collateralDecimals: 6, refusals: [], pending: null, nowSeconds: DAY + 100 });
    expect(v.assets).toEqual(['BTC/USD', 'ETH/USD']);
    expect(v.guard.lossBudget).toEqual({ atoms: '20000000', decimals: 6 });
    expect(v.guard.remaining).toEqual({ atoms: '15000000', decimals: 6 });
    expect(v.guard.usedBps).toBe(50);
    expect(v.balance).toEqual({ atoms: '1000000000', decimals: 6 });
  });

  it('prefers stored history when there is some', () => {
    const v = vaultView({
      state, strategyLabel: 'BOS', collateralDecimals: 6, refusals: [], pending: null, nowSeconds: DAY + 100,
      history: [{ at: DAY + 1, equity: 2_000_000_000n, realizedPnl: -10_000_000n }],
    });
    expect(v.guard.referenceBalance.atoms).toBe('2000000000');
    expect(v.guard.lossBudget.atoms).toBe('40000000');
  });
});

describe('refusalRow', () => {
  const base = { state, collateralDecimals: 6, seriesDecimals: 8, blockTimeSeconds: DAY + 60 };
  const raw = (over: Partial<RawRefusal>): RawRefusal => ({
    txHash: '0x' + 'ab'.repeat(32), blockNumber: 12n, assetId: assetIdOf('BTC/USD'), reason: '', decidingValue: 0n, ...over,
  });

  it('a whitelist refusal names the asset that was not on the list', () => {
    const r = refusalRow({ ...base, raw: raw({ reason: 'ASSET_NOT_WHITELISTED', assetId: assetIdOf('DOGE/USD') }) });
    expect(r.predicate).toBe('asset ∈ whitelist');
    expect(r.asset).toMatch(/^0x/); // DOGE is not a listed asset: its id is shown, no symbol is invented
    expect(r.required).toBe('BTC/USD · ETH/USD');
  });

  it('a drawdown refusal shows the cumulative that failed and the floor it fell below', () => {
    const r = refusalRow({ ...base, raw: raw({ reason: 'DAILY_DRAWDOWN_EXCEEDED', decidingValue: -25_000_000n }) });
    expect(r.failing).toBe('−25.000000');
    expect(r.required).toBe('≥ −20.000000');
    expect(r.predicate).toContain('2.00%');
  });

  it('a predicate refusal shows the gate symbol and its number at the series decimals', () => {
    const r = refusalRow({
      ...base,
      raw: raw({ reason: 'PREDICATE_NOT_SATISFIED', gate: { symbol: 'BOS_CONFIRMATION', decidingValue: 6_820_730_000_000n } }),
    });
    expect(r.predicate).toBe('BOS_CONFIRMATION');
    expect(r.failing).toBe(formatDecimal({ atoms: '6820730000000', decimals: 8 }));
  });

  it('carries the evidence: the reason, the transaction, the block and the raw number', () => {
    const r = refusalRow({ ...base, raw: raw({ reason: 'DAILY_DRAWDOWN_EXCEEDED', decidingValue: -25_000_000n }) });
    expect(Object.fromEntries(r.evidence)).toMatchObject({
      'REFUSED BY': 'DAILY_DRAWDOWN_EXCEEDED',
      VAULT: state.address,
      BLOCK: '12',
      'DECIDING VALUE': '-25000000',
    });
    expect(r.evidence.find(([k]) => k === 'TRANSACTION')?.[1]).toBe('0x' + 'ab'.repeat(32));
  });

  it('falls back to the block number when the block time was not read', () => {
    expect(refusalRow({ ...base, blockTimeSeconds: undefined, raw: raw({ reason: 'ASSET_NOT_WHITELISTED' }) }).at).toBe('BLOCK 12');
  });
});

describe('copyFollowView', () => {
  it('maps the vault state to what the screen shows', () => {
    const s: CopyVaultState = {
      address: '0x00000000000000000000000000000000000c0c0c', follower: '0x1', leaderExecutor: '0x2', leaderStrategyChainId: '9',
      allocationBps: 2500, feeShareBps: 1000, feeRecipient: '0x00000000000000000000000000000000000f00ee', active: true,
      balance: 2_500_000_000n, mirroredPositions: 4,
    };
    const v = copyFollowView({ state: s, leadId: 'l1', leadName: 'BOS', collateralDecimals: 6 });
    expect(v).toMatchObject({ allocationBps: 2500, feeShareBps: 1000, active: true, mirrored: 4 });
    expect(v.balance).toEqual({ atoms: '2500000000', decimals: 6 });
  });
});

describe('leadView', () => {
  const row = {
    leadId: 'l1', strategyId: 's1', chainStrategyId: '9', specHash: '0x' + '7f'.repeat(32), spec: RULE_04,
    profitShareBps: 1000, leaderExecutor: '0x00000000000000000000000000000000000e0e0e', feeRecipient: '0x1', taken: 24, blocked: 9,
  };
  it('reads the rule from its spec and computes adherence from the counts', () => {
    const v = leadView(row, { alreadyFollowing: false, deployed: true });
    expect(v.blocker).toBe('');
    expect(v.adherenceBps).toBe(7273);
    expect(v.profitShareBps).toBe(1000);
    expect(v.summary.length).toBeGreaterThan(0);
    expect(v.name.length).toBeGreaterThan(0);
  });
  it('says why it cannot be followed, and never shows an adherence for a lead with no setups', () => {
    expect(leadView(row, { alreadyFollowing: true, deployed: true }).blocker).toContain('already follow');
    expect(leadView(row, { alreadyFollowing: false, deployed: false }).blocker).toContain('not deployed');
    expect(leadView({ ...row, chainStrategyId: null }, { alreadyFollowing: false, deployed: true }).blocker).toContain('registry');
    expect(leadView({ ...row, taken: 0, blocked: 0 }, { alreadyFollowing: false, deployed: true }).adherenceBps).toBeNull();
  });
  it('shows a lead with an unreadable spec by hash rather than hiding it', () => {
    const v = leadView({ ...row, spec: { nonsense: true } }, { alreadyFollowing: false, deployed: true });
    expect(v.summary).toEqual([]);
    expect(v.specHash).not.toBe('');
  });
});
