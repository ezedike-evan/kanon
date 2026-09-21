# @kanon/relayer

Pushes Pyth price updates on-chain and asks each `CanonicalSeries` to record a
sample. **It is not required for the demo assets.**

## When you need it

Pyth pushes the sponsored premium feeds onto Monad itself (1h heartbeat, 0.02%
deviation): BTC/USD, ETH/USD, SOL/USD and MON/USD are kept fresh with no help
from us. The relayer exists for feeds Pyth does **not** push, where somebody
has to submit a signed update before `getPriceNoOlderThan` will return a price.

For the demo assets, neither the chart nor the ticks table needs it:

- The chart's off-chain series (`packages/backend/convex/ticks.ts`) reads the
  Pyth contract on Monad directly with `eth_call`. No key, no relayer. Set
  `MONAD_RPC_URL` to change the endpoint (default `https://rpc.monad.xyz`).
- `CanonicalSeries.recordSample()` is permissionless and takes no arguments, so
  anyone can call it. It samples whatever Pyth already holds.

Hermes is an optional alternate source for the Convex ingester, used only when
`HERMES_API_KEY` is set on the deployment. The public Hermes endpoint returns
401 without credentials.

## What a pass does

1. Reads each configured series' `feedId`, `cadenceSeconds` and
   `lastSampleTimestamp`, and skips any series whose cadence has not elapsed.
2. Fetches a Hermes update for the due feeds (needs `HERMES_URL` and, for a
   keyed endpoint, `HERMES_API_KEY`).
3. Pays Pyth's update fee (capped by `MAX_UPDATE_FEE_WEI`) with
   `updatePriceFeeds`.
4. Calls `recordSample()` on each due series.

## Running

```
pnpm --filter @kanon/relayer relay:dry    # one read-only pass
pnpm --filter @kanon/relayer relay        # sends only if RELAYER_BROADCAST=true
```

Dry run is the default. Broadcasting needs `RELAYER_BROADCAST=true`,
`PRIVATE_KEY`, and no `--dry-run` flag. All variables are documented and
validated in `src/config.ts`.
