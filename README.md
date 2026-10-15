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

Stated plainly, as of 15 October 2026. This section is updated as each piece goes
live.

| Piece | State |
|---|---|
| Contracts: price series, strategy registry, refusal gate, predicate engine | Deployed on Monad testnet. 277 Foundry tests pass. The testnet series reads a mock Pyth whose price anyone can set, so an approval or a refusal on testnet shows the arithmetic running, not a market price (see Limitations). |
| Contracts: threshold market (Predict), guarded vault, copy vault, margin account, insurance fund | Deployed on Monad testnet. Covered by the same test suite. The two vaults act on figures their executor reports, and the margin account cannot close or liquidate a position while the series is stale (see Limitations). |
| Strategy spec, evaluators, hashing, on-chain encoding (`packages/spec`) | Built, 285 tests pass. |
| Compiler (plain language to spec, Qwen 3.8 Max) | Built in the Convex backend. Rejects anything it cannot express as arithmetic. **Not answering on the hosted backend on 13 October: its model key is not set there, so a compile says the compiler is unavailable.** The host it reaches the model through can be set (`COMPILER_BASE_URL`, `COMPILER_API_KEY`, `COMPILER_MODEL`); unset, it is Alibaba Cloud's own endpoint. |
| Web and mobile clients | Built from one shared UI package. The web client is public at https://kanon.markets (Vercel, Next 15.5.27, deployed with `pnpm deploy:web`), and since 12 October it is connected to the hosted gateway. On 13 October the owner signed in there and placed a real order on Perpl testnet from it. A visitor who does not sign in sees the app on a labelled demo account. The mobile client is not distributed. |
| Pinning from the app | Wired to the registry. The backend writes a rule as pinned only after it reads the transaction's receipt and finds the registry's own `StrategyPinned` for that strategy id, from the user's linked wallet, with the draft's hash; a change and an applied loosening are checked the same way. Not yet exercised against the current deployment. |
| Refusal in the app | Decided off-chain by the backend today. Calling the on-chain gate from the app is in progress. |
| Order execution (Perpl perps, Kuru spot) | **Perpl:** the chart's order ticket (desktop panel and phone sheet) places market orders through the gateway's `/trade` routes: one shared testnet account, $10 to $100 per order, up to 5x, adding to a position on the same side, no rule check. The backend checks who is asking and records each order; it cannot send one itself, because Perpl refuses its trading API to the region the backend is hosted in. Opened and closed from a browser by the owner on a developer's machine on 10 October and on the hosted site on 13 October. The two transactions of an earlier scripted order are in `packages/execution/README.md`. **Kuru:** on 15 October Kanon listed a new spot market on Kuru's testnet order book, tkBTC/USDC (addresses under Deployed contracts): a test token it deployed, against its own mock USDC, seeded with liquidity, with one market buy filled through `packages/execution/src/kuru.ts`. The spot screen (`/spot`, reached from Profile) reads that market's book through the gateway's `/kuru/market` route and sends a market order, fill or kill, from the person's own wallet, with an approval when one is needed and the tokens' open mint for test funds. Kanon holds no key for it. The screen's order path is unit-tested against a fake chain; it has not yet been run by a signed-in person on the hosted site. Nothing else in the app trades on Kuru. Trades proposed by a rule at a button press are still paper fills and labelled so; a rule on autopilot is the exception (see Autopilot). |
| Predict (timed trades) | A pair called up or down for 1, 5, 15 or 60 minutes is a position the gateway opens at market and closes when the time is up, through the same order code as the chart's ticket, on the shared testnet account. A close that fills in part is followed until nothing of the position is left. Shown as a vertical reel, one pair to a slide. Used with real timed trades by the owner on a developer's machine on 11 October; on the hosted site trading was confirmed for the chart's ticket, and Predict was not separately confirmed. Signed out, the reel is a labelled sample that sends nothing. The earlier price-threshold market on the `ThresholdMarket` contract is still deployed and no longer used by this screen. |
| Autopilot | Built on 13 October. A switch on a pinned rule: the backend then judges the rule once on every closed candle of its own timeframe, with the arithmetic a button press runs, over the backend's candles and not through the on-chain gate. A refusal is recorded like any other. A pass is handed to the gateway, which opens a timed trade on Perpl testnet in the rule's market and on its side: a $10 stake at the timed-trade leverage (5x, or the market's own maximum where that is lower, so a position of at most $50), held for the shortest of 1, 5, 15 or 60 minutes that is not shorter than the rule's candle (60 minutes for a longer candle), then closed by the gateway, sooner if it has lost its stake. **It does not trade the rule's own entry, size or stop.** The proposal's row shows those and stays labelled paper; what was sent is the timed trade. Every user's trade goes to the one shared testnet account, one at a time per rule, and a pass opens nothing while that account already holds a position in the market or when the gateway does not pick it up within two minutes. **Not yet run end to end on the live deployment.** |
| Trading records (Profile) | Built on 11 October. Profile lists every trade a signed-in person took in one record: positions from the chart's ticket (paired from their own orders, entry weighted by size), timed trades from Predict, and setups put to their rule. A press opens the trade's figures and its transactions. The pairing and the result arithmetic are unit-tested. The table, the phone list and the detail sheet were checked in a browser with sample data while signed out; they have not yet been checked signed in against real orders. All orders still go to one shared account, so a position another person closed shows as ended elsewhere, with no exit. |
| Perpl risk (`/risk`) | Every Perpl market with its funding per event and per year, open interest, a day's volume, book width, mark against oracle, the margin the market makes a position keep and the taker fee, read from Perpl's public market data through the gateway and refreshed every few seconds; out-of-line books, marks and funding are listed first. Signed in, each position on the trading account shows the price it is liquidated at (Perpl's published formula, before funding) and how far the mark is from there. The markets were checked in a browser against Perpl testnet. The account half is unit-tested against Perpl's own worked example and has not been checked by the developers with a real position on screen. |
| Gateway (`packages/gateway`) | Hosted since 12 October at https://kanon-gateway.onrender.com (Render, Frankfurt; Perpl does not serve the US or the UK). It holds the Perpl connection and serves every client from it: live candles, trades, order book and tickers, history from a cache, and the `/trade` and `/predict` routes. 131 tests pass. It runs on a plan that sleeps an idle service, so the backend asks it for `/livez` every five minutes; the first answer after a sleep has taken close to a minute. |
| Price series keeper | Not running continuously. The testnet series is stale between runs. While it is stale the gate reverts instead of approving, and `MarginAccount` cannot open, close, liquidate or de-leverage a position (see Limitations). |
| Indexer (Envio HyperIndex) | Written and tested (`packages/indexer`), and able to follow the testnet contracts (the `envio` branch). **Not running:** an indexer was created on Envio's hosted service on 13 October and has not built, because the service has not yet received a push from this repository. The app can read it: Profile, Previous rules has an "On-chain record" of pins, changes and refusals, built against the indexer's schema and not yet run against a live indexer. It does not index the strategy retire events yet. |

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

The spot market Kanon listed on Kuru's testnet order book on 15 October 2026
(`pnpm --filter @kanon/execution kuru:list`, record in
`packages/execution/kuru-listing.testnet.json`):

| Kuru tkBTC/USDC | Address or transaction |
|---|---|
| Market (order book) | [`0x03026249435158b7a7Ca0F7419BF7B4EE17C1273`](https://testnet.monadscan.com/address/0x03026249435158b7a7Ca0F7419BF7B4EE17C1273) |
| tkBTC, Kanon Test BTC (test token, open mint) | [`0x4257E26b9d338F14d66D2Ec12Fe2bAceCc9c9928`](https://testnet.monadscan.com/address/0x4257E26b9d338F14d66D2Ec12Fe2bAceCc9c9928) |
| Listing | [`0xb1431ae6…0593f`](https://testnet.monadscan.com/tx/0xb1431ae604bf58136d011bdcf0bbece511bad95db221efc70cfdd8c289e0593f) |
| Liquidity seeded (50 tkBTC, 4,060,000 mock USDC) | [`0x61f0437f…cddb`](https://testnet.monadscan.com/tx/0x61f0437f0284d26c92e2680ecc642b6be6bbb1454750a0593d40de9beb42cddb) |
| First fill (market buy, 0.001 tkBTC at 81,200) | [`0xfff5f2eb…72b3`](https://testnet.monadscan.com/tx/0xfff5f2ebe385a742270972b9db86e61ee0d445083649af09b2d1ead2913572b3) |

The testnet deployment uses a mock Pyth contract and a mock collateral token,
both with unrestricted setters. Anyone can move the testnet oracle. A price set
there enters the series at the next `recordSample`, which anyone can call, so
anyone can decide whether the testnet gate approves or refuses, and what price
a testnet margin position or threshold market settles on. It is a
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
  period. There is no admin key and no override. The contract checks this over
  the predicates only, not over sizing or stops (see Limitations).
- The contracts never call a model. The model only translates language into a
  spec, which the user reviews before anything is pinned.

`docs/SECURITY.md` states what is trusted, what is mitigated and what is still
open. `docs/ARCHITECTURE.md` explains the design.

## Limitations

What the claims above do not cover. Each is stated in full in
`docs/SECURITY.md`, under Known gaps.

- **The testnet oracle is a mock.** `MockPyth.setPrice` has no access control
  and `recordSample` is open to anyone, so anyone can set the price the testnet
  series records, and with it whether the gate approves or refuses. On testnet
  the gate is arithmetic over a tape anyone can write.
- **`tighten` proves the predicates are no looser, and nothing else.** It
  replaces the spec hash in the same call with no cooling-off, and it accepts
  unchanged predicates. Risk per trade and stop distance are bound only by that
  hash, which the chain cannot read, so on-chain they can change at once, in
  either direction. No contract checks a trade's size or stop against the spec.
- **The vaults act on reported figures.** `GuardedVault.proposeTrade` takes
  `projectedPnL` from the vault's owner or executor and counts it against the
  daily drawdown cap. `CopyVault` takes the leader's size and the entry and exit
  prices from the leader's executor and settles the follower's ledger on them.
  The gate checks the predicates in the same transaction. It does not check
  these numbers.
- **A stale series stops `MarginAccount`.** It prices only from the current
  bucket of the series. With no sample in that bucket, opening, closing,
  `liquidate` and `deleverage` revert, and so does `withdraw` for an account
  with an open position. The keeper is not running continuously, so on testnet
  that is the usual state between runs.
- **Autopilot does not trade the rule's own entry, size or stop.** A pass opens
  a timed trade with a fixed $10 stake, at up to 5x, on the one shared Perpl
  testnet account. The verdict is the backend's, not the on-chain gate's. It
  has not yet run end to end on the live deployment.
- **The Kuru market is a test market.** tkBTC is a token Kanon deployed with
  an open mint; it is not bitcoin and has no value, and the USDC it trades
  against is Kanon's mock. Its only liquidity is what the listing seeded. The
  rule is not checked on a spot order, and the venue router still does not
  build a Kuru client for rule trades.

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
  execution/    Perpl client, Kuru client and the listing script, paper client, venue router.
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
