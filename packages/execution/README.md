# @kanon/execution

Venue-agnostic execution for Kanon: Perpl for perps, Kuru for spot, a paper
client for everything else, and an `ExecutionService` that turns an approved
trade into an entry plus protective stop / take-profit and a JSON report a
Convex action can store as trade evidence.

One path has run against a live venue: the signed REST client placed and closed
a market order on Perpl testnet (see "One real order, by script"). Everything
else is verified by test only. What is and is not verified is stated exactly
below. Prices and sizes are `Decimal` (integer atoms plus explicit
decimals) end to end; a `number` appears only where a venue's own wire format is
a JSON integer.

## Layout

| File | What it is |
|---|---|
| `types.ts` | `ExecutionClient`, `Order`, `TriggerOrder`, `NativeTriggerCapable` |
| `orders.ts` | Client-side stop / take-profit / trailing / TWAP / iceberg watcher layer |
| `paper.ts` | `PaperExecutionClient`, the default; logs every fill with `[paper]` |
| `perpl*.ts` | Perpl: constants, Ed25519 signing, enrollment, market registry, client |
| `kuru.ts` | Kuru: `KuruClient`, real-SDK adapter, receipt decoder, Flow quote client |
| `router.ts` | `VenueRouter` and `createVenueRouterFromEnv` |
| `config.ts` | Zod-validated env (`KANON_EXECUTION_MODE` and friends) |
| `service.ts` | `ExecutionService` and the `ExecutionReport` shape |
| `scaling.ts` | Exact BigInt rescaling with named rounding modes |

## Configuration

Execution is **paper unless** `KANON_EXECUTION_MODE=live` **and** that venue's
credentials are all present. Half-set credentials are a validation error. A live
request with no credentials falls back to paper for that venue and says so in
`config.warnings`; every report carries the mode it actually ran in.

| Variable | Default | Meaning |
|---|---|---|
| `KANON_EXECUTION_MODE` | `paper` | `paper` or `live` |
| `KANON_PERPL_NETWORK` | `testnet` | `mainnet` or `testnet` |
| `PERPL_API_KEY` | none | Opaque `X-API-Key` token from enrollment |
| `PERPL_API_KEY_SECRET` | none | Ed25519 secret, 32 bytes hex |
| `PERPL_ACCOUNT_ID` | none | On-chain exchange account id |
| `KANON_PERPL_DEFAULT_LEVERAGE` | `1` | Whole-number leverage when a trade carries none |
| `KANON_KURU_NETWORK` | `testnet` | `mainnet` or `testnet` |
| `KANON_KURU_PRIVATE_KEY` | none | 0x-prefixed 32-byte EVM key |
| `KANON_KURU_RPC_URL` | Monad public RPC | Override |
| `KANON_KURU_QUOTE` | `AUSD` | Which stable a USD-quoted spot asset routes to |
| `KANON_KURU_USE_MARGIN` | `true` | Trade against margin-account balances |
| `KANON_DEFAULT_MAX_SLIPPAGE_BPS` | venue default (Perpl), 50 (Kuru) | Market-order bound |

Nothing secret is defaulted, hard-coded or logged.

## The Perpl on-chain safeguard (three steps, not one)

Perpl's docs are explicit that these are separate things, and all three are
needed to trade through the API:

1. **API key.** `enrollPerplApiKey` (`perpl-enroll.ts`): Ed25519 key pair, server
   returns the EIP-712 typed data, the user's wallet signs it, the API key signs
   the digest as proof of possession, `POST /v1/api-key/enroll` returns the
   `X-API-Key`. This gives read/trade API access and nothing else. It needs a
   Perpl-whitelisted `Origin`.
2. **Exchange account.** The wallet approves the collateral token (AUSD on
   mainnet) to the Exchange contract, then calls `createAccount(uint256)` with at
   least the minimum open amount (read it from the public API). This creates the
   account id that becomes `PERPL_ACCOUNT_ID`.
3. **Order forwarding.** The account's own wallet calls
   `allowOrderForwarding(true)` on the Exchange contract. `createAccount` leaves it
   off. Without it every forwarded order is acknowledged (`mt: 3`, code 0) and then
   fails on the order stream with `sr: 34` (`OrderForwardingNotAllowed`).

This package can perform none of steps 2 and 3, by design: the execution layer
must never be the thing that grants itself trading rights, and the wallet is the
user's. It does two things about them. `PerplClient` reads `fw` from the wallet
snapshot and refuses locally (no frame sent) when it is `false`. And if the venue
reports `sr: 34` anyway, the rejection reason names `allowOrderForwarding(true)`.

Exchange addresses (Perpl README, 2026-09-20): mainnet
`0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`, testnet
`0x1964c32f0be608e7d29302aff5e61268e72080cc`. Read the live address from the
API rather than trusting this copy.

## What is verified by test (`pnpm --filter @kanon/execution test`, 256 tests)

Every network boundary is mocked; the logic on this side of it is real.

- **Scaling**: exact BigInt rescale, floor / ceil / exact modes, refusal of
  integers above 2^53.
- **Perpl request signing**: the six-field REST canonical string and the
  four-field WebSocket sign-in string, byte for byte; a real Ed25519 signature
  is produced and verified against the public key; a target beginning `/api/`
  is refused; the empty-body SHA-256 matches the known value.
- **Perpl enrollment**: payload request body, `EIP712Domain` stripping, a real
  secp256k1 EIP-712 signature that recovers to the wallet, a real Ed25519
  proof-of-possession over the EIP-712 digest that verifies against the enrolled
  key, `Origin` header, mainnet vs testnet chain id and base URL, 409 handling.
- **Perpl client**: signed `mt: 29` sign-in as the first frame; `mt: 22` order
  frames (OpenLong / OpenShort / CloseLong / CloseShort, `p`, `s`, `fl`, `lv`,
  `lb`, optional `ms`); strictly increasing `rq`, unique `sn`, same-`rq` retry;
  limit-price and size rounding toward the safe side; `mt: 3` ack parsing
  (accepted is `pending`, never `filled`; 400 / 403 rejections; ack timeout is
  `pending` with "outcome unknown"); `mt: 24` outcome parsing (filled, partial
  IOC, zero-fill IOC, failed with `sr: 34`); native stop / take-profit trigger
  frames (`t`, `tp`, `tpc`, `tr` linked to the entry `rq`); cancel frame; `mt: 27`
  positions; signed REST fills; trades stream to `PriceTick`; refusal of unknown
  assets, closed markets, unloadable context, sub-step sizes, non-integer
  leverage, and `fw: false`; a `3401` close surfaced as an auth failure.
- **Perpl markets**: the full id table (mainnet 1 BTC, 10 MON, 20 ETH, 31 SOL,
  40 HYPE, 50 ZEC; testnet 16 BTC, 32 ETH, 48 SOL, 64 MON, 256 ZEC) and per-market
  decimals loaded from `GET /v1/pub/context`.
- **Kuru client**: refusal of unknown markets; market buy sized in quote and
  market sell in base with a slippage floor; limit rounding; min/max size;
  resting-order bookkeeping and cancel; failures reported as rejections; no fill
  claimed when none can be decoded.
- **Kuru SDK adapter**: run against a fake SDK module with real ethers-encoded
  receipts, so the `OrderCreated` / `Trade` decoding, precision-to-decimals
  derivation, string conversion, margin flag and `BigNumber` cancel ids are
  exercised. A test also loads the real `@kuru-labs/kuru-sdk@0.0.95` and checks
  every entry point the adapter calls exists.
- **Kuru Flow**: JWT then quote, token caching, 429 handling (mocked HTTP).
- **Router**: perps to Perpl, spot to Kuru, `MON/USD` to `MON/AUSD`, refusal of
  unlisted perps, BTC spot, a spot short, unknown instruments; identical rules in
  paper mode; a live venue with no client fails loudly.
- **Config**: defaults to paper, per-venue live gating, half-set credentials
  rejected, secrets absent from validation errors.
- **Service**: paper flow end to end, client-side stop firing and one-cancels-other,
  native-trigger flow, protection sized to the actual fill, rejected entry,
  flatten-on-missing-stop, cancel of orphaned legs, refusals, JSON-safe report.

## One real order, by script

`src/perpl-order-cli.ts` opens a small position on Perpl testnet at market,
waits for the fill, closes it, and prints the transaction of each fill. It uses
the signed REST endpoints (`src/perpl-rest.ts`), not the trading socket.

The order itself is placed by `src/perpl-trade.ts` (`openAtMarket`,
`closeAtMarket`). An order from the app goes through the same two functions:
`src/venue-service.ts` wraps them with the checks a shared account needs
(`src/venue-policy.ts`: the limits, the margin check, the shapes it answers
with) and the gateway serves it at `/trade` (`packages/gateway/src/trade.ts`).
Both entries pull in the REST client and nothing else, so no chain SDK comes
with them. A run of the script is therefore a live check of the venue half of
the app's order path.

How an order's result is read (changed 2026-10-10, after a close that filled was
reported as not filled): acceptance by Perpl is only an acknowledgement. What
shows the order took effect is the account's position, which Perpl serves as
live state about a second old. The fill history is a separate record that
trails it by seconds, and once by more than twenty. So the code watches the
position, answers as soon as it moves, and asks the history for the fill's
price, fee and transaction afterwards. "Nothing filled" is said only when the
account's request counter shows Perpl forwarded the order and the position is
unchanged a few looks later. If neither is known when the wait runs out the
answer is `pending`: sent, result not reported.

An order on the side of a position already held adds to it, at the position's
leverage and up to `maxPositionUsd` at entry. One on the other side is refused.
That adds path is covered by tests against a fake venue and has not yet been
run against Perpl.

Predict's timed trades run on the same service (`src/timed-policy.ts`,
`src/timed-runner.ts`): a call of up or down for a set time is a position
opened at market and closed by the server when the time is up, or sooner if its
loss at the mark price reaches its stake. The result is the price change
between the two fills times the size, less the fees reported, in integers.
Tested against a fake venue; not yet run against Perpl.

The service is framework-free because of where it has to run: Perpl answers
its trading API with HTTP 451 from regions it does not serve, and that is what
it answered when this code ran inside the Convex backend (2026-10-10). The
process that runs it supplies the signed client and a `VenueRecorder`, which
knows who is asking, keeps one order out at a time and writes each one down.

```
pnpm --filter @kanon/execution perpl:order            # look only: account, price, the order it would send
pnpm --filter @kanon/execution perpl:order --send     # place it, then close it
pnpm --filter @kanon/execution perpl:order --close    # close a position an earlier run left open
pnpm --filter @kanon/execution perpl:order --send --side short --usd 10 --leverage 3
```

It needs an API key and nothing else: no wallet key is read. The key is created
in Perpl's own UI by the wallet that owns the account, and saved in
`packages/execution/.env.local` (gitignored) as `PERPL_API_KEY` and
`PERPL_API_KEY_SECRET`. Perpl shows the secret as hex, base64url and PEM; the
script reads the hex or the base64url form. The account must exist (a deposit
of at least 100 AUSD on testnet) and have One-Click Trading turned on.

Enrolling a key from our own code is a separate matter: Perpl only accepts
enrollment from an `Origin` it has whitelisted, and Kanon's is not yet.

Checked against the live testnet on 2026-10-10: a signed request from a server
with no `Origin` header reaches authentication (a made-up key is answered 401).

Run with a real key on testnet the same day. A market order sent as `p: 0`,
`fl: 4` (IOC) and `ms: 100` was accepted and filled in the next block: 0.00030
BTC at 82847.1, fee 0.008575 AUSD, transaction
`0xc533b0b04fcf0aa8bbaaea78b810184f8ee609b71248c3082243523d4f3b6cc5`. That run
also showed that a position read over REST carries an empty `at`, with its open
time in `ots`; the schema follows the venue, not the docs.

The close ran next, with `--close`: type 3 (close long), `p: 0`, `fl: 4`,
`ms: 100`, the full size, and `lv` set to the position's own leverage. Accepted
and filled at 82813.4, transaction
`0x52c1785c88cce4559645bf648eab329432caf099c44cca9d7aca7d9b67bcf278`. Both
encodings this script uses are therefore confirmed on testnet.

## What still needs a live account

Do not treat any of this as proven until it has run against a funded testnet
account.

**Perpl**
- End-to-end enrollment against the real `/api-key/payload` and `/enroll`
  (needs a whitelisted `Origin` and a wallet). The typed data is taken from the
  server, so its exact shape is validated only structurally.
- Market order encoding over the trading socket. Over REST, `p: 0` with
  `fl: 4` (IOC) and `ms` is confirmed (see "One real order, by script").
- Stop-market trigger encoding: `t: 3/4`, `p: 0`, `fl: 4`, `tp`, `tpc` (mark
  conditions 3 / 4), `tr` linked to the entry, `lb: 0`. The docs define every
  field but show no complete stop-loss request. The `lp` (linked position)
  alternative is not used.
- The `lv` to send on a Close order (this client sends the configured leverage).
- The shape of an `mt: 21` account update (only its `fw` flag is read, from `d`),
  and whether the wallet snapshot reports existing positions. `getPosition` reads
  `mt: 27` updates only.
- Whether the sign-in frame gets a reply. The client does not wait for one; a bad
  signature shows up as a `3401` close, and in-flight commands then resolve as
  `pending` / outcome unknown rather than failed.
- Cancel confirmation: only the `mt: 3` ack is tracked, so `cancelled: true`
  means "accepted for forwarding".
- Trade-stream frame details (`d[].p`, `d[].at.t`) and the rate limits (120
  requests/min trading; not enforced client-side).

**Kuru**
- Everything on-chain: `getMarketParams` decoding, `getL2OrderBook`, market buy /
  sell, limit and cancel transactions, gas. The margin account must already hold
  a deposit (deposit is not implemented here; `MarginDeposit.deposit` in the SDK
  does it).
- Trade-event price is decoded as 18-decimal fixed point, taken from the SDK's own
  `reconcileTradeEvent`; confirm against a real receipt.
- Kuru market buys spend an exact quote amount, so the filled base size can differ
  slightly from the requested size; the report carries the real filled size.
- The L2 book comes back from the SDK as JS floats. It is used only as a reference
  price for the slippage bound, re-quantised to the market's decimals, never for
  settlement.
- Kuru Flow: only the quote `output` is modelled; the `buildResponse` transaction
  is not consumed.
- The SDK pins ethers v5 (`5.7.1`), so this package does too, and importing
  `@kanon/execution` loads ethers v5. The SDK also `console.log`s on some errors.

**Both**
- Protection on Kuru and in paper mode is the client-side `AdvancedOrderWatcher`.
  It only works while a process is calling `evaluateProtection`, and its memory
  does not survive a restart (`pendingProtection()` exposes it for persistence).
  Only Perpl holds stops on the venue.

## Sources

Perpl: `github.com/PerplFoundation/api-docs` (README, authentication,
integrations, websocket, types, rest-endpoints) and `docs.perpl.xyz`
(order types), read 2026-09-20. Kuru: `docs.kuru.io` (contract addresses, SDK,
Flow API reference) and the published `@kuru-labs/kuru-sdk@0.0.95` typings and
source, read 2026-09-20. Kuru Flow base URL `https://ws.kuru.io/api`
(`/generate-token`, `/quote`).
