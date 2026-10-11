# Welcome to your Convex functions directory!

Write your Convex functions here.
See https://docs.convex.dev/functions for more.

A query function that takes two arguments looks like:

```ts
// convex/myFunctions.ts
import { query } from "./_generated/server";
import { v } from "convex/values";

export const myQueryFunction = query({
  // Validators for arguments.
  args: {
    first: v.number(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Read the database as many times as you need here.
    // See https://docs.convex.dev/database/reading-data.
    const documents = await ctx.db.query("tablename").collect();

    // Arguments passed from the client are properties of the args object.
    console.log(args.first, args.second);

    // Write arbitrary JavaScript here: filter, aggregate, build derived data,
    // remove non-public properties, or create new objects.
    return documents;
  },
});
```

Using this query function in a React component looks like:

```ts
const data = useQuery(api.myFunctions.myQueryFunction, {
  first: 10,
  second: "hello",
});
```

A mutation function looks like:

```ts
// convex/myFunctions.ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const myMutationFunction = mutation({
  // Validators for arguments.
  args: {
    first: v.string(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Insert or modify documents in the database here.
    // Mutations can also read from the database like queries.
    // See https://docs.convex.dev/database/writing-data.
    const message = { body: args.first, author: args.second };
    const id = await ctx.db.insert("messages", message);

    // Optionally, return a value from your mutation.
    return await ctx.db.get("messages", id);
  },
});
```

Using this mutation function in a React component looks like:

```ts
const mutation = useMutation(api.myFunctions.myMutationFunction);
function handleButtonPress() {
  // fire and forget, the most common way to use mutations
  mutation({ first: "Hello!", second: "me" });
  // OR
  // use the result once the mutation has completed
  mutation({ first: "Hello!", second: "me" }).then((result) =>
    console.log(result),
  );
}
```

Use the Convex CLI to push your functions to a deployment. See everything
the Convex CLI can do by running `npx convex -h` in your project root
directory. To learn more, launch the docs with `npx convex docs`.

## Server environment

Set with `npx convex env set NAME value`. Validated in `serverEnv.ts`; a bad or
missing value fails closed (the action refuses) and logs the variable name only.

| Name | Used by | Notes |
| --- | --- | --- |
| `PRIVY_APP_ID` | `auth.config.ts` | required |
| `DASHSCOPE_API_KEY` | `compiler:compileStrategy` | required to compile |
| `NANSEN_API_KEY`, `NANSEN_BASE_URL` | `nansen:smartMoneyFlow` | optional; unset means "not connected" |
| `MONAD_RPC_URL`, `MONAD_CHAIN_ID` | `predictions:recordPosition`, `vaults:recordVault`, `vaults:recordBalance` | required; the RPC must report this chain id |
| `THRESHOLD_MARKET_ADDRESS` | `predictions:recordPosition` | required; must equal the market's linked address |
| `VAULT_FACTORY_ADDRESS` | `vaults:recordVault` | required |
| `VENUE_RECORDER_KEY` | `http.ts` (`/venue/*`) | optional; unset means no order can be recorded, so none is sent. The same value is set on the gateway |

Chain-mirroring rows are never built from client numbers: stakes come from the
`SideTaken` log of the receipt, vaults from `VaultFactory.isVault` and the
vault's own getters, balances from `totalCollateral()`. They are accepted only
for the wallet the user linked by signing `walletLinkMessage` (`users:linkWallet`).
Rate limits live in `rateLimit.ts` (`RATE_LIMITS`).

## Venue orders

This backend does not send orders. Perpl answers its trading API with HTTP 451
("unavailable for legal reasons") from the region Convex runs in; that was the
answer to every call when the order code ran here as an action on 2026-10-10.
Orders are sent by the gateway (`packages/gateway`, `/trade`), which runs where
its operator is. What stays here is what a process that clients talk to must
not decide for itself:

- **Who is asking.** The gateway passes the caller's own Privy token on. Convex
  verifies it, as for every other function. No route takes a user id.
- **The rate limit**, per user (`rateLimit.ts`: `venueOrder`, `venueAccount`).
- **The lock.** `venueData:begin` writes the order's row before it is sent; a row
  still `submitting` keeps the next order out, since the venue numbers an
  account's requests in sequence. A row older than 45 seconds is closed out as
  `failed` and stops holding the lock.
- **The record.** Every order is a `venueOrders` row with who asked, what the
  venue answered and the settling transaction. `venueData:listMyOrders` is the
  caller's own list.

The gateway reaches these through four routes in `http.ts`, at the
deployment's `.convex.site` address: `POST /venue/admit`, `/venue/begin`,
`/venue/settle` and `/venue/amend`. Each needs `VENUE_RECORDER_KEY` in
`X-Kanon-Recorder`, so a signed-in user cannot write fills into their own list
or hold the lock by calling them directly. `admit` and `begin` also need the
caller's token; `settle` and `amend` name the row by the id `begin` returned.
`amend` only adds a fill's price, fee, block and transaction to a row already
recorded as filled: the venue lists those seconds after the position moves, and
the order is answered before they are known.

The order logic and its limits are in `@kanon/execution` (`venue-service.ts`,
`venue-policy.ts`): one shared exchange account, testnet only, $10 to $100 of
notional per order, up to 5x, a position of at most $300 at entry, market
orders only. The pinned rule is not consulted.

Predict's timed trades use the same arrangement (`timedData.ts`, `/timed/*` in
`http.ts`). The gateway opens a position when somebody calls a direction and
closes it when the time is up; this backend keeps whose trade it is
(`timedTrades`), hands a restarted gateway the trades still running, and takes
the order lock for a closing order on the trade's own id, since that order is
sent by the server after the person may have left. `timedData:listMine` is the
caller's own list. A row can be added to as a trade ends, never reopened, and
never moved to another user.

Checked on 2026-10-10 against the development deployment: a call with no key or
a wrong key is answered 403, a call with the key and no valid token 401, and a
body that is not an outcome 400. The same day a signed-in user's orders were
recorded through these routes from the app.
