# Kanon

A trading app on Monad where your strategy is a rule a contract can check, and
the contract refuses any trade that breaks it.

You describe a strategy in plain language. An AI compiles it into an exact,
machine-checkable spec. You review it, pin it on-chain with a bond, and from then
on trades are checked against it by arithmetic over a recorded price series. No
model sits inside the contracts.

Built for the Monad Metropolis hackathon, track 01 (Onchain Finance & Trading).
`kanon` (κανών) is Greek for the rule and for the measuring rod you check things
against.

## Status

Stated plainly, as of 11 October 2026. This section is updated as each piece goes
live.

| Piece | State |
|---|---|
| Contracts: price series, strategy registry, refusal gate, predicate engine | Deployed on Monad testnet. 277 Foundry tests pass. |
| Contracts: threshold market (Predict), guarded vault, copy vault, margin account, insurance fund | Deployed on Monad testnet. Covered by the same test suite. |
| Strategy spec, evaluators, hashing, on-chain encoding (`packages/spec`) | Built, 285 tests pass. |
| Compiler (plain language to spec, Qwen 3.8 Max) | Built in the Convex backend. Rejects anything it cannot express as arithmetic. |
| Web and mobile clients | Built from one shared UI package. The web client is public at https://kanon-three.vercel.app, deployed to Vercel on 11 October (`pnpm deploy:web`) on Next 15.5.27. Its pages answer; it has not yet been opened and used in a browser there. It has no gateway address yet, so the chart ticket and Predict cannot trade there, and the Privy app must be told the address before sign-in works on it. The mobile client is not distributed. |
| Pinning from the app | Wired to the registry. Not yet exercised against the current deployment. |
| Refusal in the app | Decided off-chain by the backend today. Calling the on-chain gate from the app is in progress. |
| Order execution (Perpl perps, Kuru spot) | Clients written and unit-tested. A script (`perpl:order`) has opened and closed a real market order on Perpl testnet through the signed API; the two transactions are in `packages/execution/README.md`. The chart's order ticket (desktop panel and phone sheet) places a market order through the gateway's `/trade` routes with the same order code: one shared testnet account, $10 to $100 per order, up to 5x, no rule check. The backend checks who is asking and records each order; it cannot send one itself, because Perpl refuses its trading API (HTTP 451) to the region the backend is hosted in. On 10 October a signed-in user opened and closed a position from the ticket in a browser, on a developer's machine. In that run the close filled on the venue but the ticket reported it as not filled, and the open took about sixteen seconds. The order code now reads the result from the account's position instead of waiting on Perpl's fill history; that change is tested and has not yet been re-run against Perpl. Trades proposed by a rule are still paper fills and labelled so. |
| Predict (timed trades) | Being rebuilt on 10 October. It was a price-threshold market on the `ThresholdMarket` contract, taken through wallet prompts. It is now a timed trade: a pair called up or down for 1, 5, 15 or 60 minutes is a position the gateway opens at market and closes when the time is up, through the same order code as the chart's ticket, on the shared testnet account. The server side is written and tested against a fake venue; the screen is being rebuilt. No timed trade has yet been opened against Perpl. The contract is still deployed and is no longer used by the Predict screen. |
| Trading records (Profile) | Built on 11 October. Profile lists every trade a signed-in person took in one record: positions from the chart's ticket (paired from their own orders, entry weighted by size), timed trades from Predict, and setups put to their rule. A press opens the trade's figures and its transactions. The pairing and the result arithmetic are unit-tested. The table, the phone list and the detail sheet were checked in a browser with sample data while signed out; they have not yet been checked signed in against real orders. All orders still go to one shared account, so a position another person closed shows as ended elsewhere, with no exit. |
| Perpl risk (`/risk`) | Built on 11 October. Every Perpl market with its funding per event and per year, open interest, a day's volume, book width, mark against oracle, the margin the market makes a position keep and the taker fee, read from Perpl's public market data through the gateway and refreshed every few seconds; out-of-line books, marks and funding are listed first. Signed in, each position on the trading account shows the price it is liquidated at (Perpl's published formula, before funding) and how far the mark is from there. Markets were checked in a browser against Perpl testnet, signed out. The account half is unit-tested against Perpl's own worked example and has not yet been seen with a real position. It needs a gateway address, so on the hosted site it says market data is not connected until the gateway is hosted. |
| Market data gateway (`packages/gateway`) | Built and run against Perpl testnet: live candles, trades, order book and tickers over one venue connection, history from a cache. 131 tests pass. The app's charts and pair prices read from it when a gateway address is set (off by default); checked against a local gateway from Node, not yet in a browser. Not yet hosted. |
| Price series keeper | Not running continuously. The testnet series is stale between runs. |
| Indexer (Envio HyperIndex) | Written, not deployed. Does not index the strategy retire events yet. |

Nothing here has been audited.

## Deployed contracts

Monad testnet, chain id 10143. Deployed 5 October 2026.

| Contract | Address |
|---|---|
| StrategyRegistry | [`0xDB91f547B59A3326f3DB8E8F510E8dbbf4e50852`](https://testnet.monadscan.com/address/0xDB91f547B59A3326f3DB8E8F510E8dbbf4e50852) |
| RefusalGate | [`0x388f55962954c5083D885543aF22b1b6EE640ec0`](https://testnet.monadscan.com/address/0x388f55962954c5083D885543aF22b1b6EE640ec0) |
| CanonicalSeries BTC/USD | [`0x74c4b8710Fb83Dcc18c1A5ae2E35A63dc005257a`](https://testnet.monadscan.com/address/0x74c4b8710Fb83Dcc18c1A5ae2E35A63dc005257a) |
| CanonicalSeries ETH/USD | [`0x8D2D1b9DAfA8f68ECcfEC9FDEbbe04268b4ffbf3`](https://testnet.monadscan.com/address/0x8D2D1b9DAfA8f68ECcfEC9FDEbbe04268b4ffbf3) |
| ThresholdMarket | [`0x6105E943C40fd1C18d7288a5C443914af3672815`](https://testnet.monadscan.com/address/0x6105E943C40fd1C18d7288a5C443914af3672815) |
| VaultFactory | [`0x3AE5478B8bBedC7273e0dF70B361E7FacA7Ecf8D`](https://testnet.monadscan.com/address/0x3AE5478B8bBedC7273e0dF70B361E7FacA7Ecf8D) |
| MarginAccount | [`0x94fC3E4d37D348FA81556D748A34f31905dAD333`](https://testnet.monadscan.com/address/0x94fC3E4d37D348FA81556D748A34f31905dAD333) |
| InsuranceFund | [`0xbA0ddA7891BAb53AF7a6cCd2f4D12484a00b247f`](https://testnet.monadscan.com/address/0xbA0ddA7891BAb53AF7a6cCd2f4D12484a00b247f) |
| Collateral token (mock USDC) | [`0x89b928df3A0F929578a3c93E1d6E3Be3433e539C`](https://testnet.monadscan.com/address/0x89b928df3A0F929578a3c93E1d6E3Be3433e539C) |
| Pyth (mock) | [`0x7B0564b87Edd57d7BB70550b1FBA3384964862ce`](https://testnet.monadscan.com/address/0x7B0564b87Edd57d7BB70550b1FBA3384964862ce) |

The testnet deployment uses a mock Pyth contract and a mock collateral token,
both with unrestricted setters. Anyone can move the testnet oracle. It is a
beta for trying the flow, not a market. On Monad mainnet the same series
contract reads Pyth's real price feed directly; that deployment has not been
made.

## Why Monad

The contract keeps its own price record: it samples the feed on a fixed cadence
and buckets the samples into candles, so "the swing high" means the maximum over
samples anyone can read back, not a number someone asserts. That costs a
transaction per sample and storage per candle. Monad's fees and block times are
what make a per-minute on-chain tape affordable, and a check that adds a block
or two of latency is acceptable for the swing trading this is built for.

## How the rule is enforced

- `StrategyRegistry` pins three things together: a hash of the spec, a
  commitment to the exact predicate list, and the price series the predicates
  run against.
- `RefusalGate.evaluateOnChain` requires the supplied predicates to match the
  pinned commitment, derives the scan window on-chain, requires a fresh sample,
  and evaluates break of structure, fair value gap and liquidity sweep as
  integer arithmetic. A refusal names the predicate and the number that failed.
- Tightening a rule applies immediately. Loosening waits out a cooling-off
  period. There is no admin key and no override.
- The contracts never call a model. The model only translates language into a
  spec, which the user reviews before anything is pinned.

`docs/SECURITY.md` states what is trusted, what is mitigated and what is still
open. `docs/ARCHITECTURE.md` explains the design.

## Layout

pnpm workspace monorepo.

```
apps/
  web/          Next.js App Router. Mounts screens from packages/ui.
  mobile/       Expo with expo-router. Mounts the same screens.
packages/
  ui/           Every screen and component, in React Native primitives.
  spec/         Strategy spec: Zod schema, evaluators, hashing, on-chain encoding.
  tokens/       Design tokens, built into a Tailwind preset.
  contracts/    Foundry. Series, registry, gate, market, vaults, margin.
  backend/      Convex. Compiler, proposer, price ingestion, markets, auth.
  execution/    Perpl and Kuru clients, paper client, venue router.
  gateway/      Market data: holds the Perpl connection, serves every client from it.
  relayer/      Pushes price updates and records series samples.
  keeper/       Liquidation and de-leveraging bot for MarginAccount.
  indexer/      Envio HyperIndex handlers and schema.
docs/           Product, architecture, design, scope, security.
```

## Running it

```
pnpm install
pnpm web                # web client on localhost:3000
pnpm start              # Expo dev server
pnpm test               # all TypeScript suites and forge test
pnpm typecheck
pnpm lint
```

The web client reads its configuration from `apps/web/.env`; see
`apps/web/.env.example` for the variables. All of them are public values. The
backend needs a Convex deployment (`npx convex dev` in `packages/backend`).

To deploy the web client to Vercel, use `pnpm deploy:web` (add `-- --prod` for
production) and not `vercel deploy`. Run in the working tree, `vercel deploy`
uploads files that `.gitignore` lists, `.env` files among them. The script
deploys a clean copy of what git would commit and then reads the upload back to
check it. The gateway is deployed separately from `render.yaml`.

To check the contracts on their own:

```
cd packages/contracts
forge test
./script/e2e-local.sh   # full deploy and scenario on a local anvil
```

## AI tools

Required disclosure for the hackathon, and true regardless.

- Most of this codebase was written with Claude Code (Anthropic) as a coding
  assistant, directed and reviewed by the author.
- The in-product compiler calls Qwen 3.8 Max through Alibaba Cloud DashScope to
  translate a plain-language strategy into a spec. Its output is schema-validated
  and always reviewed by the user before pinning.
- No model is called by, or trusted by, any contract.

## Licence

MIT. See `LICENSE`.
