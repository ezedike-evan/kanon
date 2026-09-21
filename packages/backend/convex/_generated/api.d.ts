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
import type * as compiler from "../compiler.js";
import type * as compilerLogic from "../compilerLogic.js";
import type * as copyRelationships from "../copyRelationships.js";
import type * as crons from "../crons.js";
import type * as homeFeed from "../homeFeed.js";
import type * as homeFeedLogic from "../homeFeedLogic.js";
import type * as markets from "../markets.js";
import type * as marketsLogic from "../marketsLogic.js";
import type * as nansen from "../nansen.js";
import type * as nansenLogic from "../nansenLogic.js";
import type * as positions from "../positions.js";
import type * as predictions from "../predictions.js";
import type * as proposer from "../proposer.js";
import type * as proposerData from "../proposerData.js";
import type * as proposerLogic from "../proposerLogic.js";
import type * as series from "../series.js";
import type * as seriesLogic from "../seriesLogic.js";
import type * as strategies from "../strategies.js";
import type * as ticks from "../ticks.js";
import type * as trades from "../trades.js";
import type * as users from "../users.js";
import type * as vaultLogic from "../vaultLogic.js";
import type * as vaults from "../vaults.js";

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
  compiler: typeof compiler;
  compilerLogic: typeof compilerLogic;
  copyRelationships: typeof copyRelationships;
  crons: typeof crons;
  homeFeed: typeof homeFeed;
  homeFeedLogic: typeof homeFeedLogic;
  markets: typeof markets;
  marketsLogic: typeof marketsLogic;
  nansen: typeof nansen;
  nansenLogic: typeof nansenLogic;
  positions: typeof positions;
  predictions: typeof predictions;
  proposer: typeof proposer;
  proposerData: typeof proposerData;
  proposerLogic: typeof proposerLogic;
  series: typeof series;
  seriesLogic: typeof seriesLogic;
  strategies: typeof strategies;
  ticks: typeof ticks;
  trades: typeof trades;
  users: typeof users;
  vaultLogic: typeof vaultLogic;
  vaults: typeof vaults;
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
