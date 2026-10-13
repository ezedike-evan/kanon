import { createElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { RULE_04, parseDecimal } from '@kanon/spec';
import { AUTOPILOT_DEMO } from './autopilot';
import { useConvexKanonSource, type ConvexSession } from './convex-source';
import { KanonDataProvider, useKanonData, type KanonDataSource } from './data';
import { createFakeConvex } from './fake-convex.test-util';
import { unavailablePinClient } from './pin';
import { useRecords, type RecordsState } from './profile-hooks';
import { filterRecords, recordTotals, takenByHand } from './profile-logic';
import { createHarness, settle } from './render-harness';

/**
 * Autopilot through the real data source: `useConvexKanonSource` mounted under
 * a renderer against a fake Convex. The server is not deployed with autopilot
 * yet, so this is where the wiring is proved: which function the switch calls
 * and with what, what a screen is handed when a row says autopilot wrote it,
 * and that the record holds one row for a position that the server tells twice.
 */

const pinClient = unavailablePinClient({ registryAddress: undefined, hasWallet: false });
const usd = (v: string) => parseDecimal(v, 2);
const T = Date.parse('2026-10-13T09:15:02Z');

const strategy = (id: string, createdAt: number, over: Record<string, unknown> = {}) => ({
  _id: id,
  _creationTime: createdAt,
  status: 'pinned',
  specHash: `0x${id.padEnd(64, '0')}`,
  spec: RULE_04,
  pinnedAt: createdAt,
  autopilot: false,
  ...over,
});

/** A row of `trades:listTradesByStrategy` as the sweep writes it for a pass. */
const proposal = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  strategyId: 's1',
  direction: 'long',
  asset: 'BTC/USD',
  entry: usd('68441.20'),
  size: parseDecimal('0.0184', 4),
  stop: usd('68098.99'),
  status: 'proposed',
  satisfiedPredicateIds: ['p1'],
  evidenceRefs: ['pyth/btc-usd#900s@1'],
  createdAt: T,
  results: [],
  origin: 'autopilot',
  handoff: 'pending',
  stakeUsd: 10,
  holdSeconds: 900,
  ...over,
});

/** A row of `trades:listRecentActivity`: slim, and `origin` is all it says about autopilot. */
const activity = (id: string, status: string, createdAt: number, over: Record<string, unknown> = {}) => ({
  _id: id,
  strategyId: 's1',
  asset: 'BTC/USD',
  direction: 'long',
  status,
  entry: usd('68441.20'),
  size: parseDecimal('0.0184', 4),
  stop: usd('68098.99'),
  createdAt,
  ...over,
});

/** A row of `timedData:listMine`. */
const timed = (id: string, openedAt: number, over: Record<string, unknown> = {}) => ({
  _id: id,
  _creationTime: openedAt,
  network: 'testnet',
  asset: 'BTC/USD',
  direction: 'up',
  stakeUsd: 10,
  leverage: 5,
  seconds: 900,
  status: 'closed',
  openedAt,
  expiresAt: openedAt + 900_000,
  closedAt: openedAt + 900_400,
  endedBy: 'time',
  size: { atoms: '73000', decimals: 8 },
  entryPrice: { atoms: '684412', decimals: 1 },
  exitPrice: { atoms: '684900', decimals: 1 },
  ...over,
});

function mount(session: ConvexSession = { pending: false, signedIn: true }) {
  const fake = createFakeConvex();
  const h = createHarness();
  const seen: { source: KanonDataSource | null; records: RecordsState | null } = { source: null, records: null };

  function Source(): null {
    seen.source = useKanonData();
    return null;
  }
  function Records(): null {
    seen.records = useRecords();
    return null;
  }
  // Built once, as a layout's children are.
  const screens = [createElement(Source, { key: 'source' }), createElement(Records, { key: 'records' })];

  function Bridge(): ReactElement {
    const source = useConvexKanonSource({ hooks: fake.hooks, api: fake.api, session, pinClient, hasWallet: false });
    return createElement(KanonDataProvider, { source, children: screens });
  }

  return {
    fake,
    h,
    seen,
    source: () => seen.source as KanonDataSource,
    async render() {
      await h.render(createElement(Bridge));
      if (session.signedIn) fake.emit('users.me', { _id: 'u1', username: 'x', name: 'X' });
      await settle();
    },
    async emit(name: string, value: unknown) {
      fake.emit(name, value);
      await settle();
    },
  };
}

const SET = 'strategies.setAutopilot';

describe('the autopilot switch, through the data source', () => {
  it('calls strategies:setAutopilot with the rule and the side, and reports what the server says', async () => {
    const app = mount();
    await app.render();
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1', 1)]);
    app.fake.onMutation(SET, (args: { on: boolean }) => ({ autopilot: args.on }));

    expect(app.source().rule).toMatchObject({ id: 's1', autopilot: false, bucketSeconds: 900 });
    expect(await app.source().setAutopilot('s1', true)).toEqual({ ok: true, on: true });
    expect(app.fake.mutationCalls).toEqual([{ name: SET, args: { strategyId: 's1', on: true } }]);

    // The switch shows what the server says: the strategy's own row, when the live query brings it.
    expect(app.source().rule.autopilot).toBe(false);
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1', 1, { autopilot: true })]);
    expect(app.source().rule.autopilot).toBe(true);
    expect(app.source().ruleHistory[0]).toMatchObject({ id: 's1', autopilot: true, candleSeconds: 900, active: true });

    expect(await app.source().setAutopilot('s1', false)).toEqual({ ok: true, on: false });
    expect(app.fake.mutationCalls[1]).toEqual({ name: SET, args: { strategyId: 's1', on: false } });
    await app.h.unmount();
  });

  it('a mutation that throws comes back as one calm sentence, and nothing is changed here', async () => {
    const app = mount();
    await app.render();
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1', 1)]);
    app.fake.onMutation(SET, () => {
      throw new Error('[CONVEX M(strategies:setAutopilot)] [Request ID: 9a] Server Error');
    });

    const out = await app.source().setAutopilot('s1', true);
    expect(out).toEqual({
      ok: false,
      reason: 'failed',
      message: 'Autopilot was not turned on. Nothing changed: your rule is enforced as before.',
    });
    expect(app.source().rule.autopilot).toBe(false);
    await app.h.unmount();
  });

  it('says so when the server has not been given autopilot yet', async () => {
    const app = mount();
    await app.render();
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1', 1)]);
    app.fake.onMutation(SET, () => {
      throw new Error("Could not find public function for 'strategies:setAutopilot'. Did you forget to run `npx convex dev`?");
    });
    expect(await app.source().setAutopilot('s1', true)).toMatchObject({
      ok: false,
      message: 'This server does not run autopilot yet. Nothing changed.',
    });
    // A strategy row that does not say reads as off, never as on.
    await app.emit('strategies.listStrategiesByOwner', [{ ...strategy('s1', 1), autopilot: undefined }]);
    expect(app.source().rule.autopilot).toBe(false);
    await app.h.unmount();
  });

  it('turns it off by id on a rule that was replaced while it was on', async () => {
    const app = mount();
    await app.render();
    // `old` is still pinned on the server and still judged; `s2` is the rule in force.
    await app.emit('strategies.listStrategiesByOwner', [strategy('old', 1, { autopilot: true }), strategy('s2', 2)]);
    app.fake.onMutation(SET, (args: { on: boolean }) => ({ autopilot: args.on }));

    expect(app.source().rule).toMatchObject({ id: 's2', autopilot: false });
    const replaced = app.source().ruleHistory.find((r) => r.id === 'old');
    expect(replaced).toMatchObject({ active: false, status: 'pinned', autopilot: true });

    expect(await app.source().setAutopilot('old', false)).toEqual({ ok: true, on: false });
    expect(app.fake.mutationCalls).toEqual([{ name: SET, args: { strategyId: 'old', on: false } }]);
    await app.h.unmount();
  });

  it('signed out, the switch is the demo: it sends nothing and says to sign in', async () => {
    const app = mount({ pending: false, signedIn: false });
    await app.render();
    expect(app.source().mode).toBe('demo');
    // Shown, off, on the demo rule: nobody pinned it, so nothing runs it.
    expect(app.source().rule.autopilot).toBe(false);
    expect(app.source().ruleHistory.every((r) => r.autopilot === false)).toBe(true);
    expect(await app.source().setAutopilot(app.source().rule.id, true)).toEqual({ ok: false, reason: 'demo', message: AUTOPILOT_DEMO });
    expect(app.fake.mutationCalls).toEqual([]);
    expect(app.fake.subscribedQueries()).toEqual([]);
    await app.h.unmount();
  });
});

describe('a proposal autopilot wrote, through the data source', () => {
  async function withTrades(trades: unknown[]) {
    const app = mount();
    await app.render();
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1', 1, { autopilot: true })]);
    await app.emit('trades.listTradesByStrategy', trades);
    return app;
  }

  it('waits for the gateway, and is neither confirmed nor undone from the app', async () => {
    const app = await withTrades([proposal('p1')]);
    const shown = app.source().proposal;
    expect(shown).toMatchObject({ tradeId: 'p1', status: 'proposed', undoSeconds: 0 });
    expect(shown?.autopilot).toMatchObject({ state: 'waiting', sent: '$10 · 15m' });

    // The server would answer `not_proposed` and `window_closed`. Neither is asked.
    expect(await app.source().confirmProposal()).toEqual({ ok: false, reason: 'autopilot' });
    expect(await app.source().undoProposal()).toEqual({ ok: false, reason: 'autopilot' });
    expect(app.fake.mutationCalls).toEqual([]);
    await app.h.unmount();
  });

  it('once opened, its evidence screen leads to the timed trade', async () => {
    const app = await withTrades([
      proposal('p1', { status: 'executed', handoff: 'opened', timedTradeId: 'tt1', executionMode: 'paper', executedAt: T + 4000 }),
    ]);
    const detail = app.source().tradeDetail('p1');
    expect(detail?.side).toBe('LONG · OPENED');
    expect(detail?.autopilot).toMatchObject({ state: 'opened', timedTradeId: 'tt1', sent: '$10 · 15m' });
    // The rule took it: it counts once among the rule's executed setups.
    expect(app.source().home).toMatchObject({ taken: 1, blocked: 0 });
    await app.h.unmount();
  });

  it('when nothing was opened, it shows the reason as the server wrote it', async () => {
    const reason = 'The gateway did not pick this up in time. Nothing was sent.';
    const app = await withTrades([proposal('p1', { status: 'undone', handoff: 'not_opened', handoffReason: reason })]);
    expect(app.source().tradeDetail('p1')).toMatchObject({ side: 'LONG · NOT OPENED', autopilot: { state: 'not_opened', reason } });
    expect(app.source().proposal?.autopilot?.reason).toBe(reason);
    // Not taken, and not a refusal either.
    expect(app.source().home).toMatchObject({ taken: 0, blocked: 0 });
    await app.h.unmount();
  });

  it('a refusal it recorded is the refusal in view, marked as its own', async () => {
    const app = await withTrades([
      {
        ...proposal('r1', { status: 'refused', handoff: undefined, stakeUsd: undefined, holdSeconds: undefined }),
        failedPredicateId: 'p1',
        failedSymbol: 'bos_bullish',
        failingValue: usd('68207.30'),
        requiredValue: usd('68412.50'),
      },
    ]);
    expect(app.source().refusal).toMatchObject({ predicate: 'bos_bullish', tradeId: 'r1', autopilot: { state: 'refused', sent: null } });
    expect(app.source().proposal).toBeNull();
    await app.h.unmount();
  });
});

describe('the trading record with autopilot, through the data source', () => {
  it('lists one row for an opened autopilot position, and counts it once', async () => {
    const app = mount();
    await app.render();
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1', 1, { autopilot: true })]);
    expect(app.seen.records?.status).toBe('loading');

    await app.emit('venueData.listMyOrders', []);
    await app.emit('markets.list', []);
    await app.emit('timedData.listMine', [
      // Opened for `p1`: the same position as that proposal, with the real fill.
      timed('tt1', T + 7000, { origin: 'autopilot', proposalId: 'p1' }),
      // Called by hand on Predict.
      timed('tt2', T - 3_600_000, { seconds: 60 }),
    ]);
    await app.emit('trades.listRecentActivity', [
      activity('p1', 'executed', T, { executedAt: T + 7500, origin: 'autopilot' }),
      activity('p2', 'refused', T - 900_000, { failedSymbol: 'bos_bullish', origin: 'autopilot' }),
      activity('p3', 'undone', T - 1_800_000, { origin: 'autopilot' }),
      activity('m1', 'executed', T - 7_200_000, { executedAt: T - 7_190_000 }),
    ]);

    const state = app.seen.records;
    if (state?.status !== 'ready') throw new Error(`expected a ready record, got ${state?.status}`);
    // `p1` is gone: its timed trade stands for the position, and still names it as its evidence.
    expect(state.records.map((r) => r.id)).toEqual(['timed:tt1', 'p2', 'p3', 'timed:tt2', 'm1']);
    const position = state.records[0];
    expect(position?.type === 'timed' && position.trade).toMatchObject({ origin: 'autopilot', proposalId: 'p1' });

    const totals = recordTotals(state.records);
    expect(totals).toEqual({ all: 5, chart: 0, predictions: 1, executed: 2, refused: 1 });
    expect(filterRecords(state.records, 'executed').map((r) => r.id)).toEqual(['timed:tt1', 'm1']);
    expect(filterRecords(state.records, 'predictions').map((r) => r.id)).toEqual(['timed:tt2']);
    // Only the trade called by hand is added to the rule's own count on the Profile tile.
    expect(takenByHand(state.records)).toBe(1);
    await app.h.unmount();
  });

  it('keeps a waiting proposal and one that was not opened: nothing stands in for them', async () => {
    const app = mount();
    await app.render();
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1', 1, { autopilot: true })]);
    await app.emit('venueData.listMyOrders', []);
    await app.emit('markets.list', []);
    await app.emit('timedData.listMine', []);
    await app.emit('trades.listRecentActivity', [
      activity('p1', 'proposed', T, { origin: 'autopilot' }),
      activity('p3', 'undone', T - 900_000, { origin: 'autopilot' }),
    ]);
    const state = app.seen.records;
    if (state?.status !== 'ready') throw new Error(`expected a ready record, got ${state?.status}`);
    expect(state.records.map((r) => r.id)).toEqual(['p1', 'p3']);
    expect(state.records.every((r) => r.type === 'trade' && r.item.origin === 'autopilot')).toBe(true);
    // Neither was taken and neither was refused.
    expect(recordTotals(state.records)).toEqual({ all: 2, chart: 0, predictions: 0, executed: 0, refused: 0 });
    await app.h.unmount();
  });
});
