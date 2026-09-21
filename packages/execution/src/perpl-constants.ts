/**
 * Perpl constants, every one sourced from
 * https://github.com/PerplFoundation/api-docs (README.md, websocket.md,
 * types.md) on 2026-09-20. Nothing here is guessed.
 */

export type PerplNetwork = 'mainnet' | 'testnet';

/** REST base URLs. Note they include the "/api" segment; request signing
 * uses the path WITHOUT it (see perpl-auth.ts). */
export const PERPL_REST_BASE_URL = {
  mainnet: 'https://app.perpl.xyz/api',
  testnet: 'https://testnet.perpl.xyz/api',
} as const;

export const PERPL_WS_URL = {
  mainnet: { marketData: 'wss://app.perpl.xyz/ws/v1/market-data', trading: 'wss://app.perpl.xyz/ws/v1/trading' },
  testnet: {
    marketData: 'wss://testnet.perpl.xyz/ws/v1/market-data',
    trading: 'wss://testnet.perpl.xyz/ws/v1/trading',
  },
} as const;

export const PERPL_CHAIN_ID = { mainnet: 143, testnet: 10143 } as const;

export const PERPL_RPC_URL = {
  mainnet: 'https://rpc.monad.xyz',
  testnet: 'https://testnet-rpc.monad.xyz',
} as const;

/** The Exchange contract, target of the on-chain `createAccount` and
 * `allowOrderForwarding(true)` calls (README "API Auth vs Smart Contract
 * Account"). The live address should still be read from
 * `GET /v1/pub/context` / the account-creation info endpoint at runtime. */
export const PERPL_EXCHANGE_ADDRESS = {
  mainnet: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F',
  testnet: '0x1964c32f0be608e7d29302aff5e61268e72080cc',
} as const;

export const PERPL_COLLATERAL_TOKEN = {
  mainnet: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', // AUSD
  testnet: '0xdf5b718d8fcc173335185a2a1513ee8151e3c027', // USD
} as const;

/** Full market_id table. Ids differ between networks. Price and size
 * DECIMALS are deliberately not here: they are per-market and are read from
 * `GET /v1/pub/context` (`markets[].config.price_decimals` / `size_decimals`)
 * by `PerplMarketRegistry`, never assumed. */
export const PERPL_MARKET_IDS = {
  mainnet: { BTC: 1, MON: 10, ETH: 20, SOL: 31, HYPE: 40, ZEC: 50 },
  testnet: { BTC: 16, ETH: 32, SOL: 48, MON: 64, ZEC: 256 },
} as const satisfies Record<PerplNetwork, Record<string, number>>;

/** WebSocket message types used by this client (websocket.md). */
export const PERPL_MT = {
  subscribe: 5,
  subscribeAck: 6,
  marketStateUpdate: 9,
  walletSnapshot: 19,
  accountUpdate: 21,
  command: 22, // place / change / cancel an order
  commandAck: 3, // StatusResponse: code 0 = accepted for forwarding, NOT filled
  orderUpdate: 24,
  fillUpdate: 25,
  positionUpdate: 27,
  apiKeySignIn: 29,
  tradesSnapshot: 17,
  tradesUpdate: 18,
  heartbeat: 100,
} as const;

/** `t` on an mt:22 frame. */
export const PERPL_ORDER_TYPE = {
  openLong: 1,
  openShort: 2,
  closeLong: 3,
  closeShort: 4,
  cancel: 5,
  increaseCollateral: 6,
  change: 7,
} as const;

/** `fl` bitmask values. */
export const PERPL_FLAG = { gtc: 0, postOnly: 1, fok: 2, ioc: 4 } as const;

/** `tpc` trigger price condition for stop / take-profit orders. Perpl
 * evaluates triggers against the MARK price (docs.perpl.xyz/exchange/order-types),
 * so the Mark variants are the ones this client uses. */
export const PERPL_TRIGGER = { gteLast: 1, lteLast: 2, gteMark: 3, lteMark: 4 } as const;

/** `st` on an mt:24 Order update. */
export const PERPL_ORDER_STATUS = {
  pending: 1,
  open: 2,
  partiallyFilled: 3,
  filled: 4,
  canceled: 5,
  expired: 6,
  failed: 7,
  untriggered: 8,
  triggered: 9,
  executed: 10,
} as const;

/** `sr` 34: the account exists but has not called `allowOrderForwarding(true)`. */
export const PERPL_STATUS_REASON_ORDER_FORWARDING_NOT_ALLOWED = 34;
