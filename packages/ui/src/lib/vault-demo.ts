/**
 * The vault and copy screens' demo state: what `/screens` and a signed-out
 * visitor see. Every action on it says it is demo and does nothing, so no
 * fixture can ever be mistaken for a vault that exists.
 */

import { SUGGESTED_DAILY_DRAWDOWN_BPS, VAULT_ASSET_UNIVERSE, VAULT_LOOSENING_HOLD_SECONDS, parseDecimal } from '@kanon/spec';
import type { CopyData, VaultOutcome, VaultsData } from './vault-types';

const usdc = (n: string) => parseDecimal(n, 6);

const DEMO_MESSAGE = 'Demo data. Nothing is created, funded or followed.';

export const DEMO_VAULTS: VaultsData = {
  availability: { state: 'demo', message: DEMO_MESSAGE },
  collateralSymbol: 'USDC',
  collateralDecimals: 6,
  universe: [...VAULT_ASSET_UNIVERSE],
  defaults: {
    assets: ['BTC/USD'],
    maxDailyDrawdownBps: SUGGESTED_DAILY_DRAWDOWN_BPS,
    executor: '0x9b1c5f3a7d2e8046b1c9f0a3d5e7b2c4a6e8e07a',
  },
  vaults: [
    {
      address: '0x4be2c8d17a05f3396c9d0e5a72b81f4c3d6ea9f0',
      addressShort: '0x4be2…a9f0',
      strategyLabel: 'BOS_CONFIRMATION / LONG',
      assets: ['BTC/USD', 'ETH/USD'],
      maxDailyDrawdownBps: 200,
      executor: '0x9b1c5f3a7d2e8046b1c9f0a3d5e7b2c4a6e8e07a',
      executorShort: '0x9b1c…e07a',
      balance: usdc('12480.00'),
      guard: {
        referenceBalance: usdc('12480.00'),
        lossBudget: usdc('249.60'),
        remaining: usdc('131.20'),
        realizedToday: usdc('-118.40'),
        usedBps: 94,
      },
      refusals: [
        {
          id: 'demo-drawdown',
          at: '2026-09-02 14:32',
          asset: 'BTC/USD',
          predicate: 'daily_pnl ≥ −2.00% of opening balance',
          failing: '−264.11',
          required: '≥ −249.60',
          txAbbrev: '0x91b4…7e08',
          evidence: [
            ['REFUSED BY', 'DAILY_DRAWDOWN_EXCEEDED'],
            ['VAULT', '0x4be2c8d17a05f3396c9d0e5a72b81f4c3d6ea9f0'],
            ['TRANSACTION', '0x91b4c1d0a37e5f2b86490c1de7a3f5b20e9d4c8a1f6b73025d9e4a8c7e08'],
            ['BLOCK', '21884301'],
            ['DECIDING VALUE', '-264110000'],
          ],
        },
        {
          id: 'demo-whitelist',
          at: '2026-09-01 09:07',
          asset: '0xa1c7…40de',
          predicate: 'asset ∈ whitelist',
          failing: '0xa1c7…40de',
          required: 'BTC/USD · ETH/USD',
          txAbbrev: '0x4c2a…91df',
          evidence: [
            ['REFUSED BY', 'ASSET_NOT_WHITELISTED'],
            ['VAULT', '0x4be2c8d17a05f3396c9d0e5a72b81f4c3d6ea9f0'],
            ['TRANSACTION', '0x4c2a77e01b95d3f8a2064c9e1d7b35a80f24c6e3919b5d7a02e8f1c391df'],
            ['BLOCK', '21860214'],
            ['DECIDING VALUE', '0'],
          ],
        },
      ],
      pending: null,
    },
  ],
  walletBalance: usdc('3200.00'),
  holdSeconds: VAULT_LOOSENING_HOLD_SECONDS,
  loading: false,
};

export const DEMO_COPY: CopyData = {
  availability: { state: 'demo', message: DEMO_MESSAGE },
  collateralSymbol: 'USDC',
  collateralDecimals: 6,
  leads: [
    {
      id: 'demo-lead-1',
      strategyId: 'rule-04',
      name: 'BOS_CONFIRMATION / LONG',
      asset: 'BTC / USD',
      timeframe: '15M',
      summary: ['bos · fvg · sweep', 'fvg ≥ 0.15%', 'risk ≤ 0.50%', 'lookback 20'],
      specHash: '0x7f3c…c31a',
      adherenceBps: 9620,
      taken: 24,
      blocked: 9,
      profitShareBps: 1000,
      executorShort: '0x5d0a…b6c1',
      blocker: '',
    },
    {
      id: 'demo-lead-2',
      strategyId: 'rule-11',
      name: 'LIQUIDITY_SWEEP / LONG',
      asset: 'ETH / USD',
      timeframe: '1H',
      summary: ['sweep · prev day low', 'risk ≤ 0.35%'],
      specHash: '0x22e9…d804',
      adherenceBps: 9140,
      taken: 31,
      blocked: 12,
      profitShareBps: 1500,
      executorShort: '0xc41f…08e2',
      blocker: 'You already follow this strategy.',
    },
  ],
  following: [
    {
      address: '0x7a30d5e1f94b28c6031ae7d5c4b90f16e2a8d3b5',
      addressShort: '0x7a30…d3b5',
      leadId: 'demo-lead-2',
      leadName: 'LIQUIDITY_SWEEP / LONG',
      allocationBps: 2500,
      feeShareBps: 1500,
      active: true,
      balance: usdc('2500.00'),
      mirrored: 4,
      feeRecipientShort: '0xc41f…08e2',
    },
  ],
  walletBalance: usdc('3200.00'),
  loading: false,
};


/** What every demo action answers. A fixture never signs, sends or follows anything. */
export const demoOutcome: VaultOutcome = {
  ok: false,
  reason: 'demo',
  message: 'Demo data. Sign in and connect a wallet to do this for real.',
};
