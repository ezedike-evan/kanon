import { describe, expect, it } from 'vitest';
import { parseDecimal } from '@kanon/spec';
import {
  accountRisk,
  flagLine,
  formatBpsPercent,
  formatFee,
  formatFundingRate,
  formatFundingYearly,
  formatInterval,
  formatRiskPrice,
  formatUsdWhole,
  fundingDirection,
  liquidationPrice,
  marketRisk,
  marketRisks,
  notionalUsd,
  positionLine,
  positionRisk,
  positionRisks,
  ratioBps,
  readContext,
  readTickers,
  withTickers,
  type RiskMarketTerms,
} from './perpl-risk';
import type { VenuePositionView } from './venue-types';

const NOW = 1_791_740_500_000;

/** Two markets in the shape Perpl's `/v1/pub/context` sent on testnet, 11 October 2026. */
const CONTEXT = {
  chain: {},
  markets: [
    {
      id: 16,
      symbol: 'BTC',
      funding_interval_sec: 2580,
      config: {
        is_open: true,
        price_decimals: 1,
        size_decimals: 5,
        initial_margin: 1500,
        maintenance_margin: 2500,
        maker_fee: 45,
        taker_fee: 345,
      },
      state: {
        at: { b: 70173526, t: NOW - 30_000 },
        orl: 840014,
        mrk: 840326,
        lst: 840041,
        mid: 840137,
        bid: 840087,
        ask: 840187,
        prv: 830656,
        dv: 3413639,
        dva: '2835449242433',
        oi: 2072881,
        tvl: '375826754563',
      },
      funding: { rate: 30, idx: 839085 },
    },
    {
      id: 256,
      symbol: 'eth',
      funding_interval_sec: 3600,
      config: { is_open: false, price_decimals: 2, size_decimals: 3, initial_margin: 1000, maintenance_margin: 2000 },
      state: null,
    },
    // No decimals: it cannot be drawn, so it is left out.
    { id: 300, symbol: 'SOL', config: { is_open: true, maintenance_margin: 2000, initial_margin: 1000 } },
    { id: 301, symbol: 'ZERO', config: { price_decimals: 2, size_decimals: 2, maintenance_margin: 0, initial_margin: 1000 } },
  ],
};

const terms = (): RiskMarketTerms[] => readContext(CONTEXT) ?? [];
const btc = (): RiskMarketTerms => terms()[0]!;

const position = (over: Partial<VenuePositionView> = {}): VenuePositionView => ({
  asset: 'BTC/USD',
  side: 'long',
  size: parseDecimal('1.00000', 5),
  entryPrice: parseDecimal('100000.0', 1),
  leverage: 10,
  collateral: parseDecimal('10000.000000', 6),
  notional: parseDecimal('100000.00', 2),
  openedAt: null,
  ...over,
});

describe('reading what the venue sends', () => {
  it('keeps the markets it can draw and leaves out the ones it cannot', () => {
    const markets = terms();
    expect(markets.map((m) => m.symbol)).toEqual(['BTC', 'ETH']);
    expect(markets[0]).toMatchObject({
      id: 16,
      open: true,
      priceDecimals: 1,
      sizeDecimals: 5,
      maintenance: 2500,
      initial: 1500,
      takerFee: 345,
      makerFee: 45,
      fundingInterval: 2580,
      fundingRate: 30,
    });
    expect(markets[0]?.state).toMatchObject({ mark: 840326, oracle: 840014, prev: 830656, openInterest: 2072881, volume: '2835449242433' });
    expect(markets[1]).toMatchObject({ open: false, state: null, fundingRate: 0, takerFee: 0 });
  });

  it('says a body is not a context instead of drawing nothing from it', () => {
    expect(readContext(null)).toBeNull();
    expect(readContext({ markets: 'no' })).toBeNull();
    expect(readContext({ markets: [] })).toEqual([]);
  });

  it('reads a ticker by market id and takes the fresher state', () => {
    const tickers = readTickers({
      mt: 1,
      d: {
        '16': { at: { t: NOW - 2_000 }, orl: 841000, mrk: 841500, bid: 841400, ask: 841600, prv: 830656, oi: 2072881, dva: '1' },
        '256': { at: { t: NOW - 1_000 }, orl: 300000, mrk: 300100, bid: 300050, ask: 300150 },
        junk: { at: { t: NOW } },
      },
    });
    expect(tickers?.size).toBe(2);
    const merged = withTickers(terms(), tickers);
    expect(merged[0]?.state?.mark).toBe(841500);
    expect(merged[1]?.state?.mark).toBe(300100);
    expect(readTickers({ d: [] })?.size).toBe(0);
    expect(readTickers('x')).toBeNull();
  });

  it('keeps the context state when the ticker is older', () => {
    const old = new Map([[16, { ...btc().state!, at: NOW - 90_000, mark: 1 }]]);
    expect(withTickers(terms(), old)[0]?.state?.mark).toBe(840326);
    expect(withTickers(terms(), null)).toEqual(terms());
  });
});

describe('a market as figures', () => {
  it('states the mark, the gaps and the terms, each from integers', () => {
    const risk = marketRisk(btc(), NOW);
    expect(risk).toMatchObject({
      asset: 'BTC/USD',
      mark: parseDecimal('84032.6', 1),
      oracle: parseDecimal('84001.4', 1),
      // (840326 - 840014) / 840014 = 3.7 basis points
      basisBps: 4,
      // 100 / 840137 = 1.2 basis points
      spreadBps: 1,
      // (840326 - 830656) / 830656 = 116.4 basis points
      dayMoveBps: 116,
      fundingRate: 30,
      // 30 x 31,536,000 / 2580
      fundingYearly: 366_698,
      maintenanceBps: 400,
      maxLeverage: 15,
      takerFee: 345,
      flags: [],
    });
    // 20.72881 BTC at 84,032.6
    expect(risk.openInterestUsd).toEqual({ atoms: '1741895799206', decimals: 6 });
    expect(formatUsdWhole(risk.openInterestUsd!)).toBe('$1,741,896');
    expect(formatUsdWhole(risk.volumeUsd!)).toBe('$2,835,449');
  });

  it('draws a market with no state as terms only', () => {
    const risk = marketRisk(terms()[1]!, NOW);
    expect(risk).toMatchObject({ mark: null, oracle: null, basisBps: null, spreadBps: null, dayMoveBps: null, openInterestUsd: null, at: null });
    expect(risk.flags).toEqual(['closed']);
    expect(risk.maintenanceBps).toBe(500);
  });

  it('flags what is worth a look, with the figure in the sentence', () => {
    const m: RiskMarketTerms = {
      ...btc(),
      fundingRate: -60,
      state: { ...btc().state!, at: NOW - 120_000, bid: 838000, ask: 842000, mark: 845000 },
    };
    const risk = marketRisk(m, NOW);
    expect(risk.flags).toEqual(['stale', 'wide_spread', 'wide_basis', 'crowded_funding']);
    expect(flagLine(risk, 'wide_spread')).toBe("BTC/USD book is 0.48% wide, more than a market order's fee.");
    expect(flagLine(risk, 'wide_basis')).toBe('BTC/USD mark is +0.59% from the oracle.');
    expect(flagLine(risk, 'crowded_funding')).toBe('BTC/USD funding runs at −73.34% a year. Shorts pay longs.');
  });

  it('never calls a market stale before the first clock tick', () => {
    const m: RiskMarketTerms = { ...btc(), state: { ...btc().state!, at: 1 } };
    expect(marketRisk(m, 0).flags).toEqual([]);
  });

  it('lists open markets first and the largest open interest first', () => {
    const small: RiskMarketTerms = { ...btc(), id: 17, symbol: 'SOL', state: { ...btc().state!, openInterest: 5 } };
    expect(marketRisks([terms()[1]!, small, btc()], NOW).map((r) => r.symbol)).toEqual(['BTC', 'SOL', 'ETH']);
  });

  it('gives no ratio when there is nothing to divide by', () => {
    expect(ratioBps(5, 0)).toBeNull();
    expect(ratioBps(-25, 10_000)).toBe(-25);
  });

  it('multiplies a size by a price at any pair of scales', () => {
    expect(notionalUsd('100000', 5, '1000000', 1)).toEqual({ atoms: '100000000000', decimals: 6 });
    // 2 units at 3.50, both whole-number scales: the product is scaled up.
    expect(notionalUsd('2', 0, '350', 2)).toEqual({ atoms: '7000000', decimals: 6 });
  });
});

describe("Perpl's liquidation price", () => {
  it("matches the venue's own example: a 10x long on a 4% market is liquidated 6% down", () => {
    expect(liquidationPrice({ ...position(), maintenance: 2500 })).toEqual(parseDecimal('94000.0', 1));
  });

  it('puts a short the same distance above its entry', () => {
    expect(liquidationPrice({ ...position({ side: 'short' }), maintenance: 2500 })).toEqual(parseDecimal('106000.0', 1));
  });

  it('moves closer as leverage rises and the margin kept grows', () => {
    // 5x on a 5% market: 100000 x (1 + 0.05) - 20000
    expect(liquidationPrice({ ...position({ collateral: parseDecimal('20000.000000', 6) }), maintenance: 2000 })).toEqual(
      parseDecimal('85000.0', 1),
    );
  });

  it('reads a small position at real scales', () => {
    // 0.00074 BTC at 67,120.5 with 9.93 AUSD: 67120.5 x 1.04 - 9.93 / 0.00074
    const liq = liquidationPrice({
      side: 'long',
      size: parseDecimal('0.00074', 5),
      entryPrice: parseDecimal('67120.5', 1),
      collateral: parseDecimal('9.930000', 6),
      maintenance: 2500,
    });
    expect(liq && formatRiskPrice(liq)).toBe('56,386.4');
  });

  it('has none when price alone cannot liquidate, or a figure is missing', () => {
    // Collateral worth more than the position: a fall to zero does not use it up.
    expect(liquidationPrice({ ...position({ collateral: parseDecimal('200000.000000', 6) }), maintenance: 2500 })).toBeNull();
    expect(liquidationPrice({ ...position({ size: parseDecimal('0', 5) }), maintenance: 2500 })).toBeNull();
    expect(liquidationPrice({ ...position(), maintenance: 0 })).toBeNull();
  });
});

describe('a position against its market', () => {
  const marketAt = (mark: number) => marketRisk({ ...btc(), state: { ...btc().state!, mark, oracle: mark, bid: mark - 5, ask: mark + 5 } }, NOW);

  it('is clear at its entry, with the whole way still to go', () => {
    const risk = positionRisk(position(), marketAt(1_000_000), 2500);
    expect(risk).toMatchObject({ distanceBps: 600, usedBps: 0, level: 'clear' });
    expect(risk.liquidation).toEqual(parseDecimal('94000.0', 1));
    expect(risk.exposure).toEqual({ atoms: '100000000000', decimals: 6 });
    expect(positionLine(risk)).toBe('Liquidation at 94,000.0, 6.00% from the mark, before funding.');
  });

  it('is worth watching half of the way there and near at three quarters', () => {
    expect(positionRisk(position(), marketAt(970_000), 2500)).toMatchObject({ usedBps: 5_000, level: 'watch' });
    expect(positionRisk(position(), marketAt(955_000), 2500)).toMatchObject({ usedBps: 7_500, level: 'near' });
  });

  it('reads a short the other way up', () => {
    expect(positionRisk(position({ side: 'short' }), marketAt(1_030_000), 2500)).toMatchObject({ usedBps: 5_000, level: 'watch' });
    expect(positionRisk(position({ side: 'short' }), marketAt(950_000), 2500).usedBps).toBeLessThan(0);
  });

  it('says so when the mark is at or past liquidation', () => {
    const risk = positionRisk(position(), marketAt(930_000), 2500);
    expect(risk).toMatchObject({ distanceBps: 0, level: 'near' });
    expect(positionLine(risk)).toBe('The mark is at or past its liquidation price, 94,000.0.');
  });

  it('goes negative, and stays clear, when the price has moved its way', () => {
    expect(positionRisk(position(), marketAt(1_060_000), 2500)).toMatchObject({ usedBps: -10_000, level: 'clear' });
  });

  it('states only what it knows without a mark or the market terms', () => {
    const noMark = positionRisk(position(), marketRisk(terms()[1]!, NOW), 2500);
    expect(noMark).toMatchObject({ mark: null, exposure: null, distanceBps: null, usedBps: null, level: null });
    expect(positionLine(noMark)).toBe('Liquidation at 94,000.0, before funding.');
    expect(positionRisk(position(), null, null)).toMatchObject({ liquidation: null, level: null });
  });

  it('lists the position nearest liquidation first', () => {
    const markets = [marketAt(960_000)];
    const risks = positionRisks(
      [position({ entryPrice: parseDecimal('97000.0', 1), collateral: parseDecimal('9700.000000', 6) }), position()],
      markets,
      terms(),
    );
    expect(risks.map((r) => r.entryPrice.atoms)).toEqual(['1000000', '970000']);
  });
});

describe('the account', () => {
  it('adds up what is free, what is locked and what the positions are worth at the mark', () => {
    const market = marketRisk(btc(), NOW);
    const risks = positionRisks([position(), position({ side: 'short' })], [market], terms());
    const account = accountRisk(parseDecimal('1099.960000', 6), risks);
    expect(account.free).toEqual(parseDecimal('1099.960000', 6));
    expect(account.locked).toEqual(parseDecimal('20000.000000', 6));
    // Two positions of 1 BTC at 84,032.6
    expect(account.exposure).toEqual(parseDecimal('168065.200000', 6));
    // The long, entered at 100,000, is past its liquidation price; the short has the price on its side.
    expect(account).toMatchObject({ positions: 2, flagged: 1 });
  });

  it('gives no exposure while a position has no mark, and zeros with no positions', () => {
    const risks = positionRisks([position({ asset: 'ETH/USD' })], [marketRisk(terms()[1]!, NOW)], terms());
    expect(accountRisk(parseDecimal('10.00', 2), risks).exposure).toBeNull();
    expect(accountRisk(parseDecimal('10.00', 2), [])).toMatchObject({ positions: 0, flagged: 0, locked: { atoms: '0', decimals: 6 } });
  });
});

describe('figures', () => {
  it('prints rates and fees from millionths without a float', () => {
    expect(formatFundingRate(30)).toBe('+0.0030%');
    expect(formatFundingRate(-125)).toBe('−0.0125%');
    expect(formatFundingYearly(366_698)).toBe('+36.67%');
    expect(formatFee(345)).toBe('0.0345%');
    expect(formatBpsPercent(400)).toBe('4.00%');
    expect(formatBpsPercent(-116, { signed: true })).toBe('−1.16%');
  });

  it('says how often funding is exchanged and who pays', () => {
    expect(formatInterval(2580)).toBe('43m');
    expect(formatInterval(3600)).toBe('1h');
    expect(formatInterval(3900)).toBe('1h 05m');
    expect(formatInterval(0)).toBe('—');
    expect(fundingDirection(30)).toBe('Longs pay shorts');
    expect(fundingDirection(-1)).toBe('Shorts pay longs');
    expect(fundingDirection(0)).toBe('Nobody pays');
  });
});
