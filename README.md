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

Stated plainly, as of 9 October 2026. This section is updated as each piece goes
live.

| Piece | State |
|---|---|
| Contracts: price series, strategy registry, refusal gate, predicate engine | Deployed on Monad testnet. 277 Foundry tests pass. |
| Contracts: threshold market (Predict), guarded vault, copy vault, margin account, insurance fund | Deployed on Monad testnet. Covered by the same test suite. |
| Strategy spec, evaluators, hashing, on-chain encoding (`packages/spec`) | Built, 285 tests pass. |
| Compiler (plain language to spec, Qwen 3.8 Max) | Built in the Convex backend. Rejects anything it cannot express as arithmetic. |
| Web and mobile clients | Built from one shared UI package. Not yet hosted publicly. |
| Pinning from the app | Wired to the registry. Not yet exercised against the current deployment. |
| Refusal in the app | Decided off-chain by the backend today. Calling the on-chain gate from the app is in progress. |
| Order execution (Perpl perps, Kuru spot) | Clients written and unit-tested. Not yet connected to the app; fills are paper and labelled so. |
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
