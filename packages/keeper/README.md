# @kanon/keeper

The bot we run ourselves to keep `MarginAccount` solvent. It finds accounts with
open positions, asks the contract how healthy each one is, and calls the
permissionless `deleverage` or `liquidate` when the contract's own numbers say
it may. Nothing here is trusted: the contract re-checks every call, and anyone
else can run the same bot.

## The liquidator earns nothing on-chain today

`MarginAccount.liquidate` sends the whole penalty (2% of the liquidated size,
capped at the collateral that survived the loss) to the `InsuranceFund`. The
caller is paid **nothing**, and `deleverage` charges no penalty at all. Every
transaction this keeper sends, including the `recordSample()` calls it makes so
that health can be read, is paid for out of our own gas budget. The e2e run
asserts this: the keeper's USDC balance is unchanged after liquidating two
accounts.

That is fine for a hackathon deployment where we are the only keeper, and it
means nobody else has a reason to run one. If Kanon is to be run by third
parties, a real incentive needs a contract change and a redeploy (the risk
parameters are immutable constructor arguments):

- a **liquidator reward**, paid out of the penalty (for example a fixed share of
  `min(size * liquidationPenaltyBps / 1e4, collateral left)` sent to
  `msg.sender` before the remainder goes to the fund), large enough to cover
  gas at the caps below with margin, and never paid out of another user's
  collateral beyond the existing penalty;
- a **reward for `deleverage`** too, or a small flat gas rebate from the fund,
  otherwise ADL stays a pure cost and accounts sit in the band until they fall
  through it;
- the reward has to be **arithmetic**, like everything else in the contract: no
  discretionary payout, no allowlist of keepers, no admin path;
- optionally a **`recordSample` rebate**, because on a quiet market the keeper is
  the one paying to make health readable at all (`MarginAccount` reverts
  `NoRecentPrice` when the current bucket has no sample).

Until then, budget the keeper's gas as an operating cost and treat
`MAX_GAS_PRICE_WEI`, `MAX_GAS_PER_TX` and `MAX_TXS_PER_PASS` as the ceiling on
that cost. Monad charges the gas **limit**, not the gas used, so the keeper
sets the limit to the estimate plus 20%, clamped to `MAX_GAS_PER_TX`.

## What a pass does

1. Checks the RPC reports `CHAIN_ID`. A mismatch aborts before any read or write.
2. Asks the account source for candidates (default: `PositionOpened` events over
   a block range) and merges them into the set being watched.
3. Reads `adlHealthThreshold()` and `LIQUIDATION_THRESHOLD()` from the contract.
4. For each account: `openPositionCount` (zero means dropped from the set), then
   `healthFactor(account)`. The keeper never recomputes health off-chain; it only
   compares the contract's number with the contract's thresholds.

   | Contract says | Keeper does |
   |---|---|
   | `health >= adlHealthThreshold` | skips it (`healthy`) |
   | `1.0 <= health < adlHealthThreshold` | `deleverage(account)`, repeated until healthy |
   | `health < 1.0` | `liquidate(account, id)` on the largest open position, repeated |
   | `healthFactor` reverts `NoRecentPrice` | `recordSample()` on the account's series, then re-reads |

5. Every write is simulated first. If the contract itself refuses
   (`NotLiquidatable`, `NotDeleverageable`, `NothingToDeleverage`,
   `PositionNotOpen`) someone else got there first: the account is reported
   `raced` and the loop moves on. That is not an error.
6. Then the caps are applied (gas estimate, network gas price, per-pass budget),
   and only then does `send` run, and only when broadcasting.

A failed simulation, a transaction that mines and reverts, a send that throws and
a failing read are each reported on their account. None of them stops the loop.
Nothing is remembered between passes except the set of accounts to look at, so a
restarted or duplicated keeper converges on the same state. The only fatal
errors are bad configuration and a chain-id mismatch.

## Running

```
pnpm --filter @kanon/keeper keep:dry     # one pass, read-only
pnpm --filter @kanon/keeper keep         # one pass; sends only if KEEPER_BROADCAST=true
pnpm --filter @kanon/keeper keep -- --watch --interval 15
```

Dry run is the default. Broadcasting needs `KEEPER_BROADCAST=true`, `PRIVATE_KEY`
and no `--dry-run` flag; either switch alone keeps the keeper read-only. In a dry
run there is no signer in the process at all, and writes are simulated and
reported as `would_send`. Use a dedicated funded key, not the relayer's or the
deployer's.

Output is one JSON object per line on stdout (`start`, `pass_start`, `action`,
`account`, `pass_end`, and a final `report` with the whole pass). bigint values
are decimal strings. Exit code is 0 when the pass had no failed read, failed
transaction or discovery error, 1 otherwise, 2 for bad configuration.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | required | JSON-RPC endpoint |
| `CHAIN_ID` | `143` | checked against the RPC every pass |
| `MARGIN_ACCOUNT_ADDRESS` | required | the `MarginAccount` to police |
| `START_BLOCK` | `0` | first block scanned for `PositionOpened`; set the deployment block on a real chain |
| `LOG_RANGE_BLOCKS` | `1000` | widest `eth_getLogs` range per request (lower it if the RPC limits ranges) |
| `REORG_DEPTH_BLOCKS` | `8` | blocks re-scanned each pass |
| `EXTRA_ACCOUNTS` | none | comma-separated addresses always checked |
| `MAX_GAS_PRICE_WEI` | `1000000000000` | no tx while the network price is above this; also the `maxFeePerGas` ceiling |
| `MAX_GAS_PER_TX` | `1500000` | no tx whose estimate is above this; also the clamp on the gas limit |
| `MAX_TXS_PER_PASS` | `20` | spend budget per pass (dry-run plans count too) |
| `MAX_ACTIONS_PER_ACCOUNT` | `8` | bounds the deleverage/liquidate loop on one account |
| `RECORD_SAMPLES` | `true` | call `recordSample()` when an account cannot be priced |
| `KEEPER_ADDRESS` | none | sender for dry-run simulations when no key is set |
| `KEEPER_BROADCAST` | `false` | must be exactly `true` to send |
| `PRIVATE_KEY` | none | required only when broadcasting |

All variables are validated in `src/config.ts`; a bad value prints every problem
at once and never echoes the key.

## Account discovery is pluggable

`src/source.ts` defines `AccountSource { poll(port) }`. The v1 source,
`createLogSource`, scans `MarginAccount.PositionOpened` in chunks of
`LOG_RANGE_BLOCKS`, keeps its cursor across passes, resumes mid-backfill after a
failed chunk, and re-scans the last `REORG_DEPTH_BLOCKS`. Every account that has
ever opened a position is a candidate; the keeper prunes the ones with nothing
open. The set lives in memory, so a restart re-scans from `START_BLOCK`.

To replace it with the Envio indexer (`packages/indexer`), implement `poll` to
return the accounts it knows about (an over-report only costs a few reads) and
pass it to `createKeeper` instead. The keeper trusts a source for nothing beyond
"look at these addresses".

## Tests

```
pnpm --filter @kanon/keeper test         # unit tests against a fake ChainPort
pnpm --filter @kanon/keeper typecheck
./packages/keeper/scripts/e2e-local.sh   # needs foundry (anvil, forge, cast) and jq
```

The unit tests cover: healthy skip, the ADL band (including repeats and
escalation to liquidation), liquidation ordering, races and reverts (simulation
race, mined revert, thrown send, failing read, discovery outage), dry-run never
calling `send`, sample recording, the gas/fee/budget caps, the chain-id check,
idempotence, and config validation. `abi.test.ts` checks every ABI entry the
keeper uses against `packages/contracts/abi/MarginAccount.json`.

`scripts/e2e-local.sh` starts its own anvil (port `ANVIL_PORT`, default 8646),
deploys with `Deploy.s.sol` and MockPyth, opens three positions, and moves the
mock price. It runs a dry pass (nothing changes), then a broadcast pass that
deleverages the account in the ADL band, liquidates the underwater one and skips
the healthy one; a second pass that does nothing; and a final pass in an
unsampled bucket where the keeper records the sample itself before liquidating.
It ends by asserting the keeper's USDC balance did not change. Anvil is killed on
exit. It never touches a real network.
