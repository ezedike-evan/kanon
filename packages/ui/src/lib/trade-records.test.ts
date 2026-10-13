import { describe, expect, it } from 'vitest';
import { parseDecimal } from '@kanon/spec';
import type { ActivityItem } from './domain-types';
import type { TimedTrade } from './timed-types';
import {
  EXIT_PENDING,
  averageEntry,
  chartResult,
  chartRowFigures,
  chartTradeDetail,
  chartTradeView,
  chartTrades,
  ruleRowView,
  runningFacts,
  timedOrderIds,
  timedRowView,
} from './trade-records';
import { NOT_REPORTED_YET } from './venue-trade';
import type { VenueOrder } from './venue-types';

const T0 = Date.parse('2026-10-11T09:00:00Z');
const s = (seconds: number) => T0 + seconds * 1000;
const size = (v: string) => parseDecimal(v, 5);
const price = (v: string) => parseDecimal(v, 1);
const ausd = (v: string) => parseDecimal(v, 6);

function order(id: string, at: number, over: Partial<VenueOrder> = {}): VenueOrder {
  return {
    id,
    network: 'testnet',
    asset: 'BTC/USD',
    action: 'open',
    side: 'long',
    status: 'filled',
    createdAt: at,
    settledAt: at + 2_000,
    notionalUsd: 50,
    leverage: 5,
    requestId: 1,
    size: size('0.00100'),
    fillPrice: price('50000.0'),
    fee: ausd('0.017250'),
    block: 100,
    txHash: `0x${id.padEnd(64, '0')}`,
    reason: null,
    ...over,
  };
}

const close = (id: string, at: number, over: Partial<VenueOrder> = {}): VenueOrder =>
  order(id, at, { action: 'close', notionalUsd: null, leverage: null, fillPrice: price('50500.0'), ...over });

function timed(id: string, openedAt: number, over: Partial<TimedTrade> = {}): TimedTrade {
  return {
    id,
    network: 'testnet',
    asset: 'BTC/USD',
    direction: 'up',
    stakeUsd: 10,
    leverage: 5,
    seconds: 60,
    status: 'closed',
    openedAt,
    expiresAt: openedAt + 60_000,
    closedAt: openedAt + 62_000,
    endedBy: 'time',
    size: size('0.00100'),
    entryPrice: price('50000.0'),
    exitPrice: price('50010.0'),
    result: ausd('-0.024500'),
    fees: ausd('0.034500'),
    openTx: null,
    closeTx: null,
    reason: null,
    origin: null,
    proposalId: null,
    ...over,
  };
}

describe('pairing orders into chart trades', () => {
  it('pairs an open with the close that followed it', () => {
    const [trade, ...rest] = chartTrades([close('c', s(90)), order('o', s(0))]);
    expect(rest).toEqual([]);
    expect(trade).toMatchObject({ id: 'o', asset: 'BTC/USD', side: 'long', status: 'closed', openedAt: s(0), closedAt: s(92) });
    expect(trade?.opens.map((o) => o.id)).toEqual(['o']);
    expect(trade?.close?.id).toBe('c');
    expect(trade?.entryPrice).toEqual(price('50000.0'));
    expect(trade?.exitPrice).toEqual(price('50500.0'));
  });

  it('folds an add into the trade it adds to and weights the entry by size', () => {
    const [trade] = chartTrades([
      order('o1', s(0)),
      order('o2', s(30), { size: size('0.00300'), fillPrice: price('50400.0'), notionalUsd: 100 }),
      close('c', s(90)),
    ]);
    expect(trade?.opens.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(trade?.size).toEqual(size('0.00400'));
    // (1 x 50000 + 3 x 50400) / 4
    expect(trade?.entryPrice).toEqual(price('50300.0'));
    expect(trade?.notionalUsd).toBe(150);
    expect(trade?.leverage).toBe(5);
  });

  it('leaves a trade with no close open', () => {
    const [trade] = chartTrades([order('o', s(0))]);
    expect(trade).toMatchObject({ status: 'open', close: null, closedAt: null, exitPrice: null });
  });

  it('keeps markets apart and lists the newest trade first', () => {
    const trades = chartTrades([
      order('btc', s(0)),
      order('eth', s(10), { asset: 'ETH/USD', side: 'short' }),
      close('eth-c', s(40), { asset: 'ETH/USD', side: 'short' }),
    ]);
    expect(trades.map((t) => [t.id, t.status])).toEqual([
      ['eth', 'closed'],
      ['btc', 'open'],
    ]);
  });

  it('reads only filled orders: a refusal, a miss and an order on its way are not trades', () => {
    const trades = chartTrades([
      order('refused', s(0), { status: 'refused' }),
      order('unfilled', s(5), { status: 'unfilled' }),
      order('failed', s(10), { status: 'failed' }),
      order('sending', s(15), { status: 'submitting' }),
    ]);
    expect(trades).toEqual([]);
  });

  it('marks a trade ended elsewhere when the next open is on the other side, and guesses no exit', () => {
    const trades = chartTrades([order('long', s(0)), order('short', s(300), { side: 'short' })]);
    expect(trades.map((t) => [t.id, t.status])).toEqual([
      ['short', 'open'],
      ['long', 'ended_elsewhere'],
    ]);
    expect(trades[1]?.exitPrice).toBeNull();
    expect(trades[1]?.closedAt).toBeNull();
  });

  it('records a close of a position the caller did not open as a trade with no entry', () => {
    const [trade] = chartTrades([close('c', s(0), { size: size('0.00200') })]);
    expect(trade).toMatchObject({ id: 'c', status: 'closed', opens: [], entryPrice: null, side: 'long' });
    expect(trade?.size).toEqual(size('0.00200'));
    expect(chartResult(trade!)).toBeNull();
  });

  it('gives no average while one fill has not reported its price', () => {
    expect(averageEntry([order('a', s(0)), order('b', s(5), { fillPrice: null })])).toBeNull();
    expect(averageEntry([])).toBeNull();
  });

  it('averages across fills reported at different scales', () => {
    const avg = averageEntry([
      order('a', s(0), { size: parseDecimal('1', 0), fillPrice: parseDecimal('100', 0) }),
      order('b', s(5), { size: parseDecimal('1.00', 2), fillPrice: parseDecimal('101.5', 1) }),
    ]);
    // 100.75 at one decimal, rounded half up.
    expect(avg).toEqual(parseDecimal('100.8', 1));
  });
});

describe('orders a timed trade placed', () => {
  const trade = timed('t', s(100));

  it('claims the open recorded just before the trade began and the close that ended it', () => {
    const orders = [order('open', s(96)), close('close', s(160))];
    expect([...timedOrderIds(orders, [trade])].sort()).toEqual(['close', 'open']);
    expect(chartTrades(orders, [trade])).toEqual([]);
  });

  it('claims every close it had to retry while it held the market', () => {
    const orders = [order('open', s(96)), close('try1', s(160), { status: 'unfilled' }), close('try2', s(161))];
    expect(timedOrderIds(orders, [trade]).size).toBe(3);
  });

  it('leaves a chart trade on the same market before and after it alone', () => {
    const before = [order('b-open', s(-600)), close('b-close', s(-500))];
    const after = [order('a-open', s(165)), close('a-close', s(400))];
    const orders = [...before, order('open', s(96)), close('close', s(160)), ...after];
    expect(chartTrades(orders, [trade]).map((t) => t.id)).toEqual(['a-open', 'b-open']);
  });

  it('does not claim a chart close that settled in the minute before the trade began', () => {
    const orders = [order('b-open', s(-600)), close('b-close', s(80)), order('open', s(96)), close('close', s(160))];
    const ids = timedOrderIds(orders, [trade]);
    expect(ids.has('b-close')).toBe(false);
    expect(chartTrades(orders, [trade]).map((t) => [t.id, t.status])).toEqual([['b-open', 'closed']]);
  });

  it('claims only the newest open before the trade, not an earlier one', () => {
    const orders = [order('earlier', s(60)), close('earlier-c', s(70)), order('open', s(96))];
    const ids = timedOrderIds(orders, [trade]);
    expect(ids.has('open')).toBe(true);
    expect(ids.has('earlier')).toBe(false);
  });

  it('claims by transaction whatever the times say', () => {
    const late = close('late', s(900), { txHash: '0xabc' });
    expect(timedOrderIds([late], [timed('t', s(100), { closeTx: '0xabc' })]).has('late')).toBe(true);
  });

  it('claims everything on the market of a trade still running', () => {
    const running = timed('t', s(100), { status: 'live', closedAt: null, endedBy: null, exitPrice: null });
    expect(timedOrderIds([order('open', s(96)), order('add', s(4_000))], [running]).size).toBe(2);
  });

  it('ignores another market', () => {
    expect(timedOrderIds([order('eth', s(96), { asset: 'ETH/USD' })], [trade]).size).toBe(0);
  });
});

describe('a chart trade\'s result', () => {
  it('is the exit against the entry times the size, less every fee', () => {
    const [trade] = chartTrades([order('o', s(0)), close('c', s(90), { fee: ausd('0.017400') })]);
    // 500.0 x 0.001 = 0.50, less 0.01725 + 0.0174
    expect(chartResult(trade!)).toEqual({ amount: ausd('0.465350'), fees: ausd('0.034650') });
  });

  it('turns a short the right way round', () => {
    const [trade] = chartTrades([
      order('o', s(0), { side: 'short' }),
      close('c', s(90), { side: 'short', fee: ausd('0.017400') }),
    ]);
    expect(chartResult(trade!)?.amount).toEqual(ausd('-0.534650'));
  });

  it('states the result before fees while a fee is not reported', () => {
    const [trade] = chartTrades([order('o', s(0), { fee: null }), close('c', s(90))]);
    expect(chartResult(trade!)).toEqual({ amount: ausd('0.500000'), fees: null });
    const facts = new Map(chartTradeDetail(trade!).facts);
    expect(facts.get('Result before fees')).toBe('+0.50 AUSD');
    expect(facts.get('Fees')).toBe(NOT_REPORTED_YET);
  });

  it('has none while the trade is open or the exit is not reported', () => {
    const [open] = chartTrades([order('o', s(0))]);
    expect(chartResult(open!)).toBeNull();
    const [awaiting] = chartTrades([order('o', s(0)), close('c', s(90), { fillPrice: null })]);
    expect(chartResult(awaiting!)).toBeNull();
  });
});

describe('what a chart trade says', () => {
  it('is a direction, a state and two prices in a row, never money', () => {
    const [trade] = chartTrades([order('o', s(0)), close('c', s(90))]);
    const view = chartTradeView(trade!);
    expect(view).toMatchObject({
      asset: 'BTC/USD',
      sideWord: 'Long',
      state: 'CLOSED',
      terms: '$50 · 5x',
      size: '0.001 BTC',
      entry: '50,000.0',
      exit: '50,500.0',
      at: s(0),
    });
    expect(view.move?.direction).toBe('up');
    expect(JSON.stringify(view)).not.toContain('AUSD');
  });

  it('says a figure is not reported instead of leaving it out', () => {
    const [trade] = chartTrades([order('o', s(0), { fillPrice: null }), close('c', s(90), { fillPrice: null })]);
    const view = chartTradeView(trade!);
    expect(view.entry).toBe(NOT_REPORTED_YET);
    expect(view.exit).toBe(NOT_REPORTED_YET);
    expect(view.move).toBeNull();
  });

  it('has no exit while the trade is open', () => {
    const [trade] = chartTrades([order('o', s(0))]);
    expect(chartTradeView(trade!)).toMatchObject({ state: 'OPEN', exit: null });
  });

  it('lists every order\'s transaction as evidence, and says which are not reported', () => {
    const [trade] = chartTrades([order('o1', s(0)), order('o2', s(30), { txHash: null }), close('c', s(90))]);
    const detail = chartTradeDetail(trade!);
    expect(detail.txs.map((t) => [t.name, t.tx === null])).toEqual([
      ['Open', false],
      ['Add 1', true],
      ['Close', false],
    ]);
    expect(detail.txs[0]?.tx?.url).toContain('/tx/0xo1');
    const facts = new Map(detail.facts);
    expect(facts.get('Orders in')).toBe('2');
    expect(facts.get('Average entry')).toBe('50,000.0');
    expect(facts.get('Held for')).toBe('1m 32s');
    // The day and the time, in UTC: a record is read long after the trade.
    expect(facts.get('Opened')).toBe('2026-10-11 09:00 UTC');
    expect(facts.get('Closed')).toBe('2026-10-11 09:01 UTC');
  });

  it('says how much the close took when it was more than the caller opened', () => {
    const [trade] = chartTrades([order('o', s(0)), close('c', s(90), { size: size('0.00250') })]);
    expect(new Map(chartTradeDetail(trade!).facts).get('Size closed')).toBe('0.0025 BTC');
  });
});

describe('the two figures on a row', () => {
  it('is the entry over the exit once a chart trade has closed', () => {
    const [trade] = chartTrades([order('o', s(0)), close('c', s(90))]);
    expect(chartRowFigures(chartTradeView(trade!))).toEqual({ value: '50,000.0', sub: '→ 50,500.0' });
  });

  it('is the entry over the state while it is open or ended elsewhere', () => {
    const [open] = chartTrades([order('o', s(0))]);
    expect(chartRowFigures(chartTradeView(open!))).toEqual({ value: '50,000.0', sub: 'OPEN' });
    const [, gone] = chartTrades([order('long', s(0)), order('short', s(300), { side: 'short' })]);
    expect(chartRowFigures(chartTradeView(gone!)).sub).toBe('ENDED ELSEWHERE');
  });

  it('says the exit is pending instead of printing a sentence in a figure', () => {
    const [trade] = chartTrades([order('o', s(0)), close('c', s(90), { fillPrice: null })]);
    expect(chartRowFigures(chartTradeView(trade!)).sub).toBe(EXIT_PENDING);
  });

  it('shows the exit alone for a close with no open of the caller\'s', () => {
    const [trade] = chartTrades([close('c', s(0))]);
    expect(chartRowFigures(chartTradeView(trade!))).toEqual({ value: '50,500.0', sub: 'CLOSED' });
  });
});

describe('a timed trade autopilot opened, as a record row', () => {
  const opened = (over: Partial<TimedTrade> = {}) => timed('t', s(0), { origin: 'autopilot', proposalId: 'p1', seconds: 900, ...over });

  it('names autopilot as its source and carries the proposal that is its evidence', () => {
    const view = timedRowView(opened());
    expect(view).toMatchObject({ source: 'Autopilot', proposalId: 'p1', terms: '$10 · 5x · 15m', state: 'TIME UP' });
    expect(view.accessibilityLabel).toMatch(/^Opened by autopilot\. /);
  });

  it('a trade the person called is Predict\'s, with no proposal behind it', () => {
    expect(timedRowView(timed('t', s(0)))).toMatchObject({ source: 'Predict', proposalId: null });
    // A proposal id on a row that does not say autopilot opened it is not offered as evidence.
    expect(timedRowView(timed('t', s(0), { proposalId: 'p1' })).proposalId).toBeNull();
  });

  it('while it runs, it opens its details, where the evidence is, not Predict', () => {
    const view = timedRowView(opened({ status: 'live', closedAt: null, endedBy: null, exitPrice: null }));
    expect(view).toMatchObject({ running: true, state: 'RUNNING', source: 'Autopilot' });
    expect(view.accessibilityLabel).toContain('Open the details.');
    expect(view.accessibilityLabel).not.toContain('Open Predict');
  });

  it('states a running trade as figures with no result, since it has none yet', () => {
    const live = opened({ status: 'live', closedAt: null, endedBy: null, exitPrice: null, result: null, fees: null });
    const facts = runningFacts(live);
    expect(facts.map(([label]) => label)).toEqual(['Opened', 'Closes itself', 'Stake', 'Size', 'Entry']);
    expect(Object.fromEntries(facts)).toMatchObject({ Stake: '$10', Size: '0.001 BTC · 5x', Entry: '50,000.0' });
    expect(facts.flat().join(' ')).not.toMatch(/AUSD|result/i);
  });
});

describe('a setup put to the rule, as a record row', () => {
  const item = (kind: ActivityItem['kind'], over: Partial<ActivityItem> = {}): ActivityItem => ({
    id: 'p1',
    kind,
    asset: 'BTC/USD',
    direction: 'long',
    entry: price('68441.2'),
    size: size('0.01840'),
    at: s(0),
    ...over,
  });

  it('keeps a setup the person put to the rule worded as it always was', () => {
    expect(ruleRowView(item('executed'))).toMatchObject({ source: 'Rule', state: 'Executed', badge: 'Executed', sized: true });
    expect(ruleRowView(item('proposed'))).toMatchObject({ source: 'Rule', state: 'Proposed', badge: 'Proposed', sized: true });
    expect(ruleRowView(item('undone'))).toMatchObject({ source: 'Rule', state: 'Undone', badge: 'Undone', sized: true });
    expect(ruleRowView(item('refused', { refusedBy: 'bos_bullish' }))).toMatchObject({
      source: 'Rule',
      state: 'Blocked by bos_bullish',
      badge: 'Refused',
      accessibilityLabel: 'Refused: BTC/USD long, blocked by bos_bullish. Open evidence.',
    });
  });

  it('words a row autopilot wrote for what happened to it', () => {
    const auto = (kind: ActivityItem['kind'], over: Partial<ActivityItem> = {}) => ruleRowView(item(kind, { origin: 'autopilot', ...over }));
    // Seconds old, so its time gives way to the words that have to be read in full.
    expect(auto('proposed')).toMatchObject({ source: 'Autopilot', state: 'Waiting for the gateway', badge: 'Waiting', dated: false });
    expect(auto('undone')).toMatchObject({ source: 'Autopilot', state: 'Not opened', badge: 'Not opened', dated: true });
    expect(ruleRowView(item('proposed')).dated).toBe(true);
    expect(auto('executed')).toMatchObject({ source: 'Autopilot', state: 'Opened', badge: 'Opened' });
    expect(auto('refused', { refusedBy: 'fvg_present' })).toMatchObject({
      source: 'Autopilot',
      state: 'Blocked by fvg_present',
      badge: 'Refused',
      accessibilityLabel: 'Refused: BTC/USD long, blocked by fvg_present. By autopilot. Open evidence.',
    });
  });

  it("does not show the rule's own sizing as a size traded on a proposal autopilot wrote", () => {
    const auto = (kind: ActivityItem['kind']) => ruleRowView(item(kind, { origin: 'autopilot' })).sized;
    expect(auto('proposed')).toBe(false);
    expect(auto('executed')).toBe(false);
    expect(auto('undone')).toBe(false);
    // A refusal's size is what the rule would have risked, by a press or by autopilot alike.
    expect(auto('refused')).toBe(true);
  });

  it('never words a refusal or a setup that was not opened as a fault', () => {
    for (const kind of ['executed', 'refused', 'proposed', 'undone'] as const) {
      const view = ruleRowView(item(kind, { origin: 'autopilot' }));
      expect(`${view.state} ${view.badge} ${view.accessibilityLabel}`).not.toMatch(/error|failed|sorry|undone|undid/i);
    }
  });
});

describe('a timed trade as a record row', () => {
  it('says how a finished trade ended, with its entry over its exit', () => {
    const view = timedRowView(timed('t', s(0)));
    expect(view).toMatchObject({
      word: 'Up',
      terms: '$10 · 5x · 1m',
      running: false,
      state: 'TIME UP',
      figures: { value: '50,000.0', sub: '→ 50,010.0' },
      at: s(0),
    });
    expect(view.move?.direction).toBe('up');
  });

  it('says a trade is running, and points at Predict', () => {
    const view = timedRowView(timed('t', s(0), { status: 'live', closedAt: null, endedBy: null, exitPrice: null, direction: 'down' }));
    expect(view).toMatchObject({ word: 'Down', running: true, state: 'RUNNING', exit: null, figures: { value: '50,000.0', sub: 'RUNNING' } });
    expect(view.accessibilityLabel).toContain('Open Predict');
  });

  it('says closing while the server is closing it, and pending until the exit is reported', () => {
    expect(timedRowView(timed('t', s(0), { status: 'closing', closedAt: null, exitPrice: null })).state).toBe('CLOSING');
    expect(timedRowView(timed('t', s(0), { exitPrice: null })).figures.sub).toBe(EXIT_PENDING);
  });
});
