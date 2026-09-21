import { describe, expect, it } from 'vitest';
import { parseDecimal, type MarketDirection } from '@kanon/spec';
import { CROSSED_MESSAGE, STALE_MESSAGE, type MarketAvailability } from './market-client';
import {
  DEFAULT_STAKE_INDEX,
  NO_FILTER,
  advanceIndex,
  assetCode,
  assetOptions,
  displayPrice,
  distanceLabel,
  dollars,
  effectivePhase,
  filterMarkets,
  indexOfItem,
  isPriceStale,
  nextTimeframe,
  outcomeCopy,
  pageState,
  positionLines,
  questionParts,
  questionText,
  reelItems,
  settleTerms,
  sideCopy,
  splitFigures,
  stakeAt,
  stakeChoices,
  timeframeOptions,
  trimDecimal,
  windowLength,
  windowPhrase,
  windowRemaining,
} from './predict-reel';
import { STAKE_PRESETS, type PredictMarket } from './predict-types';

const NOW = 1_800_000_000;
const d = (v: string, decimals = 2) => parseDecimal(v, decimals);
const READY: MarketAvailability = { state: 'ready' };
const HASH = `0x${'7f'.repeat(32)}`;

const market = (over: Partial<PredictMarket> = {}): PredictMarket => ({
  id: 'm1',
  asset: 'BTC/USD',
  assetClass: 'CRYPTO',
  timeframe: '1H',
  direction: 'above',
  target: d('81200.00'),
  price: d('80800.00'),
  priceAt: NOW - 30,
  windowStart: NOW - 600,
  windowEnd: NOW + 3_000,
  status: 'open',
  crossed: null,
  terms: null,
  termsHash: HASH,
  settlement: null,
  positions: [],
  chain: null,
  demo: false,
  ...over,
});

describe('words for prices and windows', () => {
  it('trims the zeros a fixed-decimals price carries, and only those', () => {
    expect(trimDecimal(d('81200.00'))).toBe('81,200');
    expect(trimDecimal(d('3412.50'))).toBe('3,412.5');
    expect(trimDecimal(d('100.00'))).toBe('100');
    expect(trimDecimal(d('0.03420', 5))).toBe('0.0342');
    expect(trimDecimal(d('7', 0))).toBe('7');
    expect(dollars(d('130.00'))).toBe('$130');
  });

  it('rounds a live price to a readable width without a float', () => {
    expect(displayPrice(d('81204.12345678', 8))).toBe('81,204.12');
    expect(displayPrice(d('81204.12999999', 8))).toBe('81,204.13');
    expect(displayPrice(d('135.4231', 4))).toBe('135.42');
    expect(displayPrice(d('3.14159', 5))).toBe('3.142');
    expect(displayPrice(d('0.034215', 6))).toBe('0.03422');
    expect(displayPrice(d('9.99999', 5))).toBe('10.000');
  });

  it('says a window as a person would', () => {
    expect(windowPhrase(3_600)).toBe('1 hour');
    expect(windowPhrase(14_400)).toBe('4 hours');
    expect(windowPhrase(86_400)).toBe('24 hours');
    expect(windowPhrase(172_800)).toBe('2 days');
    expect(windowPhrase(900)).toBe('15 minutes');
    expect(windowPhrase(60)).toBe('1 minute');
  });

  it('takes the window from the label before the clock', () => {
    expect(windowLength(market({ timeframe: '4H' }))).toBe(14_400);
    // A demo card's clock is the time left, not the window.
    expect(windowLength(market({ timeframe: '1H', windowStart: NOW, windowEnd: NOW + 100 }))).toBe(3_600);
    expect(windowLength(market({ timeframe: '7D', windowStart: NOW, windowEnd: NOW + 500 }))).toBe(500);
  });
});

describe('the question', () => {
  it('asks whether the price reaches the level, with the figure in mono', () => {
    const parts = questionParts(market());
    expect(parts.map((p) => p.text).join('')).toBe('Will BTC reach $81,200 within\u00A01\u00A0hour?');
    expect(questionText(market())).toBe('Will BTC reach $81,200 within 1 hour?');
    expect(parts.filter((p) => p.mono).map((p) => p.text)).toEqual(['$81,200']);
  });

  it('words a market below as a fall', () => {
    const below = market({ direction: 'below', target: d('79100.00'), timeframe: '4H', asset: 'ETH/USD' });
    expect(questionText(below)).toBe('Will ETH fall to $79,100 within 4 hours?');
  });

  it('never words the question as a buy or a sell', () => {
    for (const direction of ['above', 'below'] as MarketDirection[]) {
      const m = market({ direction });
      const words = [questionText(m), sideCopy(m, 'above').claim, sideCopy(m, 'below').claim, sideCopy(m, 'above').wins]
        .join(' ')
        .toLowerCase();
      expect(words).not.toMatch(/\b(buy|sell|long|short)\b/);
    }
  });

  it('gives each side its own claim, on either direction', () => {
    const up = market({ direction: 'above' });
    expect(sideCopy(up, 'above')).toMatchObject({ label: 'UP', claim: 'Reaches $81,200' });
    expect(sideCopy(up, 'below')).toMatchObject({ label: 'DOWN', claim: 'Stays below $81,200' });
    expect(sideCopy(up, 'below').wins).toBe('Wins if BTC never touches $81,200 in the window.');
    const down = market({ direction: 'below', target: d('79100.00') });
    expect(sideCopy(down, 'below')).toMatchObject({ label: 'DOWN', claim: 'Falls to $79,100' });
    expect(sideCopy(down, 'above')).toMatchObject({ label: 'UP', claim: 'Stays above $79,100' });
    expect(sideCopy(down, 'below').wins).toBe('Wins if BTC touches $79,100 at any point in the window.');
  });

  it('shows the asset code without its quote', () => {
    expect(assetCode('SOL/USD')).toBe('SOL');
    expect(assetCode('MON')).toBe('MON');
  });
});

describe('where a page stands', () => {
  it('is open inside the window and lets a side be taken', () => {
    const s = pageState({ market: market(), nowSeconds: NOW, crossedOnChain: false, availability: READY });
    expect(s).toEqual({ phase: 'open', showSides: true, canStake: true, note: null });
  });

  it('closes a crossed market with a neutral note, from the backend or from the contract', () => {
    const fromRow = pageState({
      market: market({ crossed: { price: d('81200.00'), at: NOW - 100 } }),
      nowSeconds: NOW,
      crossedOnChain: false,
      availability: READY,
    });
    expect(fromRow).toMatchObject({ phase: 'crossed', showSides: false, canStake: false });
    expect(fromRow.note).toEqual({ kind: 'crossed', text: CROSSED_MESSAGE });
    const fromChain = pageState({ market: market(), nowSeconds: NOW, crossedOnChain: true, availability: READY });
    expect(fromChain.phase).toBe('crossed');
    expect(effectivePhase(market(), NOW, true)).toBe('crossed');
  });

  it('does not let the contract reopen a market whose window is over', () => {
    expect(effectivePhase(market({ windowEnd: NOW - 1 }), NOW, true)).toBe('expired');
  });

  it('says an ended window is waiting, not broken', () => {
    const s = pageState({
      market: market({ windowEnd: NOW - 5 }),
      nowSeconds: NOW,
      crossedOnChain: false,
      availability: READY,
    });
    expect(s.phase).toBe('expired');
    expect(s.showSides).toBe(false);
    expect(s.note?.kind).toBe('expired');
  });

  it('waits for a fresh price rather than staking on a stale one', () => {
    const missing = pageState({
      market: market({ price: null, priceAt: null }),
      nowSeconds: NOW,
      crossedOnChain: false,
      availability: READY,
    });
    expect(missing).toMatchObject({ showSides: true, canStake: false });
    expect(missing.note).toEqual({ kind: 'stale', text: STALE_MESSAGE });
    expect(isPriceStale(market({ priceAt: NOW - 7_201 }), NOW)).toBe(true);
    expect(isPriceStale(market({ priceAt: NOW - 7_200 }), NOW)).toBe(false);
    expect(isPriceStale(market({ demo: true, price: null, priceAt: null }), NOW)).toBe(false);
  });

  it('states that staking is not deployed as a plain note, with the sides still shown', () => {
    const notDeployed: MarketAvailability = { state: 'not_deployed', message: 'Not deployed on this network yet.' };
    const s = pageState({ market: market(), nowSeconds: NOW, crossedOnChain: false, availability: notDeployed });
    expect(s).toMatchObject({ phase: 'open', showSides: true, canStake: false });
    expect(s.note).toEqual({ kind: 'unavailable', text: 'Not deployed on this network yet.' });
  });

  it('leaves a demo card without a repeating note', () => {
    const demo: MarketAvailability = { state: 'demo', message: 'Demo data. Sign in to take a side.' };
    const s = pageState({ market: market({ demo: true }), nowSeconds: NOW, crossedOnChain: false, availability: demo });
    expect(s).toEqual({ phase: 'open', showSides: true, canStake: true, note: null });
  });

  it('has no sides and no note once a result is in', () => {
    const settled = market({ status: 'settled' });
    expect(pageState({ market: settled, nowSeconds: NOW, crossedOnChain: false, availability: READY })).toEqual({
      phase: 'settled',
      showSides: false,
      canStake: false,
      note: null,
    });
  });

  it('counts the ring down continuously and holds an upcoming window full', () => {
    const m = market({ windowStart: 1_000, windowEnd: 5_000 });
    expect(windowRemaining(m, 1_000)).toBe(1);
    expect(windowRemaining(m, 3_000)).toBe(0.5);
    expect(windowRemaining(m, 3_001)).toBeCloseTo(0.49975, 5);
    expect(windowRemaining(m, 5_000)).toBe(0);
    expect(windowRemaining(m, 9_000)).toBe(0);
    expect(windowRemaining(m, 0)).toBe(1);
    expect(windowRemaining(market({ windowStart: 5, windowEnd: 5 }), 5)).toBe(0);
  });
});

describe('a settled page', () => {
  const settlement = (over: Partial<NonNullable<PredictMarket['settlement']>>) => ({
    outcome: 'hit' as const,
    decidingPrice: d('81200.00'),
    decidingAt: NOW - 900,
    windowExtreme: { price: d('81200.00'), at: NOW - 900 },
    evidenceHash: HASH,
    recordedCandles: 4,
    settledAt: NOW,
    ...over,
  });

  it('states a hit plainly, with the price that decided it', () => {
    const c = outcomeCopy(market({ status: 'settled', settlement: settlement({}) }));
    expect(c.headline).toBe('Yes. BTC reached $81,200.');
    expect(c).toMatchObject({ hit: true, figureLabel: 'Deciding price', figure: d('81200.00') });
  });

  it('states a miss as a result, with how close it came', () => {
    const c = outcomeCopy(
      market({
        status: 'settled',
        settlement: settlement({ outcome: 'miss', decidingPrice: null, decidingAt: null, windowExtreme: { price: d('81050.00'), at: NOW } }),
      }),
    );
    expect(c.headline).toBe('No. BTC did not reach $81,200.');
    expect(c).toMatchObject({ hit: false, figureLabel: 'Window high', figure: d('81050.00') });
    const down = outcomeCopy(
      market({
        direction: 'below',
        target: d('79100.00'),
        status: 'settled',
        settlement: settlement({ outcome: 'miss', decidingPrice: null, windowExtreme: { price: d('79200.00'), at: NOW } }),
      }),
    );
    expect(down.headline).toBe('No. BTC did not fall to $79,100.');
    expect(down.figureLabel).toBe('Window low');
  });

  it('refunds and says so when nothing was recorded', () => {
    const c = outcomeCopy(market({ status: 'unresolvable', settlement: settlement({ outcome: 'unresolvable', decidingPrice: null }) }));
    expect(c).toMatchObject({ headline: 'No result. Stakes are refunded.', figure: null, hit: null });
    expect(outcomeCopy(market({ status: 'settled', settlement: null })).figure).toBeNull();
  });

  it('lists the stakes a person holds, one line each', () => {
    const lines = positionLines(
      [
        { side: 'above', stake: { atoms: '50000000000000000', decimals: 18 }, result: 'won', txHash: null },
        { side: 'below', stake: null, result: null, txHash: null },
      ],
      'MON',
    );
    expect(lines).toEqual(['UP · 0.05 MON · WON', 'DOWN · OPEN']);
  });

  it('gives the distance from the price to the level, signed', () => {
    // 81,200 against 80,800 is 49.5 bps: truncated toward zero, as the spec does.
    expect(distanceLabel(market())).toBe('+0.49%');
    expect(distanceLabel(market({ direction: 'below', target: d('80000.00') }))).toBe('−0.99%');
    expect(distanceLabel(market({ price: null }))).toBeNull();
  });

  it('lists the terms of a market, and every parameter it was built with', () => {
    expect(settleTerms(market())).toEqual([
      ['Level', '$81,200'],
      ['Window', '1 hour'],
      ['Touching counts', 'Yes'],
    ]);
    const withTerms = market({
      terms: {
        offsetBps: 50,
        distanceBps: 50,
        significantDigits: 5,
        referencePrice: d('80800.00'),
        referenceAt: NOW - 60,
        windowSeconds: 3_600,
        bucketSeconds: 900,
        feedId: `0x${'ab'.repeat(32)}`,
      },
    });
    expect(settleTerms(withTerms)).toEqual([
      ['Level', '$81,200'],
      ['Window', '1 hour'],
      ['Candle', '15M'],
      ['Built from', '$80,800 (+0.50%)'],
      ['Touching counts', 'Yes'],
    ]);
  });
});

describe('figures in a sentence', () => {
  it('sets each price apart and leaves the words alone', () => {
    expect(splitFigures('Yes. ETH reached $3,438.7.')).toEqual([
      { text: 'Yes. ETH reached ', mono: false },
      { text: '$3,438.7', mono: true },
      { text: '.', mono: false },
    ]);
    expect(splitFigures('No result. Stakes are refunded.')).toEqual([{ text: 'No result. Stakes are refunded.', mono: false }]);
    expect(splitFigures('$81,200 then $79,100').filter((p) => p.mono).map((p) => p.text)).toEqual(['$81,200', '$79,100']);
    expect(splitFigures('')).toEqual([]);
  });
});

describe('which pages there are', () => {
  const feed = [
    market({ id: 'a', asset: 'SOL/USD', timeframe: '1H' }),
    market({ id: 'b', asset: 'BTC/USD', timeframe: '1D' }),
    market({ id: 'c', asset: 'BTC/USD', timeframe: '4H' }),
    market({ id: 'd', asset: 'AVAX/USD', timeframe: '1H' }),
    market({ id: 'e', asset: 'MON/USD', timeframe: '1H' }),
  ];

  it('offers only assets that are present and have a Pyth feed, in the app order', () => {
    expect(assetOptions(feed)).toEqual(['BTC', 'SOL', 'MON']);
    expect(assetOptions([])).toEqual([]);
  });

  it('never shows AVAX, whatever the backend sent', () => {
    expect(filterMarkets(feed, NO_FILTER).map((m) => m.id)).toEqual(['a', 'b', 'c', 'e']);
    expect(filterMarkets(feed, { asset: 'AVAX', timeframe: null })).toEqual([]);
  });

  it('filters by asset and by window together', () => {
    expect(filterMarkets(feed, { asset: 'BTC', timeframe: null }).map((m) => m.id)).toEqual(['b', 'c']);
    expect(filterMarkets(feed, { asset: 'BTC', timeframe: '4H' }).map((m) => m.id)).toEqual(['c']);
    expect(filterMarkets(feed, { asset: null, timeframe: '1H' }).map((m) => m.id)).toEqual(['a', 'e']);
    expect(filterMarkets(feed, { asset: 'ETH', timeframe: null })).toEqual([]);
  });

  it('orders windows shortest first and cycles the chip through them and back to any', () => {
    const options = timeframeOptions(feed);
    expect(options).toEqual(['1H', '4H', '1D']);
    expect(nextTimeframe(null, options)).toBe('1H');
    expect(nextTimeframe('1H', options)).toBe('4H');
    expect(nextTimeframe('4H', options)).toBe('1D');
    expect(nextTimeframe('1D', options)).toBeNull();
    expect(nextTimeframe('9Z', options)).toBeNull();
    expect(nextTimeframe(null, [])).toBeNull();
  });

  it('makes one page per market and a closing page, and nothing for an empty feed', () => {
    const items = reelItems(feed.slice(0, 2));
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'end']);
    expect(items[2]?.kind).toBe('end');
    expect(reelItems([])).toEqual([]);
    expect(indexOfItem(items, 'b')).toBe(1);
    expect(indexOfItem(items, 'zzz')).toBe(-1);
  });

  it('moves on to the next page after a stake and never past the last', () => {
    expect(advanceIndex(0, 4)).toBe(1);
    expect(advanceIndex(2, 4)).toBe(3);
    expect(advanceIndex(3, 4)).toBe(3);
    expect(advanceIndex(0, 1)).toBe(0);
    expect(advanceIndex(0, 0)).toBe(0);
  });
});

describe('stakes', () => {
  it('offers the three presets, labelled to two places', () => {
    expect(stakeChoices(STAKE_PRESETS).map((c) => c.label)).toEqual(['0.01', '0.05', '0.10']);
    expect(stakeChoices(STAKE_PRESETS).map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('starts on the smallest stake, so no amount is a default the person did not see', () => {
    expect(DEFAULT_STAKE_INDEX).toBe(0);
    expect(stakeAt(STAKE_PRESETS, DEFAULT_STAKE_INDEX)).toBe(STAKE_PRESETS[0]);
  });

  it('clamps an out-of-range choice into the presets', () => {
    expect(stakeAt(STAKE_PRESETS, 99)).toBe(STAKE_PRESETS[2]);
    expect(stakeAt(STAKE_PRESETS, -3)).toBe(STAKE_PRESETS[0]);
    expect(stakeAt(STAKE_PRESETS, 1.7)).toBe(STAKE_PRESETS[1]);
    expect(stakeAt([], 0)).toBeNull();
  });
});
