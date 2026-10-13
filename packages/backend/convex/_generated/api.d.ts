/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as analytics from "../analytics.js";
import type * as analyticsLogic from "../analyticsLogic.js";
import type * as authz from "../authz.js";
import type * as autopilot from "../autopilot.js";
import type * as autopilotData from "../autopilotData.js";
import type * as autopilotLogic from "../autopilotLogic.js";
import type * as chainLogic from "../chainLogic.js";
import type * as chainReads from "../chainReads.js";
import type * as chainRpc from "../chainRpc.js";
import type * as compiler from "../compiler.js";
import type * as compilerLogic from "../compilerLogic.js";
import type * as copyRelationships from "../copyRelationships.js";
import type * as crons from "../crons.js";
import type * as gateway from "../gateway.js";
import type * as homeFeed from "../homeFeed.js";
import type * as homeFeedLogic from "../homeFeedLogic.js";
import type * as http from "../http.js";
import type * as limits from "../limits.js";
import type * as markets from "../markets.js";
import type * as marketsLogic from "../marketsLogic.js";
import type * as nansen from "../nansen.js";
import type * as nansenLogic from "../nansenLogic.js";
import type * as positions from "../positions.js";
import type * as predictions from "../predictions.js";
import type * as proposer from "../proposer.js";
import type * as proposerData from "../proposerData.js";
import type * as proposerLogic from "../proposerLogic.js";
import type * as rateLimit from "../rateLimit.js";
import type * as series from "../series.js";
import type * as seriesLogic from "../seriesLogic.js";
import type * as serverEnv from "../serverEnv.js";
import type * as strategies from "../strategies.js";
import type * as ticks from "../ticks.js";
import type * as timedData from "../timedData.js";
import type * as timedLogic from "../timedLogic.js";
import type * as trades from "../trades.js";
import type * as users from "../users.js";
import type * as usersLogic from "../usersLogic.js";
import type * as vaultLogic from "../vaultLogic.js";
import type * as vaults from "../vaults.js";
import type * as venueData from "../venueData.js";
import type * as venueLogic from "../venueLogic.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  analytics: typeof analytics;
  analyticsLogic: typeof analyticsLogic;
  authz: typeof authz;
  autopilot: typeof autopilot;
  autopilotData: typeof autopilotData;
  autopilotLogic: typeof autopilotLogic;
  chainLogic: typeof chainLogic;
  chainReads: typeof chainReads;
  chainRpc: typeof chainRpc;
  compiler: typeof compiler;
  compilerLogic: typeof compilerLogic;
  copyRelationships: typeof copyRelationships;
  crons: typeof crons;
  gateway: typeof gateway;
  homeFeed: typeof homeFeed;
  homeFeedLogic: typeof homeFeedLogic;
  http: typeof http;
  limits: typeof limits;
  markets: typeof markets;
  marketsLogic: typeof marketsLogic;
  nansen: typeof nansen;
  nansenLogic: typeof nansenLogic;
  positions: typeof positions;
  predictions: typeof predictions;
  proposer: typeof proposer;
  proposerData: typeof proposerData;
  proposerLogic: typeof proposerLogic;
  rateLimit: typeof rateLimit;
  series: typeof series;
  seriesLogic: typeof seriesLogic;
  serverEnv: typeof serverEnv;
  strategies: typeof strategies;
  ticks: typeof ticks;
  timedData: typeof timedData;
  timedLogic: typeof timedLogic;
  trades: typeof trades;
  users: typeof users;
  usersLogic: typeof usersLogic;
  vaultLogic: typeof vaultLogic;
  vaults: typeof vaults;
  venueData: typeof venueData;
  venueLogic: typeof venueLogic;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
