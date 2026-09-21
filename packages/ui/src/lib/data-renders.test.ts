import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { KanonDataProvider, useKanonData } from './data';
import { useConvexKanonSource } from './convex-source';
import { unavailablePinClient } from './pin';
import { useBlockedLog, useHomeData, useMarkets, useTicker, useVaults } from './domains';
import { runScenario, type Adapter } from './render-scenario.test-util';

/**
 * Who re-renders when what changes. The data layer used to hand every screen a
 * new source whenever any part of it moved, and to subscribe to leads, vaults,
 * the chain and the blocked report at the app root. These pin the behaviour
 * that replaced it: a screen subscribes to, and re-renders for, only what it shows.
 */

const adapter: Adapter = {
  Provider: KanonDataProvider,
  useSource: useConvexKanonSource,
  pinClient: unavailablePinClient({ registryAddress: undefined, hasWallet: false }),
  consumers: {
    rule: () => {
      const { rule } = useKanonData();
      return createElement('p', null, rule.name);
    },
    predict: () => createElement('p', null, useKanonData().usePredict().markets.length),
    chart: () => createElement('p', null, useKanonData().useSeries('BTC/USD', 900).status),
    blocked: () => createElement('p', null, useBlockedLog().refused),
    vault: () => createElement('p', null, useVaults().vaults.vaults.length),
    home: () => createElement('p', null, useHomeData().status),
    pairs: () => {
      const m = useMarkets();
      return createElement('p', null, m.status);
    },
    ticker: () => createElement('p', null, useTicker('ETH/USD').status),
  },
};

describe('the data layer under a live session', async () => {
  const r = await runScenario(adapter);

  it('subscribes to almost nothing at the root, so the landing page pays for almost nothing', () => {
    expect(r.subscribedAtRoot).toEqual([
      'strategies.listStrategiesByOwner',
      'trades.listTradesByStrategy',
      'users.me',
    ]);
    expect(r.actionsAtRoot).toEqual({});
  });

  it('reads leads, vaults and follows, and runs the blocked report, only for the screens that show them', () => {
    expect(r.subscribedWithScreens).toEqual(
      expect.arrayContaining([
        'copyRelationships.listLeads',
        'vaults.listVaultsByOwner',
        'series.listTickers',
        'markets.list',
        'series.getSeries',
      ]),
    );
    expect(r.actionsWithScreens['proposer.blockedReport']).toBeGreaterThan(0);
  });

  it('a price tick re-renders only the components that show prices', () => {
    const t = r.renders.tick;
    expect(t.predict).toBe(1);
    expect(t.pairs).toBe(1);
    for (const id of ['bridge', 'rule', 'blocked', 'vault', 'home', 'chart']) expect(t[id] ?? 0, id).toBe(0);
  });

  it('a candle re-renders only the chart', () => {
    const t = r.renders.series;
    expect(t.chart).toBe(1);
    for (const id of ['bridge', 'rule', 'blocked', 'vault', 'home', 'predict', 'pairs']) expect(t[id] ?? 0, id).toBe(0);
  });

  it('a re-render of the root (an auth or wallet update) re-renders nothing below it', () => {
    const t = r.renders.bridge;
    expect(t.bridge).toBe(1);
    for (const id of Object.keys(adapter.consumers)) expect(t[id] ?? 0, id).toBe(0);
  });

  it('leads changing re-renders only the vault and copy screens', () => {
    const t = r.renders.leads;
    for (const id of ['bridge', 'rule', 'predict', 'chart', 'home', 'pairs']) expect(t[id] ?? 0, id).toBe(0);
  });
});
