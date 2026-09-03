# Kanon — Architecture

Chain: Monad mainnet, chain ID 143.

This is the load-bearing document. The security model is the product. Read all
of it before changing the compiler, the oracle layer or the contracts.

## The asymmetry everything follows from

An oracle can attest that at time T the price was X. It cannot cheaply attest
that no price exceeded X across a window, because that is a claim about every
tick, including ticks nobody published on-chain.

Positive claims are cheap to prove. Maximality claims are negative claims, and
negative claims are expensive.

Two responses, and they compose.

## Path 1 — canonical series

The contract maintains its own price record, sampling the feed on a fixed cadence
and bucketing into candles. A swing high is defined as the maximum over
**recorded samples**, not over some platonic true price.

This is honest. Every exchange already does this implicitly — a high on a chart
is just the high of that venue's tape. Kanon publishes its tape and defines
strategies against it.

Cost is state and update transactions, which is exactly the thing Monad's fees
and block times make survivable and other chains do not.

The canonical series must pin, explicitly and immutably per strategy: asset,
source feed, sampling cadence, and bucket size. A spec is meaningless without
them.

## Path 2 — optimistic claims with cheap falsification

The proposer submits a trade along with its structural claim: swing high H at
timestamp T, break of structure confirmed at T2, and posts a bond.

The contract does not search for the setup. It holds the claim.

Anyone can falsify it by submitting a signed price attestation showing a price
above H inside the window, and take the bond. Proving a maximum is expensive.
Disproving one takes a single data point.

The cost asymmetry is inverted rather than fought. The happy path costs almost
nothing.

**Start with path 1 for the primary asset. Add path 2 if there is time.** Do not
build both in week one.

## The three layers

Only one of these is allowed to think.

**Proposer.** The strategy agent. Any model. Reads the market, finds a setup,
submits a trade with its structural claim and a bond. Completely untrusted.

**Challenger.** A second agent running off-chain and continuously, independently
reconstructing structure and hunting for lies. It may be as smart and as fuzzy as
you like, **because its opinion never enters the trust boundary.** When it finds
a false claim it does not report a verdict. It submits a signed attestation that
makes the claim arithmetically false. It is a searcher pointed at a haystack; the
contract checks the needle.

**Contract.** Deliberately stupid. Verifies signatures, does arithmetic. Never
calls a model, never accepts an assertion, never resolves a dispute by judgment.
If a dispute cannot be settled by comparing numbers from signed data, it is not
settled and the bond returns.

A second AI verifying the first is not verification. It is correlation, and the
two models will correlate hardest exactly where they are both wrong. If an LLM
ever sits inside the trust boundary, the entire pitch collapses to "trust my AI".

## Oracle

Pyth is live on Monad mainnet. Sponsored push feeds cover BTC/USD, ETH/USD,
MON/USD, SOL/USD, USDC/USD, USDT/USD, WBTC/USD, WETH/USD and WSTETH/USD, with
majors on a 1-hour heartbeat and a 0.02% deviation threshold. Publishers push to
Pythnet roughly every 400ms; consumers pull aggregated prices onto Monad on
demand, which is what gives attestable historical points for the falsification
path.

Monad also documents Chainlink, Chronicle, eOracle, Redstone, Stork and
Switchboard as fallbacks.

Two constraints to plan around:

- A 0.02% deviation threshold makes the series **event-driven, not uniform**.
  Define buckets accordingly. Do not assume evenly spaced candles.
- The sponsored set is nine crypto pairs. FX feeds exist in Pyth but are not
  sponsored on Monad, so FX means paying for your own updates. **Demo on BTC or
  ETH.**

Manipulation is a real threat surface: a feed pushed to fake a break of
structure, or a position triggered deliberately. Document the assumption. Do not
claim it is solved.

## The strategy spec

A versioned, Zod-validated AST. One source of truth shared by compiler, UI and
contract encoder.

Every predicate binds every parameter explicitly. No implicit lookbacks, no
default timeframes hidden in code. If the compiler infers a value, it is flagged
as inferred in spec review.

Predicates for v1, and only these three:

- **Break of structure** — price crosses a prior swing extreme. Parameters:
  direction, swing lookback in candles, timeframe.
- **Fair value gap** — three-candle imbalance. Parameters: direction, minimum gap
  size, timeframe.
- **Liquidity sweep** — wick beyond a prior extreme with a close back inside.
  Parameters: direction, reference extreme, lookback, timeframe.

Each compiles to arithmetic over the canonical series. If a fourth predicate is
proposed and cannot, it does not ship.

## Compiler

LLM turns natural language into a candidate spec. The model's job is
**translation, not prediction**, which is a task LLMs are good at and can be
evaluated on.

Output is schema-validated. Retry on schema failure. Never accept partially
valid output.

The compiled spec is always shown for review before pinning, in plain English and
parametric form, with inferred defaults flagged. The user must be able to say "no,
my swing high is five candles, not three."

## Pinning and mutation

Pinning writes the spec hash on-chain with a bond. Ceremony, biometric, weighted.

Tightening a parameter takes effect immediately. Loosening one enters a
cooling-off period with a visible, unskippable countdown. You cannot widen a stop
mid-drawdown.

There is no override, no admin key, no support path. A escape hatch that exists
will be used, and its existence defeats the product.

## Execution

Perpl for perps, Kuru for spot. Both have documented APIs — Perpl REST and
WebSocket with separate trading and market-data servers, rate limits keyed on
wallet address. Perpl already publishes on-chain safeguards for agents on Monad;
read that before designing the policy account.

Latency: verification adds a block or two. SMC swing trading tolerates this
easily. Do not design for high frequency.

## Failure modes

- **Feed manipulation.** Documented, not solved. State the assumption.
- **Sparse series.** Event-driven updates mean gaps. Buckets must handle empty
  intervals without inventing prices.
- **Compiler drift.** The same prompt producing different specs. Pin the model
  version, snapshot-test the compiler against a fixture set.
- **Bond griefing.** Size bonds so challenging is profitable and spurious
  challenges are not.
