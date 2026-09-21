# @kanon/backend

The Convex backend: strategies, trades, vaults, copy trading, predict markets,
the compiler and proposer actions, and the tick series.

## Authentication and authorization

Convex verifies the caller's **Privy access token** (an ES256 JWT) on every
request. Identity is never taken from a function argument.

- `convex/auth.config.ts` registers Privy as a custom-JWT provider: issuer
  `privy.io`, audience = your Privy app id, keys from
  `https://auth.privy.io/api/v1/apps/<app id>/jwks.json`. With no
  `PRIVY_APP_ID` it throws at push time instead of falling back to anything.
- `identity.subject` is the user's Privy DID (`did:privy:...`), the same value
  as `user.id` on the clients, stored verbatim in `users.privyId`.
- `convex/authz.ts` turns that into the `users` row (`requireUser`,
  `viewerUser`) and checks ownership (`requireOwnedStrategy`,
  `viewOwnedVault`, ...). Mutations and actions use `require*` and throw
  (`unauthenticated`, `no_user`, `not_found`); reactive queries use `view*` and
  return empty. A row that belongs to someone else is `not_found`, the same as
  one that does not exist.
- No public function declares `ownerUserId`, `userId`, `followerUserId` or
  `privyId` (`users.createUser` accepts an optional `privyId` only as a check
  against the token's subject). `convex/publicSurface.test.ts` enforces this
  and also fails if a new public function never consults identity. Exceptions
  go in that file's allowlists, with a reason.
- Cron and action-only work (`ticks:*`, `markets:sweep` and its steps, cache
  writes, settlement, `trades:recordEvaluation`, `trades:finalizeTrade`, and
  the margin-ledger writes) is `internal*` and unreachable from a client.

Clients send the token through `ConvexProviderWithAuth` with Privy's
`getAccessToken` (`apps/web/src/providers.tsx`,
`apps/mobile/src/providers.tsx`). Signed out, the apps make no Convex calls and
render the demo fixtures.

## Environment variables

Set on the Convex deployment (`npx convex env set NAME value`), not in a
client `.env`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PRIVY_APP_ID` | yes | Privy app id. Sets the token audience and the JWKS URL in `auth.config.ts`. Must equal the `NEXT_PUBLIC_PRIVY_APP_ID` / `EXPO_PUBLIC_PRIVY_APP_ID` the clients use. Push fails without it. |
| `DASHSCOPE_API_KEY` | for the compiler | Alibaba Model Studio key used by `compiler:compileStrategy`. |
| `NANSEN_API_KEY` | optional | Smart-money flow. Unset, the card reports `not_connected`. |
| `NANSEN_BASE_URL` | optional | Override for the Nansen API base URL. |
| `MONAD_RPC_URL` | optional | Pyth read for tick ingestion. Default `https://rpc.monad.xyz`. |
| `HERMES_API_KEY` | optional | Switches tick ingestion to Pyth Hermes. |
| `HERMES_URL` | optional | Default `https://hermes.pyth.network`. |
| `HERMES_API_KEY_HEADER` | optional | Default `Authorization` (sent as Bearer). |

Client-side (Privy app id, Convex URL, contract addresses) stay in
`NEXT_PUBLIC_*` / `EXPO_PUBLIC_*`; see `apps/web` and `apps/mobile`.

## Tests

```
pnpm --filter @kanon/backend test
pnpm --filter @kanon/backend typecheck
```

`_generated/api.d.ts` is stale until `npx convex dev` regenerates it. Clients
reference functions by name through a permissive `api` cast, and server code
calls internal functions through `makeFunctionReference`.
