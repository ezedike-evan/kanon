# @kanon/indexer

Envio HyperIndex indexer for Kanon on Monad (chain id 143). Envio is the only
indexer in this repo.

It turns the contracts' event logs into queryable trade history and adherence
data:

- every trade and refusal for an address, each row carrying its evidence
  (`specHash`, `txHash`, `blockNumber`, `logIndex`)
- the pin / tighten / loosen (cooling-off) timeline of a strategy
- the price tape (`PriceSample`) needed to ask "how many refusals would have
  lost"

Nothing here is on the trust path. The contracts enforce the rules; this package
only reads what they emitted.

## Status, stated plainly

- Verified here: `envio codegen` passes, handlers typecheck, all unit tests pass
  (handlers through Envio's `createTestIndexer`, the GraphQL client against a
  mocked `fetch`, and a drift test that fails if `config.yaml` and the Solidity
  sources or `packages/contracts/abi` disagree on any event).
- Not verified: a sync against a live chain (no deployed addresses, no
  HyperSync token, no Docker/Postgres/Hasura in the build environment), the
  GraphQL documents in `src/client.ts` and below against a running Hasura, and
  an Envio Cloud deployment. Treat those as untested until you run them.

## Layout

```
config.yaml            events per contract, chain 143, addresses from ENVIO_* env
schema.graphql         entities
src/handlers/          one file per contract
src/lib/               pure helpers (ids, bytes32 decoding, counters)
src/client.ts          typed GraphQL client, no dependency on the envio runtime
test/                  handler, client and drift tests
```

`ThresholdMarket` now fixes its series map in the constructor (one `SeriesRegistered` per entry in the deployment transaction), so `ENVIO_START_BLOCK` must be at or before that block.

Contracts indexed: StrategyRegistry, RefusalGate, ThresholdMarket, MarginAccount,
InsuranceFund, CanonicalSeries (static addresses), and GuardedVault and
CopyVault (discovered from `VaultFactory.GuardedVaultCreated` /
`CopyVaultCreated` through `contractRegister`, so every vault created by the
factory is indexed from its creation block with no address list to maintain).

## Entities

| Entity | What it answers |
| --- | --- |
| `TradeLog` | The history table. One row per proposal, refusal, open, close, liquidation, deleverage, mirror or skip. Filter by `account`, `actor`, `vault`. |
| `Refusal` | Every gate refusal: `predicate`, `decidingValue`, `specHash`, `timestamp`, evidence. |
| `Strategy`, `StrategyEvent` | Active spec hash, predicates commitment and series, the pending loosening (hash, commitment, series) and `cooldownEndsAt`, plus the full timeline. |
| `Account` | Counters per address: proposals, refusals, opens, closes, liquidations, and the strategy its margin account is bound to. |
| `Position` | MarginAccount and CopyVault positions with entry, exit, PnL, status, liquidator. |
| `MarginEvent`, `FundEvent` | Deleveraging, penalties, debt, bad debt, insurance fund flows. |
| `LooserVaultRequest` | The start of a looser vault's cooling-off wait (`availableAt`). |
| `Vault`, `CollateralFlow` | Vault config (owner, executor, series, whitelist, drawdown cap, copy economics) and deposits/withdrawals. |
| `Market`, `MarketBet`, `MarketClaim`, `MarketSeries` | ThresholdMarket book, bets, settlements, claims. |
| `PriceSample` | Every `CanonicalSeries.SampleRecorded`: integer price, exponent, publish time. |

### Attribution rules worth knowing

- Ids are `${chainId}_...`. Addresses are lowercase. Prices and sizes are exact
  BigInt integers; the exponent is on `PriceSample.expo`. No floats anywhere.
- A GuardedVault trade emits two logs in one transaction (RefusalGate's, with the
  predicate and failing number, and the vault's own). They are merged into one
  row. `account` is the vault owner (known from `VaultFactory`), `actor` is who
  called `proposeTrade` (the owner or an executor key), `vault` is the vault.
- `Refusal.decidingValue` is the predicate-specific number that failed the
  check. It is not a price. The refusal event carries no price, so the price at
  refusal comes from `PriceSample` (see "would have lost" below).
- One StrategyRegistry per chain is assumed: `RefusalGate` events carry the
  strategy id but not the registry address.

## Run locally

Prerequisites: Node 24+, pnpm 10, Docker (Envio runs Postgres and Hasura in
containers), and an Envio API token for HyperSync
(https://envio.dev/app/api-tokens).

```bash
pnpm install
cp packages/indexer/.env.example packages/indexer/.env
# fill ENVIO_API_TOKEN, ENVIO_START_BLOCK and the contract addresses
pnpm --filter @kanon/indexer dev
```

`envio dev` runs codegen, starts the containers and the indexer. Hasura's console
is at http://localhost:8080 (local password `testing`); the GraphQL endpoint is
`http://localhost:8080/v1/graphql`.

Without a deployment you can still work on the code:

```bash
pnpm --filter @kanon/indexer codegen     # regenerate types after editing config or schema
pnpm --filter @kanon/indexer typecheck   # codegen + tsc
pnpm --filter @kanon/indexer test        # no network, no Docker
```

The tests use placeholder addresses (`0x...01` to `0x...08`), which are also the
`config.yaml` defaults. Real addresses come from the environment only.

When a contract's events change, edit the signature in `config.yaml` and the
handler. `test/events-drift.test.ts` fails until they agree with the Solidity
sources and ABIs.

## Deploy on Envio Cloud (hosted service)

Envio Cloud deploys from GitHub on push.

1. Push the repo to GitHub. Sign in at https://envio.dev/app and install the
   Envio GitHub App on the repository.
2. Add an indexer. Set the root directory to `packages/indexer`, the config file
   to `config.yaml`, and the deployment branch (for example `main`).
3. Add environment variables (the `ENVIO_` prefix is required there):
   `ENVIO_API_TOKEN`, `ENVIO_START_BLOCK`, `ENVIO_STRATEGY_REGISTRY`,
   `ENVIO_REFUSAL_GATE`, `ENVIO_THRESHOLD_MARKET`, `ENVIO_MARGIN_ACCOUNT`,
   `ENVIO_INSURANCE_FUND`, `ENVIO_VAULT_FACTORY`, `ENVIO_CANONICAL_SERIES_BTC`,
   `ENVIO_CANONICAL_SERIES_ETH`. Set `ENVIO_START_BLOCK` to the earliest
   deployment block so indexing does not scan from genesis.
4. Push to the deployment branch. Envio builds and syncs; a later push re-indexes
   from the start block while the previous deployment keeps serving.
5. Copy the deployment's GraphQL endpoint from the dashboard into the consumers
   as `createIndexerClient({ url })`. The apps take it as `NEXT_PUBLIC_INDEXER_URL`
   (web) and `EXPO_PUBLIC_INDEXER_URL` (mobile): with it set, Profile > Previous
   rules lists the signed-in wallet's on-chain record (the queries are in
   `packages/ui/src/lib/onchain-record.ts`). The indexer must be on the chain
   the app is built for (`ENVIO_CHAIN_ID` equal to `NEXT_PUBLIC_CHAIN_ID`), since
   the app asks for ids prefixed with its own chain.

Constraints from Envio's docs to keep in mind: the repository must stay under
100 MB, imports must stay inside the indexer directory (this package is
self-contained; the `../../contracts` reads exist only in a test), and the
development plan allows 3 indexers per organization. The CLI alternative is
`npx envio-cloud` (alpha).

Caveat for this monorepo: the root `.npmrc` sets `node-linker=hoisted` and the
lockfile is at the repository root. If the Cloud build cannot resolve the
workspace from `packages/indexer`, that is where to look first.

## Client

```ts
import { createIndexerClient, wouldHaveLost } from "@kanon/indexer";

const indexer = createIndexerClient({ url: process.env.KANON_INDEXER_URL! });

const history = await indexer.getTradeHistory("0xabc...", { limit: 50 });
const refusals = await indexer.getRefusals("0xabc...", { strategyId: 3 });
const { strategy, events } = await indexer.getStrategyTimeline(3);

// Would the refused trades have lost within an hour? The caller names the series
// the strategy trades and the direction; the client supplies the prices.
const inputs = await indexer.getRefusalOutcomeInputs("0xabc...", btcSeries, {
  horizonSeconds: 3600,
});
const lost = inputs.filter((i) => wouldHaveLost(i, /* isLong */ true) === true).length;
```

`wouldHaveLost` is a mark-to-mark comparison of two integer prices. It ignores
fees, stops, funding and slippage, returns `null` when a price is missing or
the exponents differ, and the horizon price is only reported once the horizon
has elapsed. It is an input to a discipline story, not a P&L figure, and P&L
must not lead any screen.

### BigInt precision

Hasura serialises numeric columns as JSON numbers unless it is configured to
stringify them. The client accepts strings and safe integers, and throws if a
number is beyond `Number.MAX_SAFE_INTEGER` rather than rounding it. If wei-scale
values (bonds, sizes) throw, the deployment is returning unsafe numbers: turn on
numeric stringification for that Hasura instance. Whether Envio Cloud does this
by default was not verified.

## Example queries

Hasura conventions: root fields are the entity names, filters use `_eq`, `_or`,
`_in`, `_gte`, ordering is `order_by`.

Every trade and refusal for an address, newest first, with evidence:

```graphql
query History($address: String!) {
  TradeLog(
    where: {
      chainId: { _eq: 143 }
      _or: [
        { account: { _eq: $address } }
        { actor: { _eq: $address } }
        { vault: { _eq: $address } }
      ]
    }
    order_by: [{ timestamp: desc }, { logIndex: desc }]
    limit: 50
  ) {
    kind reason decidingValue specHash txHash blockNumber logIndex
    strategy_id assetId isLong size price pnl timestamp
  }
}
```

Refusals for one strategy, with the failing predicate and number:

```graphql
query Refusals($strategy: String!) {
  Refusal(
    where: { strategy_id: { _eq: $strategy } }
    order_by: { timestamp: desc }
  ) {
    predicate decidingValue specHash timestamp txHash account vault
  }
}
```

A strategy's timeline (pin, tighten, loosening and its cooling-off end):

```graphql
query Timeline($id: String!) {
  Strategy_by_pk(id: $id) {
    activeSpecHash predicatesCommitment series pendingSpecHash pendingPredicatesCommitment pendingSeries
    cooldownEndsAt tightenCount looseningCount refusalCount
  }
  StrategyEvent(where: { strategy_id: { _eq: $id } }, order_by: { timestamp: asc }) {
    kind oldSpecHash newSpecHash predicatesCommitment series cooldownEndsAt actor timestamp txHash
  }
}
```

Price tape around a refusal (input to "would it have lost"):

```graphql
query Tape($series: String!, $from: Int!, $to: Int!) {
  PriceSample(
    where: { series: { _eq: $series }, publishTime: { _gte: $from, _lte: $to } }
    order_by: { publishTime: asc }
  ) {
    price expo publishTime txHash
  }
}
```

Liquidations for an account:

```graphql
query Liquidations($address: String!) {
  Position(where: { account: { _eq: $address }, status: { _eq: LIQUIDATED } }) {
    series entryPrice exitPrice pnl liquidator closeTxHash closedAt
  }
}
```

## Known limits

- Sparse, event-driven feeds mean the newest sample before a refusal can be old.
  That is reported as it is, never interpolated.
- Vaults not created by `VaultFactory` are not indexed (no address list is kept).
- `TradeLog` rows for a vault contract's own address exist as zero-count
  `Account` rows: the gate counts against the vault as `msg.sender`, and the
  vault handler moves the count to the owner.
- Reorgs: `rollback_on_reorg: true`. Monad's finality behaviour under Envio was
  not exercised here.
