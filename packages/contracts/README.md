# @kanon/contracts

Foundry package for Kanon's on-chain layer. Two things live here:

1. The rule-enforcement core (`CanonicalSeries`, `StrategyRegistry`, `RefusalGate`)
   described in `docs/ARCHITECTURE.md`.
2. `ThresholdMarket`, settlement for the Predict tab — the first on-chain piece
   of the broader multi-asset trading terminal.
3. `MarginAccount`, `GuardedVault` and `CopyVault` — the margin, guarded-agent-
   vault and copy-trading contracts `ThresholdMarket.sol`'s TODO named as the
   next follow-up. See "What's implemented" and "Explicit stubs / follow-ups"
   below for exactly what each one does and does not do yet.
4. `InsuranceFund`, `VaultFactory` and the risk engine v1 (partial
   de-leveraging, liquidation penalty, cross-margin debt) built on top of
   `MarginAccount`; `script/Deploy.s.sol` deploys the whole system and writes
   `deployments/<chainid>.json`; `abi/` holds every ABI. See "Risk engine v1",
   "Deploying", "ABIs" and "Event reference" below.

Build and test:

```
pnpm --filter @kanon/contracts build   # forge build
pnpm --filter @kanon/contracts test    # forge test
```

or, from this directory, `forge build` / `forge test` directly.

## What's implemented

- **`CanonicalSeries.sol`** — Path 1 from `docs/ARCHITECTURE.md`: pins `asset`,
  `feed`, `cadenceSeconds`, `bucketSeconds` at construction (immutable, or
  immutable-by-convention for `asset`, since Solidity doesn't allow `immutable`
  on `string`). `recordSample()` is permissionless, gated on the cadence having
  elapsed, and pulls a Pyth price via `IPyth.getPriceNoOlderThan`, bucketing it
  by the price's own `publishTime`. Empty buckets stay empty — no interpolation,
  no carry-forward, no synthesized price. `swingHigh`/`swingLow` read only
  `recorded` candles over a caller-given bucket range and return `found = false`
  (not a fabricated zero) when the range has no recorded candles at all.
- **`StrategyRegistry.sol`** — Pins three things together: the spec hash
  (SHA-256, opaque to the chain), a **predicates commitment**
  (`keccak256(abi.encode(RefusalGate.PredicateDefinition[]))`, the part the
  chain can check) and the one canonical **series** the predicates run against.
  `pinStrategy(specHash, predicatesCommitment, series)` (payable, bond-gated),
  `tighten(id, specHash, predicatesCommitment, series)` (applies immediately),
  `proposeLoosening(id, specHash, predicatesCommitment, series)` +
  `finalizeLoosening(id)` (cooldown enforced with no override; a new
  commitment or a new series is a spec change and waits out the same
  countdown — `finalizeLoosening` is permissionless so no admin key is even
  *needed*). The series must be in the registry's **immutable canonical set**
  (constructor argument), so a strategy cannot be pinned to a lookalike series.
  No admin function anywhere in this contract.
- **`PredicateEngine.sol`** — The on-chain port of `packages/spec/src/evaluate.ts`
  (item 1's hardening (b), now resolved — see below). A library with `internal`
  view functions `evaluateBreakOfStructure`, `evaluateFairValueGap` and
  `evaluateLiquiditySweep`, each reading candles directly from an
  `ICanonicalSeries` and returning a `PredicateResult` (`satisfied`,
  `decidingValue`, `referenceValue`, `atBucketIndex`, `atTimestamp`) — the
  Solidity mirror of `evaluate.ts`'s own `PredicateResult`. Every boundary
  convention (strict break-of-structure crossing, inclusive fair-value-gap
  threshold, strict liquidity-sweep wick/close boundary) is copied verbatim
  from `evaluate.ts`'s doc comment, not reinterpreted, and cross-checked
  against `packages/spec/src/evaluate.test.ts`'s own fixture numbers in
  `test/PredicateEngine.t.sol`. `prev_session_*` is still treated identically
  to `prev_day_*` — the exact same simplification `evaluate.ts` documents
  (no session-boundary spec exists anywhere in this codebase) — carried over
  on-chain rather than resolved here; still a named simplification, not a
  silent one, on both sides.
- **`RefusalGate.sol`** — `evaluateOnChain(strategyId, isLong, predicates)` is
  the only evaluation path (`isLong` is the trade side being proposed; it must
  equal the side the committed predicates authorize, see "Trade side"). The series comes from the registry; the predicates must
  hash to the strategy's pinned commitment (`CommitmentMismatch` otherwise);
  there is no caller-chosen scan window (the window is derived on-chain from
  the series' latest bucket and the predicate's own committed lookback, see
  "Enforcement binding"); the latest bucket must be recorded (`StaleSeries`).
  It emits `TradeProposed` or `TradeRefused` (first failing predicate and its
  number) and returns the bool. `previewOnChain` is the same evaluation with no
  events, for clients. The old attested `evaluate(...)` is **removed**.
- **`ThresholdMarket.sol`** — Binary threshold market over a `CanonicalSeries`.
  `openMarket` fixes a question ("does price reach ≥/≤ `thresholdPrice`
  during `[windowStart, windowEnd]`"), `takeSide` stakes on yes/no,
  permissionless `settle` reads only recorded candles in that window via
  `swingHigh`/`swingLow` and marks the market **unresolvable** — never guesses
  a side — when there are zero recorded candles in range. `claim` pays out
  pari-mutuel: proportional to stake, principal-plus-share-of-the-losing-pool
  for winners, full refund for both sides on an unresolvable market or when
  the winning side has zero stake. **Staking closes the moment the series has
  recorded a crossing sample** (`MarketCrossed`) and requires a fresh series
  (`StaleSeries`; `takeSide` refreshes a stale tape itself) — see "Predict
  market: no staking on information already in the series". Series ids are
  fixed by the constructor (`ThresholdMarket(bytes32[] seriesIds, address[]
  seriesContracts)`); there is no `registerSeries`.
- **`MarginAccount.sol`** — On-chain side of the cross-margin ledger; the
  off-chain mirror is `packages/backend/convex/accounts.ts` and `positions.ts`
  (this contract's field shapes — collateral, per-position asset/side/size/
  entry price — deliberately match theirs). `deposit`/`withdraw` move a mock-
  USDC-equivalent `IERC20`. `openPosition` records entry price from the
  *current bucket* of a caller-given `CanonicalSeries` — it reverts
  (`NoRecentPrice`) rather than use a stale or interpolated price if nobody
  has called that series' `recordSample()` in the current bucket, the same
  "never synthesize" rule `CanonicalSeries` itself enforces. `healthFactor`
  is a pure-arithmetic view (equity vs. maintenance requirement, 1e18 == 100%,
  below that is liquidatable) with no external call beyond those series
  reads. `liquidate` is permissionless and callable by anyone once
  `healthFactor(account) < 1e18` — the v1 risk engine is a keeper pattern,
  not a trusted operator. `closePosition` (self-service) is scoped to
  `msg.sender`'s own positions, so nobody can reach into another account's
  ledger through it. Risk engine v1 (below) adds partial de-leveraging, a
  liquidation penalty, cross-margin debt and the insurance-fund backstop;
  the constructor is now
  `(collateralToken, maintenanceMarginBps, insuranceFund, liquidationPenaltyBps, adlHealthThreshold, adlFractionBps, refusalGate)`.
  An account may `bindStrategy(strategyId)` (one-way) to become rule-bound: its
  `openPosition` closes and `openGuardedPosition(isLong, size, predicates)`
  opens only if the strategy's pinned predicates pass in the same tx.
- **`InsuranceFund.sol`** — Backstop for liquidation bad debt. Funded by the
  liquidation penalty and explicit `deposit`s. The only outflow is
  `coverShortfall`, callable only by the bound `MarginAccount` and paying only
  to it. No owner, no admin, no withdrawal function.
- **`VaultFactory.sol`** — Creates `GuardedVault`/`CopyVault` instances for the
  caller (`msg.sender` is the owner/follower), wired to the deployment's
  immutable collateral token, `StrategyRegistry` and `RefusalGate`, and (for
  `GuardedVault`) to one of the factory's immutable `CanonicalSeries`
  allowlist. `isVault(addr)` / `vaultKindOf(addr)` let anyone verify a vault
  was made here; `guardedVaultsOf(owner)` / `copyVaultsOf(follower)` list them.
- **`GuardedVault.sol`** — The "Guarded AI Agent Vault." A vault tied to one
  `StrategyRegistry` strategy, with an on-chain asset whitelist and a
  `maxDailyDrawdownBps` cap, both immutable at construction with no setter
  ever — a different guardrail means a new vault, not an admin call. Also
  immutably bound to one `RefusalGate`; the series is the strategy's pinned
  series, not a vault parameter. `proposeTrade(assetId, isLong, size,
  projectedPnL, predicates)` (callable only by the vault's `owner` or its
  `strategyExecutor`) checks, in order: the asset against the whitelist; the
  strategy's pinned predicates via `RefusalGate.evaluateOnChain` **in the same
  transaction**; and the still-attested `projectedPnL` against a per-UTC-day
  drawdown budget. A whitelist, predicate or drawdown failure does **not**
  revert — it emits `TradeRefused` and returns `false` (refusal is a success
  state). Setup errors (predicates not matching the commitment, stale series)
  revert.
- **`CopyVault.sol`** — Non-custodial copy trading. A follower deposits
  collateral, sets an immutable `allocationBps` (how much of their capital
  mirrors the leader) and `feeShareBps`, and references a leader's
  `StrategyRegistry` strategy. `mirrorOpen`/`mirrorClose` (callable only by
  the vault's `leaderExecutor`) scale the leader's attested trade by
  `allocationBps` (and `mirrorOpen` only mirrors while the leader's own pinned
  predicates pass `RefusalGate` in the same tx, else `TradeSkipped`) and, on
  close, charge `feeShareBps` **only** when realized
  P&L is positive — `test/CopyVault.t.sol` proves this with a matched
  profit/loss pair. `active` is a follower-only kill switch with no lock-in,
  no cooldown, and no admin override: unfollowing takes effect immediately.

## Explicit stubs / follow-ups

Tracked here so they don't get silently assumed as "done":

1. **RESOLVED — the gate now binds the proposer to the pinned rules; the
   attested path is gone.** The previous `evaluateOnChain` took the predicates,
   the series and each predicate's scan window from the proposer and only
   checked a proposer-supplied `expectedSpecHash` (a SHA-256 the chain cannot
   recompute) against the registry, so nothing tied the supplied rules to the
   pinned spec; and `evaluate` trusted a caller-supplied `satisfied`. Both were
   ways to obtain a `TradeProposed` for easier rules. Now: the registry commits
   `keccak256(abi.encode(predicates))` and the series alongside the spec hash;
   `evaluateOnChain(strategyId, predicates)` reverts unless the predicates hash
   to the commitment; the series is read from the registry; the window is
   derived on-chain; a stale series reverts; and `evaluate` is deleted (see
   "Enforcement binding" for why it is deleted rather than gated). The
   arithmetic itself is the port of `packages/spec/src/evaluate.ts` in
   `PredicateEngine.sol`, with its boundary conventions unchanged (strict BOS
   crossing, inclusive FVG threshold, strict sweep wick/close) and
   cross-checked in `test/PredicateEngine.t.sol`.
   **Named simplification, carried over from `evaluate.ts`:**
   `prev_session_*` is treated identically to `prev_day_*` on both sides.
   **Named divergence from the TS reference:** the TS evaluator answers "did
   this setup happen anywhere in the series"; the on-chain gate answers "does
   it hold at the latest candle", because a live trade must be approved by the
   setup that exists now. A gap in the derived window (an unrecorded bucket
   inside it) is a refusal, never bridged — sparse Pyth series will therefore
   refuse more often on-chain than the off-chain evaluator would.
2. **`StrategyRegistry.tighten` vs `proposeLoosening` trust boundary.** Whether
   a new spec is a tightening or a loosening is a semantic comparison over
   typed spec parameters; this contract only ever sees opaque `bytes32`
   hashes, so it cannot verify the caller's claim about which one they're
   doing. The caller asserts it by which function they call. Documented in
   detail in `StrategyRegistry.sol`'s contract-level NatSpec. Closing this
   gap needs either an on-chain partial-order check over decoded spec
   parameters, or a signed attestation from the spec-review UI proving
   direction of change — both follow-up work.
   **This now also covers the predicates commitment and the series**: a
   `tighten` that swaps in a different commitment (say, shorter lookbacks)
   applies immediately, exactly like a `tighten` of any other parameter, so a
   compromised owner key can still *loosen through `tighten`*. The registry
   cannot tell from `keccak` hashes. **Proposed, not built:** commit the
   predicates as decoded parameters instead of a hash and have
   `RefusalGate`/`StrategyRegistry` compare old and new field by field
   (per predicate: lookback `>=`, gap threshold `>=`, same kind/direction,
   predicate set superset) so `tighten` reverts unless the new spec is
   pointwise at least as strict, and everything else is routed through
   `proposeLoosening` automatically. That is a partial order over a small,
   fixed struct and is pure arithmetic; it still leaves the non-predicate
   parts of the spec (risk parameters) unclassified because they are only in
   the SHA-256 hash.
3. **No bond withdrawal path.** `StrategyRegistry.pinStrategy` locks the bond
   in the contract for the strategy's lifetime; there is no unpin/withdraw
   function in this pass.
4. **RESOLVED — `ThresholdMarket` series ids are fixed at construction.**
   `registerSeries` is gone; the (id -> `CanonicalSeries`) map is set once in the
   constructor, so an id cannot be front-run, squatted or re-pointed. A new
   series means a new market contract.
5. **Pari-mutuel payout was a judgment call.** The task that produced this
   package said "equal-weighted pool split among winners." That phrase could
   mean per-stake (pari-mutuel, what's implemented) or literally per-head
   regardless of stake size. Per-head is trivially griefable (stake 1 wei,
   capture an equal share of the pool) and isn't how real prediction markets
   pay out, so pari-mutuel was chosen. No AMM, no odds curve — explicitly out
   of scope per the task.
6. **Margin / vault / copy-trading contracts are now built** —
   `MarginAccount.sol`, `GuardedVault.sol`, `CopyVault.sol` — following the
   patterns named in `ThresholdMarket.sol`'s former TODO: immutable pinned
   config, permissionless settlement/liquidation gated on recorded on-chain
   data only, no admin override anywhere. Their own remaining stubs are
   itemized below (7–11); they are not a smaller version of the same gap,
   they are new, more specific ones.
7. **PARTIALLY RESOLVED — `GuardedVault.proposeTrade` is gated on the pinned
   rules but still does not execute anything.** It is immutably bound (at
   construction) to a `RefusalGate`, and `proposeTrade` calls
   `refusalGate.evaluateOnChain(strategyId, predicates)` in the same
   transaction and honours only the bool it returns. What is **not** closed:
   `proposeTrade` does not route an allowed trade to Perpl/Kuru or anywhere
   else — nothing on-chain moves funds *because* a trade was proposed, so a
   `TradeProposed` is a recorded, enforced-at-proposal decision that an
   off-chain executor then acts on. `projectedPnL` remains a caller-attested
   figure realized into the vault's daily P&L ledger. (The trade side *is*
   now bound to the committed predicates — see "Trade side".)
8. **`CopyVault.mirrorOpen`/`mirrorClose` still take an attested trade
   record.** Asset id, direction, leader size and entry/exit price come from
   `leaderExecutor`; the vault does not read a `CanonicalSeries` to verify them
   or observe real fills. What changed: `mirrorOpen` now only mirrors while the
   leader strategy's own pinned predicates pass `RefusalGate` in the same
   transaction (else `TradeSkipped("PREDICATE_NOT_SATISFIED")`); `mirrorClose`
   is deliberately never gated. Full automatic mirroring still needs real
   execution wiring.
9. **`CopyVault.collateral` is a P&L ledger, not a live escrow.** Mirrored
   positions don't move any ERC20 when opened (nothing to send it to — no
   execution venue is wired), and a realized profit credits the ledger
   without new tokens entering the vault to back it. That only becomes real
   money once real execution (item 8) actually settles funds in. `withdraw`
   is bounded by the ledger, not by this contract's actual token balance, so
   withdrawing unbacked paper profit fails loudly on the underlying
   `transfer` rather than silently succeeding — a known, documented
   limitation of the stub, not a silent one. The `feeShareBps` cut on profit
   is computed and emitted (`PositionClosed.feeCharged`) but, for the same
   reason, never actually transferred to `feeRecipient` in this pass.
10. **RESOLVED (v1) — `MarginAccount` now has partial de-leveraging and an
    insurance fund.** See "Risk engine v1" below for the exact rules. What v1
    still does not do: (a) it does not socialize bad debt the fund cannot
    cover — the remainder is recorded in `uncoveredBadDebt` and emitted, on
    purpose, because socializing would move one user's collateral to cover
    another's loss; (b) the liquidator is not paid (the whole penalty goes to
    the fund), so liquidation relies on anyone-can-call keepers, not on an
    incentive; (c) there is no liquidity pool behind winning trades, so a
    realized profit is a ledger credit that is only withdrawable to the extent
    tokens back it (`withdraw` reverts on the token transfer rather than
    overpay); the ledger identity below tracks exactly how far this is from
    fully backed via `counterpartyBalance < 0`.
11. **`MarginAccount` price reads require a same-bucket `recordSample`.**
    `openPosition`, `healthFactor` and `liquidate` all read only the
    *current* bucket of a position's `CanonicalSeries`; if nobody has called
    that series' permissionless `recordSample()` since the bucket rolled
    over, every one of those calls reverts (`NoRecentPrice`) rather than
    fall back to a stale price. This is the same "never synthesize" honesty
    rule `CanonicalSeries` itself already enforces, but it does mean a
    position can't be valued or liquidated in a bucket nobody has sampled —
    in practice, whoever wants to liquidate an unhealthy position also needs
    to call `recordSample()` first, which anyone can do at no cost to this
    contract.
12. **Pyth SDK is a local stand-in, not the vendored upstream package.** See
    "Pyth interface" below for why, and exactly what was tried first.
13. **`CanonicalSeries.priceExpo` drift reverts rather than adapts.** If a Pyth
    feed ever changes its exponent mid-life, every subsequent `recordSample`
    call reverts. Recovery would require a new series contract; there's no
    in-place migration.

## Enforcement binding

What the gate enforces, what it does not, and what actually stops a trade
on-chain.

**Audit finding this section responds to.** `RefusalGate` only emits events
and returns a bool. If nothing downstream requires that bool to be true, the
gate is advisory. Before this change the only consumer was
`GuardedVault.proposeTrade`, which itself moves no funds (execution is
off-chain), and `MarginAccount.openPosition` was not connected to the gate at
all. Now every path that *acts* on a strategy requires the gate's `true`:

| Path | Requires |
|---|---|
| `GuardedVault.proposeTrade` | `evaluateOnChain(strategyId, isLong, predicates)` passes, same tx |
| `MarginAccount.openGuardedPosition` (rule-bound accounts) | same, same tx; `openPosition` is closed to a bound account |
| `CopyVault.mirrorOpen` | leader strategy's `evaluateOnChain` passes, same tx, else `TradeSkipped` |

**Design: atomic same-transaction approval, no stored approval.** The
alternative (a `(strategy, caller, block)` approval record consumed by the
acting contract) needs storage, a consume step, protection against another
contract burning or borrowing the record, and a same-block rule; the atomic
form needs none of that. The acting contract calls the gate itself and honours
only the returned bool, so there is nothing to replay across blocks, borrow
across callers, or front-run. A pass obtained by calling the gate directly
authorizes nothing because no downstream contract reads events or storage from
it (`test_ApprovalIsNotStored...` asserts the gate writes no storage). The
events remain the evidence trail, not the enforcement.

**What the caller can and cannot supply to `evaluateOnChain(strategyId, isLong,
predicates)`:**

- *Cannot* supply the series: it is `registry.activeSeries(strategyId)`, and
  the registry only accepts series from its immutable canonical set.
- *Cannot* supply different predicates: `keccak256(abi.encode(predicates))` must
  equal `registry.activePredicatesCommitment(strategyId)` or it reverts
  `CommitmentMismatch`. Order, count and every field are committed (kind,
  symbol, direction, lookback, gap threshold, reference extreme, sweep
  lookback, timeframe).
- *Cannot* supply a scan window (there is no such field). **Window rule**
  (`PredicateEngine.windowStart`, documented in its NatSpec): the window always
  ends at the series' current bucket, which must already be recorded
  (`StaleSeries`), and starts at `latest - N` for break of structure (N+1
  buckets), `latest - 2` for fair value gap (3 buckets), `latest - lookback /
  bucketSeconds` for a swing-reference sweep, and the first bucket of the
  previous UTC day for a prev-day/session sweep. Only the latest candle is ever
  decided on, so an older setup inside the window cannot approve a trade now.
- *Cannot* trade the wrong side: see "Trade side" below.
- *Cannot* mismatch timeframes: each predicate commits `timeframeSeconds`,
  which must equal the series' `bucketSeconds` (`TimeframeMismatch`).
- *Cannot* turn a failure to evaluate into an approval: a gap in the window, no
  reference history or a window too wide to scan is a **refusal** naming the
  predicate (`decidingValue == 0`); evaluation runs in a try/catch self-call so
  even an out-of-gas scan can only refuse.

**Why `evaluate(...)` was deleted rather than gated.** It trusted a
caller-supplied `satisfied` and a caller-supplied `expectedSpecHash` the chain
cannot relate to anything. An approval the chain cannot recompute is not an
approval, and any downstream contract that honoured it would reopen the gap, so
there is no configuration in which it is safe. `test_AttestedEvaluate_DoesNotExist_CannotProduceAnApproval` asserts the legacy selector reverts and emits nothing.

**Rule-bound margin accounts.** `MarginAccount.bindStrategy(strategyId)` (caller
must own the strategy; one-way, no unbind, no admin) makes `openPosition`
revert for that account and leaves `openGuardedPosition` as the only way to open
a position; the position is priced from the strategy's own series. Closing,
withdrawing, liquidation and de-leveraging are never gated, so a bound account
can always get out. Binding is per address: it enforces your rules on the
accounts you bind, it does not claim to stop you using another address.

**TypeScript side.** `packages/spec` `encodePredicates(spec)` produces exactly
the bytes `abi.encode(PredicateDefinition[])` produces; `predicatesCommitment(
spec)` is their keccak256. A vector generated with `cast abi-encode` is asserted
by both `packages/spec/src/onchain.test.ts` and
`test/RefusalGate.t.sol::test_EncodingVector_MatchesTypeScript`.

### Trade side

`evaluateOnChain` takes the side being proposed (`isLong`) and approves only the
side every committed predicate authorizes. The mapping is a function of
committed fields (`TradeSide.predicateSide`, one library used by the gate, hence
by all three consumers):

| Predicate | Authorizes |
|---|---|
| break of structure | its `direction` (bullish = long, bearish = short) |
| fair value gap | its `direction` |
| liquidity sweep | fixed by `referenceExtreme`: a LOW reference (`PrevDayLow`, `PrevSessionLow`, `SwingLow`) is a long setup, a HIGH reference a short setup. The committed `direction` must agree, else `InconsistentSweepDirection(i)` |

A rule's side is the common side of all its predicates. **Mixed sets are
rejected**, not given a meaning: predicates are ANDed, and a long setup ANDed with
a short setup describes no single trade, so `MixedDirections` reverts (for either
`isLong`). A wrong-side trade is a **refusal**, not an error: `evaluateOnChain`
returns `false` and emits `TradeRefused(strategyId, specHash, proposer,
"SIDE_MISMATCH", ruleSide)` where `ruleSide` is 1 if the rule authorizes longs,
0 if shorts. That check needs only the committed predicates, so it refuses even
on a stale series. `packages/spec` `encodePredicates` refuses to encode a mixed
rule, a contradictory sweep, or predicates that disagree with `spec.direction`.

**Known remaining gaps (not closed here):** the tighten-vs-loosen
classification (item 2), attested `projectedPnL`/entry prices (items 7-8), and
feed-manipulation, which is documented in `docs/ARCHITECTURE.md`, not solved.

## Vault loosening hold

`GuardedVault` limits (asset whitelist, daily drawdown cap) are immutable, so
"loosening" one means creating a *looser vault* and moving funds into it. The
app's cooling-off could be bypassed by calling `VaultFactory` directly. Closed
at the factory:

- The factory tracks, per (owner, strategy), the limits of the owner's newest
  vault (its **posture**).
- A vault that is tighter-or-equal (cap `<=` AND every asset already in the
  posture's whitelist; order and duplicates irrelevant) is created immediately
  and becomes the new posture. The first vault for a strategy has nothing to
  loosen.
- A **looser** vault needs a matching `requestLooserVault(strategyId,
  whitelist, cap)` made at least `registry.loosenCooldownSeconds()` earlier
  (`NoLoosenRequest` / `LoosenHold(availableAt)`), and consumes it. Requesting
  again does not restart the clock; a request authorizes exactly one set of
  limits. There is no way to skip or shorten the wait.
- Because the posture is always the newest vault, "create a tight vault, then a
  looser one straight after" is a loosening and waits.

Views: `postureOf`, `postureAllowsAsset`, `isLooserThanPosture`,
`looserVaultRequestId`, `loosenRequestedAt`. Event: `LooserVaultRequested`.

**Scope, stated plainly.** This governs vaults the factory recognizes
(`isVault`). A `GuardedVault` deployed by hand is not recognized by the factory,
the indexer or the app. A different owner address, or a newly pinned strategy
(which costs a bond and a pin), starts with no posture — a contract cannot tell
one person's addresses apart. `CopyVault`'s allocation and fee are immutable
too and are **not** covered by this hold.

## Predict market: no staking on information already in the series

`ThresholdMarket` accepted stakes until `windowEnd`, so anyone calling the
contract directly could stake on the winning side after the series had already
recorded the crossing. Fixed on-chain, as arithmetic over the series:

- **Crossing closes staking (`MarketCrossed`).** The question is monotone: once
  a recorded sample in `[bucketIndexOf(windowStart), bucketIndexOf(min(windowEnd,
  now))]` has `high >= threshold` (`above`) or `low <= threshold` (`!above`),
  YES is decided and cannot be undone. `takeSide` reverts for either side. This
  is the exact condition and bucket range `settle` uses (touch counts, the
  bucket containing `windowEnd` is included). No separate `stakeDeadline` is
  needed: there is nothing ambiguous to resolve, and the NO side is only decided
  at `windowEnd`, which is when staking closes anyway. `hasCrossed(marketId)`
  exposes the same test as a view.
- **Fresh series required (`StaleSeries`).** The series' last sample must be at
  most one `cadenceSeconds` old. If it is older, `takeSide` calls the series'
  permissionless `recordSample()` itself (try/catch) and re-checks; a still-stale
  tape reverts. Because the sample is taken in the same transaction and scanned
  before the stake is accepted, a stale tape cannot hide a crossing the feed
  already shows (`test_TakeSide_FreshSampleTakenInTheSameTxRevealsAHiddenCrossing`).
  Residual, stated plainly: information newer than the last sample by up to one
  cadence is not in the tape.
- **`openMarket` rejects windows wider than 2,000 buckets** (`MAX_WINDOW_BUCKETS`,
  mirrors `CanonicalSeries.MAX_LOOKBACK_BUCKETS`): such a market could never be
  settled or checked.
- **Squat resistance.** `registerSeries` is removed; the ids are set in the
  constructor `ThresholdMarket(bytes32[] seriesIds, address[] seriesContracts)`.
- **Tests**: stake-before-cross works, stake-after-cross reverts (both
  directions, both sides), touching the threshold counts and one tick short does
  not, buckets before/first/last of the window, staleness, and a fuzz
  (`testFuzz_NoStakerProfitsFromInformationAlreadyInTheSeries`) that checks every
  accepted stake against an independent ghost model of the tape and that no stake
  postdates the recorded crossing. Mutation-checked: removing either the crossing
  check or the freshness check fails a test.

## Risk engine v1

All of it is permissionless, arithmetic-only, immutable-parameter, with no
trusted operator and no override.

**Health factor** — `equity * 1e18 / maintenance`, where
`equity = collateral - debt + sum(unrealized PnL)` and
`maintenance = sum(size * maintenanceMarginBps / 1e4)` over open positions. An
account with no open positions is `type(uint256).max`.

| Band | Condition | What anyone can do |
|---|---|---|
| Healthy | `h >= adlHealthThreshold` | nothing |
| ADL | `1e18 <= h < adlHealthThreshold` | `deleverage(account)` |
| Liquidatable | `h < 1e18` | `liquidate(account, positionId)` |

**Documented defaults** (`Deploy.s.sol`; every one is an immutable constructor
argument, changed only by redeploying):

| Parameter | Default | Meaning |
|---|---|---|
| `maintenanceMarginBps` | 500 | 5% of size |
| `adlHealthThreshold` | 1.2e18 | ADL band is [1.0, 1.2) |
| `adlFractionBps` | 2500 | one `deleverage` closes 25% of the largest position |
| `liquidationPenaltyBps` | 200 | 2% of the liquidated size, paid to the fund |

**ADL v1 (`deleverage`)** closes `adlFractionBps` of the account's largest open
position (by `size`; lowest position id on a tie) at the current
`CanonicalSeries` price and realizes that slice's PnL. The remaining position
keeps its entry price. Equity is unchanged (up to 1 unit of integer-division
rounding, fuzz-tested), but the closed slice no longer needs maintenance
margin, so the health factor rises. No penalty is charged. Repeated calls stop
once health reaches the threshold.

**Liquidation** closes one whole position, charges
`min(size * liquidationPenaltyBps / 1e4, collateral left after the loss)` and
sends it to the `InsuranceFund`. The caller is paid nothing.

**Cross-margin debt** — if a realized loss exceeds collateral, the excess is
account-level *debt*, not an immediate write-off: another open position may
still hold gains that cover it, and writing it off early would let the owner
keep those gains and hand the fund the loss. Debt is netted against later
realized gains, repaid first by deposits, counted in `healthFactor`, and blocks
withdrawal. Only when the account has **no open positions** left and debt
remains does the contract call `InsuranceFund.coverShortfall(debt)`; whatever
the fund cannot pay is `uncoveredBadDebt` (event `BadDebtResolved`).

**Ledger identity** (asserted as a Foundry invariant):

    token.balanceOf(MarginAccount) == totalCollateral + counterpartyBalance

`counterpartyBalance` is realized losses retained + fund cover received -
realized profits credited; negative means winners have been credited more than
losers paid in (the "no liquidity pool" limitation in item 10).

**Other bounds**: at most `MAX_OPEN_POSITIONS` (16) open positions per account
(so an account cannot grow a position list large enough to make its own
liquidation run out of gas), and a per-position size cap of `2^128 - 1`.

**Tested** (`test/RiskEngine.t.sol`, `test/InsuranceFund.t.sol`,
`test/MarginInvariants.t.sol`): band boundaries on both sides, largest-position
and tie selection, penalty cap, fund cover full/partial/none, cross-margin debt
netting/repayment/resolution, and invariants under random sequences of every
external action: collateral conservation, no token created/destroyed/leaked,
only an account's owner moves that account's wallet tokens, liquidate/deleverage
only succeed inside their bands and never pay the caller, ADL never lowers
health, the fund's balance is exactly inflows minus shortfall cover.

## Deploying

```
# local: anvil + MockPyth + a 6-decimal mock USDC (chain 31337 auto-selects mocks)
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 \
  --private-key <key> --broadcast

# Monad mainnet (143): real Pyth, real collateral token, no mocks
COLLATERAL_TOKEN=<usdc> forge script script/Deploy.s.sol:Deploy \
  --rpc-url <rpc> --private-key <key> --broadcast
```

It deploys `CanonicalSeries` (BTC/USD, ETH/USD, 15m buckets, 60s cadence),
`StrategyRegistry`, `RefusalGate`, `ThresholdMarket`, `InsuranceFund`,
`MarginAccount`, `VaultFactory`, and writes `deployments/<chainid>.json`
(flat: `chainId`, `startBlock` for the indexer, `mocks`, `deployer`,
`CollateralToken`, `Pyth`, `CanonicalSeriesBTCUSD`, `CanonicalSeriesETHUSD`,
`StrategyRegistry`, `RefusalGate`, `ThresholdMarket`, `InsuranceFund`,
`MarginAccount`, `VaultFactory`, and the risk/registry parameters used).
`deployments/31337.json` is gitignored (regenerated by the e2e script).

`InsuranceFund` and `MarginAccount` reference each other. The fund is
constructed with the `MarginAccount`'s *predicted* CREATE address and
`MarginAccount`'s constructor asserts `fund.margin() == address(this)` — no
privileged binder, no setter.

`GuardedVault`/`CopyVault` are per-user and created through
`VaultFactory.createGuardedVault(...)` / `createCopyVault(...)`.

**End-to-end on a local chain**: `./script/e2e-local.sh` starts an anvil,
deploys everything, and runs (79 assertions, exits non-zero on the first
failure): pin a strategy (spec hash + predicates commitment + series), record
candles, create a vault via the factory, an allowed trade, refusals (whitelist,
drawdown, and the same approved calldata refused once the market turns — each a
*successful* transaction), cheaper/tampered predicates and a stale series
reverting, the removed attested path, open a leveraged position, ADL,
liquidation with the penalty landing in the fund, a shortfall covered by the
fund, the ledger identity, a rule-bound margin account (guarded open passes,
then is refused, ungated open closed), and a Predict market that stops
accepting stakes once the tape shows the crossing.

## ABIs

`./script/export-abi.sh` (add `--no-build` to skip `forge build`) writes
`abi/<Name>.json` (bare JSON array) for `CanonicalSeries`, `StrategyRegistry`,
`RefusalGate`, `ThresholdMarket`, `InsuranceFund`, `MarginAccount`,
`GuardedVault`, `CopyVault`, `VaultFactory` and `IERC20`, plus
`abi/index.json`. `PredicateEngine` is an internal library with no ABI. The
`abi/` directory is committed so clients need not run forge.

## Event reference

Names and argument lists below are a stable interface for the indexer; changing
one is a breaking change. `indexed` arguments are marked.

**CanonicalSeries** — `SampleRecorded(uint256 indexed bucketIndex, int64 price, int32 expo, uint256 publishTime, address indexed caller)`

**StrategyRegistry** (names unchanged; the commitment and series were added to each, so the topic hashes changed) —
`StrategyPinned(uint256 indexed strategyId, address indexed owner, bytes32 specHash, uint256 bond, bytes32 predicatesCommitment, address series)` ·
`Tightened(uint256 indexed strategyId, bytes32 oldSpecHash, bytes32 newSpecHash, bytes32 newPredicatesCommitment, address newSeries)` ·
`LooseningProposed(uint256 indexed strategyId, bytes32 pendingSpecHash, bytes32 pendingPredicatesCommitment, address pendingSeries, uint256 cooldownEndsAt)` ·
`LooseningFinalized(uint256 indexed strategyId, bytes32 oldSpecHash, bytes32 newSpecHash, bytes32 newPredicatesCommitment, address newSeries)`

**RefusalGate** — `TradeProposed(uint256 indexed strategyId, bytes32 indexed specHash, address indexed proposer)` ·
`TradeRefused(uint256 indexed strategyId, bytes32 indexed specHash, address indexed proposer, bytes32 predicateSymbol, int256 decidingValue)`

**ThresholdMarket** — `SeriesRegistered(bytes32 indexed seriesId, address indexed seriesContract)` ·
`MarketOpened(uint256 indexed marketId, bytes32 indexed seriesId, int256 thresholdPrice, bool above, uint256 windowStart, uint256 windowEnd)` · `SideTaken(uint256 indexed marketId, address indexed staker, bool takesYes, uint256 amount)` ·
`MarketSettled(uint256 indexed marketId, bool yesWon)` · `MarketUnresolvable(uint256 indexed marketId)` ·
`Claimed(uint256 indexed marketId, address indexed staker, uint256 amount)`

**MarginAccount** — `Deposited(address indexed account, uint256 amount)` ·
`Withdrawn(address indexed account, uint256 amount)` ·
`PositionOpened(address indexed account, uint256 indexed positionId, address indexed seriesContract, bool isLong, uint256 size, uint256 entryPrice)` ·
`PositionClosed(address indexed account, uint256 indexed positionId, uint256 exitPrice, int256 pnl, bool wasLiquidation)` ·
`PositionDeleveraged(address indexed account, uint256 indexed positionId, uint256 closedSize, uint256 remainingSize, uint256 exitPrice, int256 pnl, uint256 healthFactorBefore, uint256 healthFactorAfter)` ·
`LiquidationPenaltyCharged(address indexed account, uint256 indexed positionId, uint256 penalty)` ·
`DebtIncurred(address indexed account, uint256 amount)` ·
`DebtRepaid(address indexed account, uint256 amount)` ·
`BadDebtResolved(address indexed account, uint256 debt, uint256 coveredByFund, uint256 uncovered)` ·
`StrategyBound(address indexed account, uint256 indexed strategyId)`

**InsuranceFund** — `Deposited(address indexed from, uint256 amount)` ·
`PenaltyReceived(uint256 amount)` · `ShortfallCovered(uint256 requested, uint256 covered)`

**VaultFactory** — `GuardedVaultCreated(address indexed vault, address indexed owner, uint256 indexed strategyId, address strategyExecutor, address series, uint256 maxDailyDrawdownBps, bytes32[] whitelistedAssetIds)` ·
`LooserVaultRequested(address indexed owner, uint256 indexed strategyId, bytes32 indexed requestId, uint256 availableAt)` ·
`CopyVaultCreated(address indexed vault, address indexed follower, uint256 indexed leaderStrategyId, address leaderExecutor, uint256 allocationBps, uint256 feeShareBps, address feeRecipient)`

**GuardedVault** (one per vault; discover addresses from `GuardedVaultCreated`) —
`Deposited(address indexed from, uint256 amount)` · `Withdrawn(address indexed to, uint256 amount)` ·
`TradeProposed(bytes32 indexed assetId, address indexed proposer, bool isLong, uint256 size, int256 projectedPnL)` ·
`TradeRefused(bytes32 indexed assetId, address indexed proposer, bytes32 reason, int256 decidingValue)`
(reasons: `ASSET_NOT_WHITELISTED`, `PREDICATE_NOT_SATISFIED`, `DAILY_DRAWDOWN_EXCEEDED`)

**CopyVault** (one per vault; discover from `CopyVaultCreated`) —
`Deposited(address indexed follower, uint256 amount)` · `Withdrawn(address indexed follower, uint256 amount)` ·
`FollowingToggled(bool active)` · `TradeSkipped(bytes32 indexed assetId, bytes32 reason)` ·
`PositionMirrored(uint256 indexed positionId, bytes32 indexed assetId, bool isLong, uint256 followerSize, uint256 entryPrice)` ·
`PositionClosed(uint256 indexed positionId, uint256 exitPrice, int256 pnl, uint256 feeCharged)`

Note `Deposited`/`Withdrawn`/`PositionClosed`/`TradeProposed`/`TradeRefused` are
declared by several contracts with different argument lists; key indexer
handlers on (emitting address, topic0), not on the name alone.

## Pyth interface

`forge install pyth-network/pyth-sdk-solidity` was attempted first (this
sandbox does have network access, so this wasn't a fallback-on-no-network
situation). Two problems surfaced, in order:

1. `forge install` places new dependencies under the *git repository root*
   (`lib/`), not the Foundry project root — this repo is a single git
   repository for the whole `kanon` monorepo, so a plain `forge install` would
   have written `lib/`, `.gitmodules` and `foundry.lock` at the monorepo root,
   outside `packages/contracts`. To keep this package self-contained (per the
   "do not touch any other package in the repo" constraint), the real
   `pyth-network/pyth-sdk-solidity` repo was instead `git clone`d directly into
   `packages/contracts/lib/` and de-gitted (its own `.git` removed) so it's
   vendored as plain files scoped to this package.
2. That vendored SDK then **failed to compile** under solc 0.8.26. Every file
   in it carries a top-level NatSpec comment recommending its scoped-npm
   successor package; solc's doc-tag parser treats the `@`-prefixed package
   name inside that comment as an invalid NatSpec tag on the following
   contract declaration (solc error 6546), and there is no way to suppress
   that short of patching the vendored file. The upstream repo is itself
   marked "**Deprecated** – removed 1 August 2025" in favor of the npm
   package, which is presumably why nobody has fixed it.

Given a genuinely broken (if not literally network-unreachable) dependency,
this package falls back to exactly what was specified as the fallback path:
`src/pyth/IPyth.sol` and `src/pyth/PythStructs.sol` are hand-written,
matching the real public interface shape field-for-field —
`getPriceNoOlderThan(bytes32 id, uint256 age)` returning
`Price{int64 price, uint64 conf, int32 expo, uint256 publishTime}` — against
https://github.com/pyth-network/pyth-sdk-solidity. Swap these for the
maintained scoped npm/forge dependency whenever this package adopts a real
Solidity package manager. `forge-std` (for `Test.sol` etc.) installed and
compiled cleanly and is vendored the same way, under
`packages/contracts/lib/forge-std`, also de-gitted so it doesn't register as
a nested git repository inside the monorepo.

## The invariant every future change here must preserve

**The contract never calls a model.** Every function in this package resolves
to signature verification and arithmetic over on-chain state or signed price
data — nothing here, now or in any follow-up listed above, may accept a bare
assertion, call an LLM, or resolve a dispute by anything other than comparing
numbers. If a future change to `RefusalGate`, `ThresholdMarket`,
`MarginAccount`, `GuardedVault`, or `CopyVault` ever needs "judgment," that
judgment belongs off-chain, behind a signed attestation the contract can
verify — never inside a Solidity function.
