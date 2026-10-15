import { createElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { RULE_04 } from '@kanon/spec';
import { SAMPLE_BACKTEST } from './backtest-sample';
import type { BacktestRead, BacktestSubject } from './backtest-types';
import { useConvexKanonSource, type ConvexSession } from './convex-source';
import { KanonDataProvider } from './data';
import { useBacktest } from './domains';
import { createFakeConvex } from './fake-convex.test-util';
import { unavailablePinClient } from './pin';
import { createHarness, settle } from './render-harness';

/**
 * Test on recorded prices through the real data source: `useConvexKanonSource`
 * mounted under a renderer against a fake Convex. What is proved here is the
 * cost of opening the screen: it asks only for the stored answer (`run: false`),
 * and the candles are read only when the run is pressed.
 */

const pinClient = unavailablePinClient({ registryAddress: undefined, hasWallet: false });
const RUN = 'backtest.run';

const strategy = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  _creationTime: 1,
  status: 'pinned',
  specHash: `0x${id.padEnd(64, '0')}`,
  spec: RULE_04,
  pinnedAt: 1,
  autopilot: false,
  ...over,
});

const ran = { specHash: '0xabc', throughBucket: 1_800_000_000, computedAt: 1, behindCandles: 0 };

function mount(subject: BacktestSubject, session: ConvexSession = { pending: false, signedIn: true }) {
  const fake = createFakeConvex();
  const h = createHarness();
  const seen: { read: BacktestRead | null } = { read: null };

  function Probe(): null {
    seen.read = useBacktest(subject);
    return null;
  }
  const screens = createElement(Probe);
  function Bridge(): ReactElement {
    const source = useConvexKanonSource({ hooks: fake.hooks, api: fake.api, session, pinClient, hasWallet: false });
    return createElement(KanonDataProvider, { source, children: screens });
  }

  return {
    fake,
    h,
    read: () => seen.read as BacktestRead,
    runs: () => fake.actionArgs.filter((a) => a.name === RUN).map((a) => (a.args as { run: boolean }).run),
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

describe('the test screen, through the data source', () => {
  it('asks only for the stored answer when it opens, and runs on the press', async () => {
    const app = mount({ kind: 'rule', id: 's1' });
    app.fake.onAction(RUN, (args: { run: boolean }) =>
      args.run ? { status: 'result', result: SAMPLE_BACKTEST, ...ran, source: 'run' } : { status: 'not_run', specHash: '0xabc' },
    );
    await app.render();
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1')]);

    expect(app.runs()).toEqual([false]);
    expect(app.fake.actionArgs.find((a) => a.name === RUN)?.args).toEqual({ spec: RULE_04, run: false });
    expect(app.read().state).toEqual({ status: 'not_run' });
    expect(app.read()).toMatchObject({ canRun: true, running: false, note: null, subject: { asset: 'BTC/USD', timeframe: '15M' } });

    app.read().run();
    await settle();
    expect(app.runs()).toEqual([false, true]);
    expect(app.read().state).toMatchObject({ status: 'result', sample: false, source: 'run', behindCandles: 0 });
    expect(app.read().running).toBe(false);
    await app.h.unmount();
  });

  it('keeps what it showed when the hour is spent, and says so', async () => {
    const app = mount({ kind: 'rule', id: 's1' });
    app.fake.onAction(RUN, (args: { run: boolean }) =>
      args.run
        ? { status: 'rate_limited', retryAfterMs: 120_000, message: 'Rate limit reached for now. Try again in about 2 minutes.' }
        : { status: 'result', result: SAMPLE_BACKTEST, ...ran, behindCandles: 4, source: 'stored' },
    );
    await app.render();
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1')]);
    expect(app.read().state).toMatchObject({ status: 'result', behindCandles: 4, source: 'stored' });

    app.read().run();
    await settle();
    expect(app.read().state).toMatchObject({ status: 'result', behindCandles: 4 });
    expect(app.read().note).toBe('Rate limit reached for now. Try again in about 2 minutes.');
    await app.h.unmount();
  });

  it('turns a server that throws into one sentence, without a run', async () => {
    const app = mount({ kind: 'rule', id: 's1' });
    app.fake.onAction(RUN, () => {
      throw new Error('That is not a rule the test can read.');
    });
    await app.render();
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1')]);
    expect(app.read().state).toEqual({ status: 'failed', message: 'That is not a rule the test can read.' });
    await app.h.unmount();
  });

  it('tests the rule under review: the pinned rule, with nothing staged', async () => {
    const app = mount({ kind: 'review' });
    app.fake.onAction(RUN, () => ({ status: 'not_run', specHash: '0xabc' }));
    await app.render();
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1')]);
    expect(app.fake.actionArgs.find((a) => a.name === RUN)?.args).toEqual({ spec: RULE_04, run: false });
    await app.h.unmount();
  });

  it('asks nothing for a rule that is not the caller own', async () => {
    const app = mount({ kind: 'rule', id: 'someone-else' });
    await app.render();
    // The rules have not arrived yet: nothing is said to be missing.
    expect(app.read().state).toEqual({ status: 'loading' });
    await app.emit('strategies.listStrategiesByOwner', [strategy('s1')]);
    expect(app.runs()).toEqual([]);
    expect(app.read().state).toEqual({ status: 'nothing', message: 'None of your rules has this id.' });
    expect(app.read().canRun).toBe(false);
    await app.h.unmount();
  });

  it('shows the labelled sample signed out, and reads and runs nothing', async () => {
    const app = mount({ kind: 'rule', id: 's1' }, { pending: false, signedIn: false });
    await app.render();
    expect(app.read().state).toEqual({ status: 'result', result: SAMPLE_BACKTEST, sample: true });
    expect(app.read().canRun).toBe(false);
    app.read().run();
    await settle();
    expect(app.runs()).toEqual([]);
    await app.h.unmount();
  });
});
