import { createElement, useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { diffCandles, seriesToCandle5 } from './chart-series';
import { useConvexKanonSource } from './convex-source';
import { KanonDataProvider, useKanonData, type SeriesState } from './data';
import type { MarketsState } from './domain-types';
import { useMarkets } from './domains';
import { createFakeConvex } from './fake-convex.test-util';
import { createMarketFeed, type MarketFeed } from './market-feed';
import { BASE, createFakeRest, createFakeSockets, venueCandle, venueRange } from './market-feed.test-util';
import { unavailablePinClient } from './pin';
import { createHarness, settle } from './render-harness';

/**
 * The switch itself: `useConvexKanonSource` given a market feed, mounted under
 * a real renderer against a fake gateway and a fake Convex. What reads the
 * venue, what stays on Convex, and that the choice does not move once made.
 */

const M15 = 900_000;
const FORMING = 16_588 * 120 * M15 + 40 * M15;
const NOW = FORMING + 120_000;
const BTC_15M = 'candles@16*900';
const STATE = 'market-state@10143';

const pinClient = unavailablePinClient({ registryAddress: undefined, hasWallet: false });

function gateway() {
  const rest = createFakeRest(() => NOW);
  const sockets = createFakeSockets();
  const feed = createMarketFeed({
    baseUrl: BASE,
    fetch: rest.fetch,
    WebSocket: sockets.Socket,
    now: () => NOW,
    lingerMs: 0,
  });
  return { rest, sockets, feed };
}

function mount(initialFeed: MarketFeed | undefined) {
  const fake = createFakeConvex();
  const h = createHarness();
  const seen: { chart: SeriesState[]; pairs: MarketsState[] } = { chart: [], pairs: [] };
  let setFeed: (feed: MarketFeed | undefined) => void = () => {};

  function Chart(): null {
    const data = useKanonData();
    seen.chart.push(data.useSeries('BTC/USD', 900));
    data.useChartMarkers('BTC/USD', 900);
    return null;
  }
  function Pairs(): null {
    seen.pairs.push(useMarkets());
    return null;
  }
  // Built once, as a layout's children are, so they re-render only for what they read.
  const screens = [createElement(Chart, { key: 'chart' }), createElement(Pairs, { key: 'pairs' })];

  function Bridge(): ReactElement {
    const [marketFeed, set] = useState(initialFeed);
    setFeed = set;
    const source = useConvexKanonSource({
      hooks: fake.hooks,
      api: fake.api,
      session: { pending: false, signedIn: true },
      pinClient,
      hasWallet: false,
      marketFeed,
    });
    return createElement(KanonDataProvider, { source, children: screens });
  }

  return {
    fake,
    h,
    seen,
    setFeed: (feed: MarketFeed | undefined) => setFeed(feed),
    async render() {
      await h.render(createElement(Bridge));
      // A signed-in user with one rule, so the chart has a strategy to ask markers for.
      fake.emit('users.me', { _id: 'u1', username: 'x', name: 'X' });
      fake.emit('strategies.listStrategiesByOwner', [{ _id: 's1', _creationTime: 1, status: 'pinned', specHash: 'h', spec: {} }]);
      await settle();
    },
  };
}

const last = <T,>(list: T[]): T => list[list.length - 1]!;

describe('useConvexKanonSource with a market feed', () => {
  it('reads candles and pair prices from the venue, and trade markers from Convex', async () => {
    const { rest, sockets, feed } = gateway();
    const app = mount(feed);
    await app.render();

    const queries = app.fake.subscribedQueries();
    expect(queries).toContain('series.getChartMarkers');
    expect(queries).not.toContain('series.getSeries');
    expect(queries).not.toContain('series.listTickers');
    expect(rest.paths[0]).toBe('/v1/pub/context');
    expect(rest.candlePaths()).toHaveLength(1);
    expect(last(app.seen.chart).status).toBe('loading');
    expect(last(app.seen.pairs).status).toBe('loading');

    const socket = sockets.last;
    socket.open();
    expect(socket.subs()).toEqual([
      [BTC_15M, true],
      [STATE, true],
    ]);
    const d = venueRange(FORMING - 59 * M15, FORMING, M15, NOW);
    socket.receive({ stream: BTC_15M, mt: 11, d });
    socket.receive({
      stream: STATE,
      mt: 9,
      d: {
        '16': { at: { b: 1, t: NOW }, lst: 825_778, prv: 818_016 },
        '32': { at: { b: 1, t: NOW }, lst: 248_573, prv: 247_545 },
      },
    });
    await settle();

    const chart = last(app.seen.chart);
    expect(chart.status).toBe('ready');
    if (chart.status !== 'ready') return;
    expect(chart.series.candles).toHaveLength(120 + 41);
    expect(chart.series.candles.at(-1)).toMatchObject({
      timestamp: FORMING / 1000,
      close: { atoms: String(venueCandle(FORMING, M15).c), decimals: 1 },
      synthetic: false,
    });

    const pairs = last(app.seen.pairs);
    expect(pairs.status).toBe('ready');
    if (pairs.status !== 'ready') return;
    expect(pairs.pairs.map((p) => [p.asset, p.price, p.changeBps])).toEqual([
      ['BTC/USD', { atoms: '825778', decimals: 1 }, 95],
      ['ETH/USD', { atoms: '248573', decimals: 2 }, 42],
    ]);

    // A candle update re-renders the chart, with the new close, and not the pair list.
    const renders = { chart: app.seen.chart.length, pairs: app.seen.pairs.length };
    socket.receive({ stream: BTC_15M, mt: 12, d: [venueCandle(FORMING, M15, 30)] });
    await settle();
    const moved = last(app.seen.chart);
    expect(app.seen.chart.length).toBe(renders.chart + 1);
    expect(app.seen.pairs.length).toBe(renders.pairs);
    if (moved.status !== 'ready') throw new Error('expected a series');
    expect(moved.series.candles.at(-1)!.close.atoms).toBe(String(venueCandle(FORMING, M15, 30).c));
    expect(moved.series.candles).toHaveLength(120 + 41);
    // To the chart that is a patch of its last bar, not a new data set.
    expect(diffCandles(seriesToCandle5(chart.series), seriesToCandle5(moved.series))).toEqual({
      kind: 'patch',
      candles: [seriesToCandle5(moved.series).at(-1)],
    });

    await app.h.unmount();
    feed.close();
  });

  it('keeps the source it started with: a feed that appears later does not swap a mounted chart over', async () => {
    const { rest, sockets, feed } = gateway();
    const app = mount(undefined);
    await app.render();
    expect(app.fake.subscribedQueries()).toEqual(expect.arrayContaining(['series.getSeries', 'series.listTickers']));

    app.setFeed(feed);
    await settle();
    expect(app.fake.subscribedQueries()).toEqual(expect.arrayContaining(['series.getSeries', 'series.listTickers']));
    expect(rest.paths).toEqual([]);
    expect(sockets.all).toHaveLength(0);

    await app.h.unmount();
    feed.close();
  });

  it('and the other way: a feed that is taken away stays in use', async () => {
    const { rest, feed } = gateway();
    const app = mount(feed);
    await app.render();
    app.setFeed(undefined);
    await settle();
    expect(app.fake.subscribedQueries()).not.toContain('series.getSeries');
    expect(rest.candlePaths()).toHaveLength(1);
    expect(last(app.seen.chart).status).toBe('loading');

    await app.h.unmount();
    feed.close();
  });
});
