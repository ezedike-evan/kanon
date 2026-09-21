/**
 * Kuru execution client: spot, per docs/ARCHITECTURE.md ("Kuru for spot").
 *
 * Re-verified against https://docs.kuru.io and the published
 * `@kuru-labs/kuru-sdk@0.0.95` typings and source on 2026-09-20.
 *
 * The finding that shapes this file: Kuru is not a REST/WebSocket trading
 * gateway. It is an on-chain central limit order book on Monad. Orders are
 * transactions, signed by an `ethers` signer and sent through
 * `@kuru-labs/kuru-sdk`. There is no order-status stream; a fill is read out
 * of the transaction receipt's `Trade` events. Kuru does publish one HTTP
 * surface, the Flow swap-routing aggregator (`KuruFlowClient` below), which
 * is a quote source, not the order-book trading path.
 *
 * Two seams keep this testable without a chain:
 *   - `KuruClient` holds the trading logic (sizing, slippage bound, refusal,
 *     evidence) and talks to a narrow `KuruAdapter`.
 *   - `createKuruSdkAdapter` implements that adapter over the REAL SDK
 *     (`GTC.placeLimit`, `IOC.placeMarket`, `OrderCanceler.cancelOrders`,
 *     `ParamFetcher.getMarketParams`, `OrderBook.getL2OrderBook`,
 *     `MarginBalance.getBalance`) and decodes receipts with the OrderBook ABI
 *     events. Tests inject a fake SDK module and receipts, so the unit
 *     conversions and event decoding are exercised for real; only the
 *     network is faked.
 *
 * Unknown markets are refused with a reason. Kuru's listed markets today are
 * MON-only (MON/AUSD, MON/USDC); this client never guesses a market address
 * for BTC or anything else.
 */

import { ethers } from 'ethers';
import { z } from 'zod';
import type { Decimal, PriceTick } from '@kanon/spec';
import { fromScaled, isPositive, toPlainString, toScaledBigInt } from './scaling';
import type {
  CancelResult,
  ExecutionClient,
  Order,
  OrderResult,
  Position,
  Unsubscribe,
} from './types';

export type KuruNetwork = 'mainnet' | 'testnet';

// ---------------------------------------------------------------------------
// Constants, from docs.kuru.io/contracts/Contract-addresses (2026-09-20)
// ---------------------------------------------------------------------------

export const KURU_NETWORK = {
  mainnet: { chainId: 143, rpcUrl: 'https://rpc.monad.xyz' },
  testnet: { chainId: 10143, rpcUrl: 'https://testnet-rpc.monad.xyz' },
} as const;

export const KURU_CONTRACTS = {
  mainnet: {
    router: '0xd651346d7c789536ebf06dc72aE3C8502cd695CC',
    marginAccount: '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5',
    flowEntrypoint: '0xb3e6778480b2E488385E8205eA05E20060B813cb',
    flowRouter: '0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2',
    forwarder: '0x974E61BBa9C4704E8Bcc1923fdC3527B41323FAA',
    monadDeployer: '0xe29309e308af3EE3B1a414E97c37A58509f27D1E',
  },
  testnet: {
    router: '0x7EFbE105Ca7415dE98F96622173458ac1c054630',
    marginAccount: '0xd029C2D98ff85D8F64799017fE00a59B1159CE02',
    forwarder: '0x681bB1508E14433b148a2549ba2726454aDc9BB4',
  },
} as const;

export const KURU_TOKENS = {
  mainnet: {
    WMON: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
    AUSD: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    USDC: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  },
  testnet: { USDC: '0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570' },
} as const;

/** The only Kuru markets the docs list. MON-denominated: BTC/USD spot is not
 * reachable through Kuru, and this table is never extended by guesswork.
 * Override `KuruClientOptions.markets` only with an address you have verified
 * on-chain. */
export const KURU_MARKETS = {
  mainnet: {
    'MON/AUSD': '0x131a2e70a5b31a517a74b8c567149bc294470da9',
    'MON/USDC': '0x065C9d28E428A0db40191a54d33d5b7c71a9C394',
  },
  testnet: {
    'MON/USDC': '0xa241896A7Dbe8a550D2E5fF7A914bB1989ceD2D9',
  },
} as const;

/** Kuru Flow aggregator. `POST /generate-token` (body `{ user_address }`,
 * unauthenticated, 1 rps token) and `POST /quote` (Bearer JWT or X-API-Key).
 * Sources: docs.kuru.io/api-reference/generate-jwt-token and
 * /api-reference/calculate-best-path-quote, both on `https://ws.kuru.io`. */
export const KURU_FLOW_API_BASE_URL = 'https://ws.kuru.io/api';

// ---------------------------------------------------------------------------
// Adapter seam
// ---------------------------------------------------------------------------

/** Scaling facts for one market, derived from `getMarketParams`. */
export interface KuruMarketInfo {
  /** Decimals of prices as the order book quotes them (log10 of pricePrecision). */
  priceDecimals: number;
  /** Decimals of order sizes (log10 of sizePrecision). */
  sizeDecimals: number;
  baseDecimals: number;
  quoteDecimals: number;
  baseToken: string;
  quoteToken: string;
  /** Minimum and maximum order size, at `sizeDecimals`. */
  minSize: Decimal;
  maxSize: Decimal;
}

export interface KuruFill {
  price: Decimal;
  size: Decimal;
}

export interface KuruTxOutcome {
  transactionHash: string;
  /** Order ids this transaction created for the signer (resting orders). */
  orderIds: string[];
  /** Trades in this transaction where the signer was the taker. */
  fills: KuruFill[];
}

export interface KuruAdapter {
  getMarketInfo(marketAddress: string): Promise<KuruMarketInfo>;
  /** Best bid / ask, as a reference for the slippage bound. */
  getBestBidAsk(marketAddress: string, info: KuruMarketInfo): Promise<{ bid?: Decimal; ask?: Decimal }>;
  placeLimit(args: {
    marketAddress: string;
    info: KuruMarketInfo;
    price: Decimal;
    size: Decimal;
    isBuy: boolean;
    postOnly: boolean;
  }): Promise<KuruTxOutcome>;
  /** Kuru market BUYs are denominated in the QUOTE asset (`size` is quote to
   * spend, at `priceDecimals`); SELLs in the BASE asset (`size` at
   * `sizeDecimals`). `minAmountOut` is base for a buy, quote for a sell. */
  placeMarket(args: {
    marketAddress: string;
    info: KuruMarketInfo;
    isBuy: boolean;
    size: Decimal;
    minAmountOut: Decimal;
    fillOrKill: boolean;
  }): Promise<KuruTxOutcome>;
  cancelOrders(args: { marketAddress: string; orderIds: string[] }): Promise<{ transactionHash: string }>;
  /** The signer's base-asset balance in the margin account. */
  getBaseBalance(marketAddress: string, info: KuruMarketInfo): Promise<Decimal>;
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

/** a * b, rescaled to `targetDecimals` under `mode`. */
export function mulToScale(a: Decimal, b: Decimal, targetDecimals: number, mode: 'floor' | 'ceil'): Decimal {
  const product: Decimal = { atoms: (BigInt(a.atoms) * BigInt(b.atoms)).toString(), decimals: a.decimals + b.decimals };
  return { atoms: toScaledBigInt(product, targetDecimals, mode).toString(), decimals: targetDecimals };
}

/** Volume-weighted average price of fills, at the finest input scale. */
export function vwap(fills: KuruFill[]): { size: Decimal; avgPrice: Decimal } | undefined {
  if (fills.length === 0) return undefined;
  const priceDecimals = Math.max(...fills.map((f) => f.price.decimals));
  const sizeDecimals = Math.max(...fills.map((f) => f.size.decimals));
  let notional = 0n;
  let size = 0n;
  for (const f of fills) {
    const s = toScaledBigInt(f.size, sizeDecimals);
    const p = toScaledBigInt(f.price, priceDecimals);
    notional += s * p;
    size += s;
  }
  if (size === 0n) return undefined;
  return {
    size: { atoms: size.toString(), decimals: sizeDecimals },
    avgPrice: { atoms: (notional / size).toString(), decimals: priceDecimals },
  };
}

function mid(a: Decimal, b: Decimal): Decimal {
  const decimals = Math.max(a.decimals, b.decimals);
  return { atoms: ((toScaledBigInt(a, decimals) + toScaledBigInt(b, decimals)) / 2n).toString(), decimals };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface KuruClientOptions {
  network: KuruNetwork;
  adapter: KuruAdapter;
  /** asset symbol (e.g. "MON/AUSD") -> OrderBook address. Defaults to the
   * documented `KURU_MARKETS[network]`. */
  markets?: Record<string, string>;
  /** Market-order slippage bound in bps when an order carries none. Default
   * 50 (0.5%); it is a visible option, not a hidden constant. */
  defaultMaxSlippageBps?: number;
  /** Polling interval for `subscribeMarketData`: Kuru has no documented
   * market-data stream. Default 5 s (docs/ARCHITECTURE.md: not high frequency). */
  pollIntervalMs?: number;
  now?: () => number;
}

interface RestingOrder {
  marketAddress: string;
  orderIds: string[];
}

export class KuruClient implements ExecutionClient {
  readonly venue = 'kuru' as const;

  private readonly opts: KuruClientOptions;
  private readonly markets: Record<string, string>;
  private readonly now: () => number;
  private readonly infoCache = new Map<string, KuruMarketInfo>();
  private readonly resting = new Map<string, RestingOrder>();
  /** Average cost of what THIS client has bought, per asset. Spot venues
   * report balances, not cost basis, so this is honest only for this
   * client's own fills. */
  private readonly basis = new Map<string, { size: bigint; notional: bigint; sizeDecimals: number; priceDecimals: number }>();

  constructor(opts: KuruClientOptions) {
    this.opts = opts;
    this.markets = opts.markets ?? { ...KURU_MARKETS[opts.network] };
    this.now = opts.now ?? Date.now;
  }

  /** The market address for `asset`, or undefined. Never guesses. */
  marketFor(asset: string): string | undefined {
    return this.markets[asset];
  }

  private reject(clientOrderId: string, reason: string): OrderResult {
    return { venue: this.venue, clientOrderId, status: 'rejected', reason, timestamp: this.now() };
  }

  private async info(marketAddress: string): Promise<KuruMarketInfo> {
    const cached = this.infoCache.get(marketAddress);
    if (cached) return cached;
    const info = await this.opts.adapter.getMarketInfo(marketAddress);
    this.infoCache.set(marketAddress, info);
    return info;
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    const marketAddress = this.marketFor(order.asset);
    if (!marketAddress) {
      return this.reject(
        order.clientOrderId,
        `no known Kuru market for asset "${order.asset}". Kuru's listed markets are MON-denominated (${Object.keys(this.markets).join(', ')}); this client never guesses a market address.`,
      );
    }
    if (order.reduceOnly && order.side === 'buy') {
      // Spot cannot hold a short, so a reduce-only buy has nothing to reduce.
      return this.reject(order.clientOrderId, 'Kuru spot cannot hold a short: a reduce-only buy has nothing to close');
    }
    // A reduce-only SELL on spot is just a sell of inventory: it cannot open
    // anything, so it is honoured as a plain sell and the contract refuses it
    // if the balance is not there.
    if (!isPositive(order.size)) return this.reject(order.clientOrderId, 'order size must be positive');

    try {
      const info = await this.info(marketAddress);
      const isBuy = order.side === 'buy';

      // Sizes round down so precision can never grow an order past what was approved.
      const size: Decimal = { atoms: toScaledBigInt(order.size, info.sizeDecimals, 'floor').toString(), decimals: info.sizeDecimals };
      if (!isPositive(size)) return this.reject(order.clientOrderId, `size is below Kuru's ${info.sizeDecimals}-decimal size precision`);
      if (BigInt(size.atoms) < BigInt(info.minSize.atoms)) {
        return this.reject(order.clientOrderId, `size is below the market minimum (${info.minSize.atoms}e-${info.minSize.decimals})`);
      }
      if (BigInt(size.atoms) > BigInt(info.maxSize.atoms)) {
        return this.reject(order.clientOrderId, `size is above the market maximum (${info.maxSize.atoms}e-${info.maxSize.decimals})`);
      }

      if (order.kind === 'limit') {
        if (!order.price) return this.reject(order.clientOrderId, 'limit order requires a price');
        // Never a worse price than approved: buys round down, sells round up.
        const price: Decimal = {
          atoms: toScaledBigInt(order.price, info.priceDecimals, isBuy ? 'floor' : 'ceil').toString(),
          decimals: info.priceDecimals,
        };
        const outcome = await this.opts.adapter.placeLimit({ marketAddress, info, price, size, isBuy, postOnly: false });
        return this.finish(order, marketAddress, outcome, 'limit');
      }

      const slippage = order.maxSlippageBps ?? this.opts.defaultMaxSlippageBps ?? 50;
      const book = await this.opts.adapter.getBestBidAsk(marketAddress, info);
      const bps = 10_000 - slippage;
      if (slippage < 0 || slippage >= 10_000) return this.reject(order.clientOrderId, `slippage bound ${slippage} bps is out of range`);

      let outcome: KuruTxOutcome;
      if (isBuy) {
        if (!book.ask) return this.reject(order.clientOrderId, 'no ask liquidity to price a market buy against');
        // A Kuru market buy SPENDS an exact quote amount, so size it as
        // base * best ask, and floor the base received at base * (1 - slippage).
        const quote = mulToScale(size, book.ask, info.priceDecimals, 'ceil');
        const minBase: Decimal = {
          atoms: toScaledBigInt({ atoms: ((BigInt(size.atoms) * BigInt(bps)) / 10_000n).toString(), decimals: size.decimals }, info.sizeDecimals, 'floor').toString(),
          decimals: info.sizeDecimals,
        };
        outcome = await this.opts.adapter.placeMarket({ marketAddress, info, isBuy: true, size: quote, minAmountOut: minBase, fillOrKill: true });
      } else {
        if (!book.bid) return this.reject(order.clientOrderId, 'no bid liquidity to price a market sell against');
        const minQuote = mulToScale(size, book.bid, info.priceDecimals, 'floor');
        const floored: Decimal = { atoms: ((BigInt(minQuote.atoms) * BigInt(bps)) / 10_000n).toString(), decimals: minQuote.decimals };
        outcome = await this.opts.adapter.placeMarket({ marketAddress, info, isBuy: false, size, minAmountOut: floored, fillOrKill: true });
      }
      return this.finish(order, marketAddress, outcome, 'market');
    } catch (err) {
      return this.reject(order.clientOrderId, err instanceof Error ? err.message : String(err));
    }
  }

  private finish(
    order: Order,
    marketAddress: string,
    outcome: KuruTxOutcome,
    kind: 'limit' | 'market',
  ): OrderResult {
    const filled = vwap(outcome.fills);
    if (filled) this.recordFill(order.asset, order.side, filled.size, filled.avgPrice);
    if (outcome.orderIds.length > 0) this.resting.set(order.clientOrderId, { marketAddress, orderIds: outcome.orderIds });

    const base = {
      venue: this.venue,
      clientOrderId: order.clientOrderId,
      venueOrderId: outcome.orderIds[0] ?? outcome.transactionHash,
      timestamp: this.now(),
    };
    if (kind === 'market') {
      if (!filled) {
        // The transaction succeeded (a FOK that cannot fill reverts) but no
        // Trade event names the signer as taker: report unknown, not a fill.
        return { ...base, status: 'pending', reason: `transaction ${outcome.transactionHash} succeeded but no Trade event for this signer was decoded` };
      }
      return { ...base, status: 'filled', filledSize: filled.size, avgFillPrice: filled.avgPrice };
    }
    // Limit: a resting order is accepted on-chain but not filled.
    const fullyFilled = filled !== undefined && BigInt(filled.size.atoms) >= BigInt(toScaledBigInt(order.size, filled.size.decimals, 'floor'));
    if (fullyFilled && filled) return { ...base, status: 'filled', filledSize: filled.size, avgFillPrice: filled.avgPrice };
    return { ...base, status: 'pending', filledSize: filled?.size, avgFillPrice: filled?.avgPrice };
  }

  private recordFill(asset: string, side: 'buy' | 'sell', size: Decimal, price: Decimal): void {
    const prior = this.basis.get(asset) ?? { size: 0n, notional: 0n, sizeDecimals: size.decimals, priceDecimals: price.decimals };
    const s = toScaledBigInt(size, prior.sizeDecimals, 'floor');
    const p = toScaledBigInt(price, prior.priceDecimals, 'floor');
    if (side === 'buy') {
      prior.size += s;
      prior.notional += s * p;
    } else if (prior.size > 0n) {
      const sold = s > prior.size ? prior.size : s;
      prior.notional -= (prior.notional * sold) / prior.size;
      prior.size -= sold;
    }
    this.basis.set(asset, prior);
  }

  async cancelOrder(clientOrderId: string): Promise<CancelResult> {
    const rest = this.resting.get(clientOrderId);
    if (!rest) return { clientOrderId, cancelled: false, reason: 'no resting Kuru order recorded for this clientOrderId' };
    try {
      const { transactionHash } = await this.opts.adapter.cancelOrders(rest);
      this.resting.delete(clientOrderId);
      return { clientOrderId, venueOrderId: rest.orderIds[0], cancelled: true, reason: `cancel confirmed in ${transactionHash}` };
    } catch (err) {
      return { clientOrderId, venueOrderId: rest.orderIds[0], cancelled: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async getPosition(asset: string): Promise<Position | null> {
    const marketAddress = this.marketFor(asset);
    if (!marketAddress) return null;
    const info = await this.info(marketAddress);
    const balance = await this.opts.adapter.getBaseBalance(marketAddress, info);
    if (BigInt(balance.atoms) === 0n) return null;
    const b = this.basis.get(asset);
    const entryPrice: Decimal | undefined =
      b && b.size > 0n ? { atoms: (b.notional / b.size).toString(), decimals: b.priceDecimals } : undefined;
    return { venue: this.venue, asset, size: balance, entryPrice };
  }

  subscribeMarketData(asset: string, onTick: (tick: PriceTick) => void): Unsubscribe {
    const marketAddress = this.marketFor(asset);
    if (!marketAddress) return () => {};
    const timer = setInterval(() => {
      void (async () => {
        try {
          const info = await this.info(marketAddress);
          const book = await this.opts.adapter.getBestBidAsk(marketAddress, info);
          if (!book.bid || !book.ask) return;
          onTick({ timestamp: Math.floor(this.now() / 1000), price: mid(book.bid, book.ask) });
        } catch {
          // A failed poll is not fatal; the next interval retries.
        }
      })();
    }, this.opts.pollIntervalMs ?? 5000);
    return () => clearInterval(timer);
  }
}

// ---------------------------------------------------------------------------
// The real SDK adapter
// ---------------------------------------------------------------------------

export type KuruSdkModule = typeof import('@kuru-labs/kuru-sdk');

const KURU_EVENTS = new ethers.utils.Interface([
  'event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)',
  'event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)',
]);

/** Trade events carry price as an 18-decimal fixed-point value (the SDK's own
 * `reconcileTradeEvent` formats it with `formatUnits(price, 18)`). */
export const KURU_TRADE_PRICE_DECIMALS = 18;

/** Decodes a receipt into the signer's created order ids and taker fills. */
export function decodeKuruReceipt(
  receipt: { transactionHash: string; logs: Array<{ address: string; topics: string[]; data: string }> },
  marketAddress: string,
  signerAddress: string,
  info: KuruMarketInfo,
): KuruTxOutcome {
  const orderIds: string[] = [];
  const fills: KuruFill[] = [];
  const market = marketAddress.toLowerCase();
  const me = signerAddress.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== market) continue;
    let parsed: ethers.utils.LogDescription;
    try {
      parsed = KURU_EVENTS.parseLog(log);
    } catch {
      continue; // an event this decoder does not model
    }
    if (parsed.name === 'OrderCreated' && String(parsed.args.owner).toLowerCase() === me) {
      orderIds.push(parsed.args.orderId.toString());
    }
    if (parsed.name === 'Trade' && String(parsed.args.takerAddress).toLowerCase() === me) {
      fills.push({
        price: fromScaled(parsed.args.price.toString(), KURU_TRADE_PRICE_DECIMALS),
        size: fromScaled(parsed.args.filledSize.toString(), info.sizeDecimals),
      });
    }
  }
  return { transactionHash: receipt.transactionHash, orderIds, fills };
}

export interface KuruSdkAdapterDeps {
  sdk: KuruSdkModule;
  provider: ethers.providers.JsonRpcProvider;
  signer: ethers.Signer;
  marginAccountAddress: string;
  /** Trade against margin-account balances (default true: this is the AUSD
   * margin flow the Agora bounty asks for). When false the SDK approves and
   * spends wallet tokens directly. */
  useMargin?: boolean;
}

function log10Precision(precision: ethers.BigNumber): number {
  return precision.toString().length - 1;
}

export function createKuruSdkAdapter(deps: KuruSdkAdapterDeps): KuruAdapter {
  const { sdk, provider, signer } = deps;
  const useMargin = deps.useMargin ?? true;
  const params = new Map<string, Awaited<ReturnType<typeof sdk.ParamFetcher.getMarketParams>>>();

  async function marketParams(marketAddress: string) {
    let p = params.get(marketAddress);
    if (!p) {
      p = await sdk.ParamFetcher.getMarketParams(provider, marketAddress);
      params.set(marketAddress, p);
    }
    return p;
  }

  return {
    async getMarketInfo(marketAddress) {
      const p = await marketParams(marketAddress);
      const sizeDecimals = log10Precision(p.sizePrecision);
      return {
        priceDecimals: log10Precision(p.pricePrecision),
        sizeDecimals,
        baseDecimals: p.baseAssetDecimals.toNumber(),
        quoteDecimals: p.quoteAssetDecimals.toNumber(),
        baseToken: p.baseAssetAddress,
        quoteToken: p.quoteAssetAddress,
        minSize: fromScaled(p.minSize.toString(), sizeDecimals),
        maxSize: fromScaled(p.maxSize.toString(), sizeDecimals),
      };
    },

    async getBestBidAsk(marketAddress, info) {
      const book = await sdk.OrderBook.getL2OrderBook(provider, marketAddress, await marketParams(marketAddress));
      // The SDK returns L2 prices as JS floats. They are only a reference for
      // the slippage bound; re-quantised to the market's decimals here and
      // never used for settlement arithmetic.
      const toDecimal = (n: number): Decimal => ({
        atoms: n.toFixed(info.priceDecimals).replace('.', '').replace(/^0+(?=\d)/, ''),
        decimals: info.priceDecimals,
      });
      const bids = book.bids.map((l) => l[0]).filter((n): n is number => typeof n === 'number' && n > 0);
      const asks = book.asks.map((l) => l[0]).filter((n): n is number => typeof n === 'number' && n > 0);
      return {
        ...(bids.length > 0 ? { bid: toDecimal(Math.max(...bids)) } : {}),
        ...(asks.length > 0 ? { ask: toDecimal(Math.min(...asks)) } : {}),
      };
    },

    async placeLimit({ marketAddress, info, price, size, isBuy, postOnly }) {
      const receipt = await sdk.GTC.placeLimit(signer, marketAddress, await marketParams(marketAddress), {
        price: toPlainString(price),
        size: toPlainString(size),
        isBuy,
        postOnly,
      });
      return decodeKuruReceipt(receipt, marketAddress, await signer.getAddress(), info);
    },

    async placeMarket({ marketAddress, info, isBuy, size, minAmountOut, fillOrKill }) {
      const receipt = await sdk.IOC.placeMarket(signer, marketAddress, await marketParams(marketAddress), {
        approveTokens: !useMargin,
        isBuy,
        size: toPlainString(size),
        minAmountOut: toPlainString(minAmountOut),
        isMargin: useMargin,
        fillOrKill,
      });
      return decodeKuruReceipt(receipt, marketAddress, await signer.getAddress(), info);
    },

    async cancelOrders({ marketAddress, orderIds }) {
      const receipt = await sdk.OrderCanceler.cancelOrders(
        signer,
        marketAddress,
        orderIds.map((id) => ethers.BigNumber.from(id)),
      );
      return { transactionHash: receipt.transactionHash };
    },

    async getBaseBalance(_marketAddress, info) {
      const balance = await sdk.MarginBalance.getBalance(
        provider,
        deps.marginAccountAddress,
        await signer.getAddress(),
        info.baseToken,
      );
      return fromScaled(balance.toString(), info.baseDecimals);
    },
  };
}

/** Loads the SDK lazily so importing this package never pulls in ethers v5
 * providers unless a live Kuru client is actually built. */
export async function loadKuruSdk(): Promise<KuruSdkModule> {
  const mod = (await import('@kuru-labs/kuru-sdk')) as unknown as Partial<KuruSdkModule> & { default?: KuruSdkModule };
  return (mod.GTC ? mod : mod.default) as KuruSdkModule;
}

export interface KuruLiveOptions {
  network: KuruNetwork;
  /** 0x-prefixed 32-byte EVM private key. Never logged. */
  privateKey: string;
  rpcUrl?: string;
  markets?: Record<string, string>;
  marginAccountAddress?: string;
  useMargin?: boolean;
  defaultMaxSlippageBps?: number;
  pollIntervalMs?: number;
}

/** Builds a `KuruClient` over the real SDK, an ethers v5 provider and a
 * wallet. Nothing here runs at import time; nothing is sent until an order is
 * placed. */
export async function createKuruLiveClient(opts: KuruLiveOptions): Promise<KuruClient> {
  const sdk = await loadKuruSdk();
  const provider = new ethers.providers.JsonRpcProvider(opts.rpcUrl ?? KURU_NETWORK[opts.network].rpcUrl);
  const signer = new ethers.Wallet(opts.privateKey, provider);
  const adapter = createKuruSdkAdapter({
    sdk,
    provider,
    signer,
    marginAccountAddress: opts.marginAccountAddress ?? KURU_CONTRACTS[opts.network].marginAccount,
    ...(opts.useMargin !== undefined ? { useMargin: opts.useMargin } : {}),
  });
  return new KuruClient({
    network: opts.network,
    adapter,
    ...(opts.markets ? { markets: opts.markets } : {}),
    ...(opts.defaultMaxSlippageBps !== undefined ? { defaultMaxSlippageBps: opts.defaultMaxSlippageBps } : {}),
    ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
  });
}

// ---------------------------------------------------------------------------
// Kuru Flow (HTTP quote source)
// ---------------------------------------------------------------------------

const TokenResponseSchema = z.looseObject({ token: z.string().min(1), expires_at: z.number().optional() });
const QuoteResponseSchema = z.looseObject({
  type: z.string().optional(),
  status: z.string().optional(),
  /** Output amount in the output token's smallest unit, as a base-10 string. */
  output: z.string().regex(/^\d+$/),
});

export interface KuruFlowQuote {
  /** Output amount atoms (the token's own decimals; not a Kanon Decimal). */
  output: string;
  raw: unknown;
}

/** `https://ws.kuru.io/api` quotes. A real HTTP call, unlike order
 * placement. Exercised only against a mocked `fetch` here. */
export class KuruFlowClient {
  private token: { value: string; expiresAt: number } | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(opts: { fetchImpl?: typeof fetch; baseUrl?: string; now?: () => number } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? KURU_FLOW_API_BASE_URL;
    this.now = opts.now ?? Date.now;
  }

  private async jwt(userAddress: string): Promise<string> {
    if (this.token && this.token.expiresAt * 1000 > this.now() + 5_000) return this.token.value;
    const res = await this.fetchImpl(`${this.baseUrl}/generate-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_address: userAddress }),
    });
    if (!res.ok) throw new Error(`Kuru Flow generate-token failed: HTTP ${res.status}`);
    const parsed = TokenResponseSchema.parse(await res.json());
    this.token = { value: parsed.token, expiresAt: parsed.expires_at ?? Math.floor(this.now() / 1000) + 60 };
    return parsed.token;
  }

  async quote(params: {
    userAddress: string;
    tokenIn: string;
    tokenOut: string;
    /** Input amount atoms, base-10 string. */
    amount: string;
    slippageBps?: number;
  }): Promise<KuruFlowQuote> {
    const token = await this.jwt(params.userAddress);
    const res = await this.fetchImpl(`${this.baseUrl}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userAddress: params.userAddress,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amount: params.amount,
        // Either autoSlippage or an explicit tolerance is required; an
        // explicit bps value always wins so nothing is chosen for the caller.
        ...(params.slippageBps !== undefined
          ? { slippageTolerance: params.slippageBps, autoSlippage: false }
          : { autoSlippage: true }),
      }),
    });
    if (!res.ok) throw new Error(`Kuru Flow quote failed: HTTP ${res.status}`);
    const raw = await res.json();
    return { output: QuoteResponseSchema.parse(raw).output, raw };
  }
}
