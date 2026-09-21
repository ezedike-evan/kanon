import { createElement, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { createHarness } from './render-harness';
import { createFakeConvex } from './fake-convex.test-util';

/** What a data layer under test has to supply: its provider, its root hook and a set of consumers. */
export interface Adapter {
  Provider: ComponentType<any>;
  useSource(input: any): any;
  pinClient: unknown;
  /** Consumers by id, each a component that reads the layer the way a screen does. */
  consumers: Record<string, ComponentType>;
}

export type Steps = 'tick' | 'series' | 'bridge' | 'trades' | 'leads';

const pricePoint = (n: number) => ({ atoms: String(6_400_000 + n), decimals: 2 });
const market = (n: number) => [
  {
    _id: 'm1', asset: 'BTC/USD', direction: 'above', status: 'open',
    thresholdPrice: { atoms: '6500000', decimals: 2 }, windowStart: 1, windowEnd: 99_999_999_999,
    bucketSeconds: 900, template: 't', termsHash: 'h', createdAt: 1, assetClass: 'crypto',
    params: { offsetBps: 100, significantDigits: 4, windowSeconds: 3600, bucketSeconds: 900, referencePrice: pricePoint(0), referenceAt: 1, feedId: '0x0' },
    latest: { price: pricePoint(n), publishTime: n },
  },
];
const ticker = (asset: string, n: number) => ({
  asset, price: pricePoint(n), publishTime: n, open: null, openTime: null, changeBps: null,
});
const trade = (n: number) => ({
  _id: `t${n}`, strategyId: 's1', status: 'refused', createdAt: n, asset: 'BTC/USD', direction: 'long',
});

export interface ScenarioResult {
  /** Commits per consumer id, per step. */
  renders: Record<Steps, Record<string, number>>;
  /** Queries subscribed with no screen mounted (the landing page), and with every consumer mounted. */
  subscribedAtRoot: string[];
  subscribedWithScreens: string[];
  /** Actions called with no screen mounted, and with every consumer mounted. */
  actionsAtRoot: Record<string, number>;
  actionsWithScreens: Record<string, number>;
}

async function run(adapter: Adapter, consumerIds: string[]) {
  const fake = createFakeConvex();
  const h = createHarness();
  let bump: () => void = () => {};
  // Built once, as the `children` a layout hands the app's provider are: the same element every render,
  // so React skips them unless something they read has changed.
  // Each consumer is run inside a counting wrapper, so its renders are counted in the body: a
  // Profiler does not reliably report a descendant that re-rendered only because a context changed.
  const screens = consumerIds.map((id) => {
    const Consumer = adapter.consumers[id] as unknown as () => ReactNode;
    function Counted(): ReactNode {
      h.counts[id] = (h.counts[id] ?? 0) + 1;
      return Consumer();
    }
    return createElement(Counted, { key: id });
  });

  function Bridge(): ReactElement {
    const [n, setN] = useState(0);
    bump = () => setN((x) => x + 1);
    // Counted in the body: a Profiler around the provider would also count every descendant's commit.
    h.counts.bridge = (h.counts.bridge ?? 0) + 1;
    const source = adapter.useSource({
      hooks: fake.hooks,
      api: fake.api,
      session: { pending: false, signedIn: true },
      pinClient: adapter.pinClient,
      hasWallet: false,
    });
    return createElement(
      adapter.Provider,
      { source },
      createElement('span', { hidden: true }, n),
      ...screens,
    );
  }

  await h.render(createElement(Bridge));
  fake.emit('users.me', { _id: 'u1', username: 'x', name: 'X' });
  fake.emit('strategies.listStrategiesByOwner', [{ _id: 's1', _creationTime: 1, status: 'pinned', specHash: 'h', spec: {} }]);
  fake.emit('trades.listTradesByStrategy', [trade(1)]);
  fake.emit('markets.list', market(1));
  fake.emit('series.listTickers', [ticker('BTC/USD', 1), ticker('ETH/USD', 1)]);
  fake.emit('series.getSeries', {
    asset: 'BTC/USD', bucketSeconds: 900, truncated: false,
    candles: [{ t: 1, open: pricePoint(1), high: pricePoint(1), low: pricePoint(1), close: pricePoint(1), synthetic: false }],
  });
  await h.render(createElement(Bridge));
  return { fake, h, bump: () => bump() };
}

export async function runScenario(adapter: Adapter): Promise<ScenarioResult> {
  const { settle } = await import('./render-harness');

  // Nothing mounted but the root: what the landing page pays for.
  const root = await run(adapter, []);
  const subscribedAtRoot = root.fake.subscribedQueries();
  const actionsAtRoot = { ...root.fake.actionCalls };
  await root.h.unmount();

  const ids = Object.keys(adapter.consumers);
  const all = await run(adapter, ids);
  const subscribedWithScreens = all.fake.subscribedQueries();
  const actionsWithScreens = { ...all.fake.actionCalls };

  const renders = {} as ScenarioResult['renders'];
  let n = 100;
  const step = async (name: Steps, act: () => void) => {
    all.h.reset();
    act();
    await settle();
    renders[name] = { ...all.h.counts };
  };
  await step('tick', () => {
    n += 1;
    all.fake.emit('markets.list', market(n));
    all.fake.emit('series.listTickers', [ticker('BTC/USD', n), ticker('ETH/USD', 1)]);
  });
  await step('series', () => {
    n += 1;
    all.fake.emit('series.getSeries', {
      asset: 'BTC/USD', bucketSeconds: 900, truncated: false,
      candles: [{ t: n, open: pricePoint(n), high: pricePoint(n), low: pricePoint(n), close: pricePoint(n), synthetic: false }],
    });
  });
  await step('bridge', () => all.bump());
  await step('trades', () => {
    n += 1;
    all.fake.emit('trades.listTradesByStrategy', [trade(n)]);
  });
  await step('leads', () => all.fake.emit('copyRelationships.listLeads', []));
  await all.h.unmount();
  return { renders, subscribedAtRoot, subscribedWithScreens, actionsAtRoot, actionsWithScreens };
}
