#!/usr/bin/env bash
# End-to-end scenario against a local anvil, using MockPyth as the price feed.
#
#   ./script/e2e-local.sh
#
# Starts its own anvil (port $ANVIL_PORT, default 8545 - aborts if something is
# already listening there), deploys the whole system with script/Deploy.s.sol,
# writes deployments/31337.json, then drives every layer through real
# transactions and asserts the outcome of each step:
#
#   A. Spec + refusal (the pinned predicates are what the chain enforces)
#      1. alice pins a strategy: spec hash + predicates commitment + series
#      2. two candles are recorded on the BTC/USD CanonicalSeries
#      3. alice creates a GuardedVault through VaultFactory (registered on-chain)
#      4. the executor proposes a trade with the committed predicates -> allowed
#      5. refusals are successful transactions that return false and emit
#         TradeRefused: asset not whitelisted, daily drawdown exceeded, and the
#         pinned predicate no longer holding once the market turns
#      6. cheaper predicates (not the committed ones) revert; a stale series
#         reverts; the old attested `evaluate` no longer exists
#   B. Risk engine
#      7. the insurance fund gets an explicit deposit
#      8. alice opens a leveraged long; price falls into the ADL band;
#         liquidation is refused; a stranger deleverages 25% of the position
#      9. price falls further; a stranger liquidates; the penalty lands in the
#         insurance fund and the liquidator is paid nothing
#     10. bob's position loses more than his collateral; the insurance fund
#         covers the shortfall; the margin ledger identity still holds
#   C. Rule-bound margin account: carol binds to her strategy; the ungated open
#      is closed; the guarded open passes only while her pinned rules hold
#   D. Predict market: stakes are accepted before the threshold is recorded and
#      refused once the tape shows it
#   E. Factory hold: a looser vault needs a request that has waited out the
#      cooldown; a tighter one is immediate
#
# Exits non-zero on the first failed assertion.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$PATH:$HOME/.foundry/bin"

PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t kanon-anvil.XXXXXX.log)"

# Anvil's well-known dev accounts, derived from its public default mnemonic
# (local-only keys, worthless anywhere real).
MNEMONIC="test test test test test test test test test test test junk"
key_of() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
DEPLOYER_PK="$(key_of 0)"
ALICE_PK="$(key_of 1)"
KEEPER_PK="$(key_of 2)"
EXECUTOR_PK="$(key_of 3)"
BOB_PK="$(key_of 4)"
DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_PK")"
ALICE="$(cast wallet address --private-key "$ALICE_PK")"
KEEPER="$(cast wallet address --private-key "$KEEPER_PK")"
EXECUTOR="$(cast wallet address --private-key "$EXECUTOR_PK")"
BOB="$(cast wallet address --private-key "$BOB_PK")"

BTC_FEED=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
BUCKET=900
PASS=0

ANVIL_PID=""
cleanup() {
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*" >&2; echo "(anvil log: $LOG)" >&2; exit 1; }

# first whitespace-delimited token of cast's output ("1500 [1.5e3]" -> 1500)
first() { awk 'NR==1{print $1}'; }

call() { cast call --rpc-url "$RPC" "$@"; }
send() { cast send --rpc-url "$RPC" --json "$@"; }
sendq() { cast send --rpc-url "$RPC" "$@" >/dev/null; }

assert_eq() { # name actual expected
  [[ "$2" == "$3" ]] && ok "$1 = $3" || fail "$1: expected '$3', got '$2'"
}
assert_true() { [[ "$2" == "true" ]] && ok "$1" || fail "$1 (got '$2')"; }
assert_false() { [[ "$2" == "false" ]] && ok "$1" || fail "$1 (got '$2')"; }
assert_lt() { # name a b  (a < b)
  python3 -c "import sys; sys.exit(0 if int('$2') < int('$3') else 1)" && ok "$1 ($2 < $3)" || fail "$1: $2 !< $3"
}
assert_ge() {
  python3 -c "import sys; sys.exit(0 if int('$2') >= int('$3') else 1)" && ok "$1 ($2 >= $3)" || fail "$1: $2 !>= $3"
}
expect_revert() { # name <cast call args...>
  local name="$1"
  shift
  if call "$@" >/dev/null 2>&1; then fail "$name should revert"; else ok "$name reverts"; fi
}

expect_revert_send() { # name <private key> <cast send args...>
  local name="$1" pk="$2"
  shift 2
  if cast send --rpc-url "$RPC" --private-key "$pk" "$@" >/dev/null 2>&1; then fail "$name should revert"; else ok "$name reverts"; fi
}

usdc() { python3 -c "print(int(round($1 * 10**6)))"; } # 6-decimals token

now() { cast block latest --rpc-url "$RPC" --field timestamp; }

# Jump to the start of the next 15-minute bucket (+10s) so every sample and
# every price read inside one "candle" lands in the same CanonicalSeries bucket.
new_candle() {
  local t nb
  t="$(now)"
  nb=$(((t / BUCKET + 1) * BUCKET + 10))
  cast rpc --rpc-url "$RPC" evm_setNextBlockTimestamp "$nb" >/dev/null
  cast rpc --rpc-url "$RPC" evm_mine >/dev/null
}

# Set the BTC mock-Pyth price (whole dollars, expo -8) and record a sample.
publish_btc() {
  local px=$(($1 * 100000000))
  sendq --private-key "$DEPLOYER_PK" "$PYTH" "setPrice(bytes32,int64,uint64,int32,uint256)" \
    "$BTC_FEED" "$px" 1 -8 "$(now)"
  sendq --private-key "$DEPLOYER_PK" "$BTC_SERIES" "recordSample()"
}

json_addr() { jq -r ".$1" "deployments/31337.json"; }

# ----------------------------------------------------------------------------
say "anvil"
if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  fail "something is already listening on $RPC; set ANVIL_PORT to a free port"
fi
anvil --port "$PORT" --silent >"$LOG" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done
assert_eq "chain id" "$(cast chain-id --rpc-url "$RPC")" "31337"

# ----------------------------------------------------------------------------
say "deploy (forge script script/Deploy.s.sol)"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --broadcast >/dev/null
[[ -f deployments/31337.json ]] || fail "deployments/31337.json not written"

USDC="$(json_addr CollateralToken)"
PYTH="$(json_addr Pyth)"
BTC_SERIES="$(json_addr CanonicalSeriesBTCUSD)"
REGISTRY="$(json_addr StrategyRegistry)"
GATE="$(json_addr RefusalGate)"
FUND="$(json_addr InsuranceFund)"
MARGIN="$(json_addr MarginAccount)"
FACTORY="$(json_addr VaultFactory)"
for a in USDC PYTH BTC_SERIES REGISTRY GATE FUND MARGIN FACTORY; do
  [[ "${!a}" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "$a address missing from deployments/31337.json"
  [[ "$(cast code "${!a}" --rpc-url "$RPC")" != "0x" ]] || fail "$a has no code on chain"
done
ok "all contracts deployed and recorded in deployments/31337.json"
assert_eq "fund is bound to the margin account" "$(call "$FUND" "margin()(address)")" "$(cast to-check-sum-address "$MARGIN")"
assert_eq "margin uses the deployed fund" "$(call "$MARGIN" "insuranceFund()(address)")" "$(cast to-check-sum-address "$FUND")"

# ----------------------------------------------------------------------------
say "A1. alice pins her strategy: spec hash + predicates commitment + series"
# RefusalGate.PredicateDefinition:
#   (kind, symbol, direction, swingLookbackCandles, minGapBps, referenceExtreme, lookback, timeframeSeconds)
PRED_TUPLE="(uint8,bytes32,uint8,uint256,uint256,uint8,uint8,uint256)"
SYM_BOS="$(cast format-bytes32-string bos_bullish)"
PRED_LONG="[(0,$SYM_BOS,0,1,0,0,0,900)]" # break of structure, long, lookback 1, 15m
# Commitment = keccak256(abi.encode(PredicateDefinition[])), exactly what packages/spec encodePredicates produces.
commitment_of() { cast keccak "$(cast abi-encode "f(${PRED_TUPLE}[])" "$1")"; }
COMMITMENT="$(commitment_of "$PRED_LONG")"
SPEC_HASH="$(cast keccak "kanon-e2e-spec-v1")"
sendq --private-key "$ALICE_PK" --value 0.25ether "$REGISTRY" "pinStrategy(bytes32,bytes32,address)" \
  "$SPEC_HASH" "$COMMITMENT" "$BTC_SERIES"
STRATEGY_ID=$(($(call "$REGISTRY" "nextStrategyId()(uint256)" | first) - 1))
assert_eq "active spec hash" "$(call "$REGISTRY" "activeSpecHash(uint256)(bytes32)" "$STRATEGY_ID")" "$SPEC_HASH"
assert_eq "active predicates commitment" "$(call "$REGISTRY" "activePredicatesCommitment(uint256)(bytes32)" "$STRATEGY_ID")" "$COMMITMENT"
assert_eq "active series" "$(call "$REGISTRY" "activeSeries(uint256)(address)" "$STRATEGY_ID")" "$(cast to-check-sum-address "$BTC_SERIES")"
ROGUE="0x000000000000000000000000000000000000dEaD"
expect_revert_send "a non-canonical series cannot be pinned" "$ALICE_PK" --value 0.25ether "$REGISTRY" \
  "pinStrategy(bytes32,bytes32,address)" "$SPEC_HASH" "$COMMITMENT" "$ROGUE"

say "A2. two candles recorded on the BTC/USD canonical series"
new_candle
publish_btc 100000
new_candle
publish_btc 101000
assert_true "latest bucket recorded" "$(call "$BTC_SERIES" "getCandle(uint256)(int64,int64,int64,int64,uint32,bool)" "$(($(now) / BUCKET))" | sed -n 6p)"

say "A3. alice creates a GuardedVault through VaultFactory"
BTC_ID="$(cast keccak "BTC-USD")"
ETH_ID="$(cast keccak "ETH-USD")"
DOGE_ID="$(cast keccak "DOGE-USD")"
sendq --private-key "$ALICE_PK" "$FACTORY" \
  "createGuardedVault(address,uint256,bytes32[],uint256)" \
  "$EXECUTOR" "$STRATEGY_ID" "[$BTC_ID,$ETH_ID]" 1000
VAULT="$(call "$FACTORY" "guardedVaultsOf(address)(address[])" "$ALICE" | tr -d '[] ' | cut -d, -f1)"
[[ "$VAULT" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "could not read vault address from factory"
assert_true "factory recognizes the vault" "$(call "$FACTORY" "isVault(address)(bool)" "$VAULT")"
assert_true "factory recognizes it as a guarded vault" "$(call "$FACTORY" "isGuardedVault(address)(bool)" "$VAULT")"
assert_eq "vault owner" "$(call "$VAULT" "owner()(address)")" "$(cast to-check-sum-address "$ALICE")"
assert_eq "vault executor" "$(call "$VAULT" "strategyExecutor()(address)")" "$(cast to-check-sum-address "$EXECUTOR")"
assert_eq "vault refusal gate is the deployed one" "$(call "$VAULT" "refusalGate()(address)")" "$(cast to-check-sum-address "$GATE")"
NOT_A_VAULT="$(call "$FACTORY" "isVault(address)(bool)" "$ALICE")"
assert_false "an arbitrary address is not a vault" "$NOT_A_VAULT"

sendq --private-key "$DEPLOYER_PK" "$USDC" "mint(address,uint256)" "$ALICE" "$(usdc 100000)"
sendq --private-key "$ALICE_PK" "$USDC" "approve(address,uint256)" "$VAULT" "$(usdc 10000)"
sendq --private-key "$ALICE_PK" "$VAULT" "deposit(uint256)" "$(usdc 10000)"
assert_eq "vault collateral" "$(call "$VAULT" "totalCollateral()(uint256)" | first)" "$(usdc 10000)"

say "A4. executor proposes a trade with the committed predicates (bullish break of structure holds)"
PRED_SIG="proposeTrade(bytes32,bool,uint256,int256,${PRED_TUPLE}[])"
PRED_SIG_CALL="${PRED_SIG}(bool)" # same call, decoding the bool it returns
T_VAULT_PROPOSED="$(cast keccak "TradeProposed(bytes32,address,bool,uint256,int256)")"
T_GATE_PROPOSED="$(cast keccak "TradeProposed(uint256,bytes32,address)")"
T_VAULT_REFUSED="$(cast keccak "TradeRefused(bytes32,address,bytes32,int256)")"
T_GATE_REFUSED="$(cast keccak "TradeRefused(uint256,bytes32,address,bytes32,int256)")"

assert_true "eth_call: predicate satisfied -> allowed" \
  "$(call --from "$EXECUTOR" "$VAULT" "$PRED_SIG_CALL" "$BTC_ID" true "$(usdc 1000)" 50 "$PRED_LONG")"
R="$(send --private-key "$EXECUTOR_PK" "$VAULT" "$PRED_SIG" "$BTC_ID" true "$(usdc 1000)" 50 "$PRED_LONG")"
assert_eq "tx status" "$(jq -r '.status' <<<"$R")" "0x1"
assert_eq "vault emitted TradeProposed" \
  "$(jq --arg t "$T_VAULT_PROPOSED" '[.logs[] | select(.topics[0]==$t)] | length' <<<"$R")" "1"
assert_eq "gate emitted TradeProposed" \
  "$(jq --arg t "$T_GATE_PROPOSED" '[.logs[] | select(.topics[0]==$t)] | length' <<<"$R")" "1"

say "A5. refusals are successful transactions, not errors"
refusal_reason() { # <receipt json> -> the vault's refusal reason string
  local reason
  reason="$(jq -r --arg t "$T_VAULT_REFUSED" '.logs[] | select(.topics[0]==$t) | .data' <<<"$1" | cut -c1-66)"
  cast parse-bytes32-string "$reason"
}

# (i) asset not whitelisted
R="$(send --private-key "$EXECUTOR_PK" "$VAULT" "$PRED_SIG" "$DOGE_ID" true "$(usdc 1000)" 50 "$PRED_LONG")"
assert_eq "whitelist refusal tx status (success)" "$(jq -r '.status' <<<"$R")" "0x1"
assert_eq "vault refusal reason" "$(refusal_reason "$R")" "ASSET_NOT_WHITELISTED"

# (ii) daily drawdown: cap is 10% of 10_000 = 1_000; projected -1_500 breaches it
R="$(send --private-key "$EXECUTOR_PK" "$VAULT" "$PRED_SIG" "$BTC_ID" true "$(usdc 1000)" "-$(usdc 1500)" "$PRED_LONG")"
assert_eq "drawdown refusal tx status (success)" "$(jq -r '.status' <<<"$R")" "0x1"
assert_eq "vault refusal reason" "$(refusal_reason "$R")" "DAILY_DRAWDOWN_EXCEEDED"

# (iii-a) the trade SIDE is bound to the committed predicates: a bullish rule never approves a short,
#         even while its predicates hold on the tape.
assert_false "eth_call: a short under a bullish rule -> false (side is bound to the predicates)" \
  "$(call --from "$EXECUTOR" "$VAULT" "$PRED_SIG_CALL" "$BTC_ID" false "$(usdc 1000)" 50 "$PRED_LONG")"
R="$(send --private-key "$EXECUTOR_PK" "$VAULT" "$PRED_SIG" "$BTC_ID" false "$(usdc 1000)" 50 "$PRED_LONG")"
assert_eq "side-mismatch refusal tx status (success)" "$(jq -r '.status' <<<"$R")" "0x1"
assert_eq "vault refusal reason" "$(refusal_reason "$R")" "PREDICATE_NOT_SATISFIED"
GATE_REASON="$(jq -r --arg t "$T_GATE_REFUSED" '.logs[] | select(.topics[0]==$t) | .data' <<<"$R" | cut -c1-66)"
assert_eq "gate names the reason" "$(cast parse-bytes32-string "$GATE_REASON")" "SIDE_MISMATCH"

# (iii) the pinned predicate no longer holds: the market turns, the SAME calldata that
#       was approved above is now refused. There is no stored approval to replay.
new_candle
publish_btc 100500 # below the previous candle's 101_000 high: no break of structure now
assert_false "eth_call: same predicates, market turned -> false (no revert)" \
  "$(call --from "$EXECUTOR" "$VAULT" "$PRED_SIG_CALL" "$BTC_ID" true "$(usdc 1000)" 50 "$PRED_LONG")"
R="$(send --private-key "$EXECUTOR_PK" "$VAULT" "$PRED_SIG" "$BTC_ID" true "$(usdc 1000)" 50 "$PRED_LONG")"
assert_eq "refusal tx status (success)" "$(jq -r '.status' <<<"$R")" "0x1"
assert_eq "gate emitted TradeRefused (names the predicate + number)" \
  "$(jq --arg t "$T_GATE_REFUSED" '[.logs[] | select(.topics[0]==$t)] | length' <<<"$R")" "1"
assert_eq "vault refusal reason" "$(refusal_reason "$R")" "PREDICATE_NOT_SATISFIED"

say "A6. the proposer cannot change the rules, the series, or fake freshness"
# Cheaper predicates: lookback 1 -> 0 and a 1h timeframe are not what was committed.
PRED_TAMPERED="[(0,$SYM_BOS,0,1,0,0,0,900),(0,$SYM_BOS,1,1,0,0,0,900)]"
expect_revert "extra/cheaper predicates are not the committed ones" --from "$EXECUTOR" "$VAULT" "$PRED_SIG_CALL" \
  "$BTC_ID" true 1 0 "$PRED_TAMPERED"
PRED_SHORTER="[(0,$SYM_BOS,1,1,0,0,0,900)]" # opposite direction: an easier-looking setup
expect_revert "a different direction is not the committed predicate" --from "$EXECUTOR" "$VAULT" "$PRED_SIG_CALL" \
  "$BTC_ID" true 1 0 "$PRED_SHORTER"
# The old attested path is gone from the gate's ABI.
expect_revert "the attested evaluate(...) no longer exists" "$GATE" \
  "evaluate(uint256,bytes32,(bytes32,bool,int256)[])" "$STRATEGY_ID" "$SPEC_HASH" "[($SYM_BOS,true,1)]"
# A stale series cannot approve: a bucket passes and nobody samples.
new_candle
expect_revert "stale series reverts (nobody sampled this bucket)" --from "$EXECUTOR" "$VAULT" "$PRED_SIG_CALL" \
  "$BTC_ID" true 1 0 "$PRED_LONG"
# A stranger is a genuine caller error, and the only revert on the trade path.
expect_revert "a stranger cannot propose trades" --from "$KEEPER" "$VAULT" "$PRED_SIG_CALL" "$BTC_ID" true 1 0 "$PRED_LONG"

# ----------------------------------------------------------------------------
say "B1. insurance fund: explicit deposit"
sendq --private-key "$DEPLOYER_PK" "$USDC" "mint(address,uint256)" "$DEPLOYER" "$(usdc 500)"
sendq --private-key "$DEPLOYER_PK" "$USDC" "approve(address,uint256)" "$FUND" "$(usdc 500)"
sendq --private-key "$DEPLOYER_PK" "$FUND" "deposit(uint256)" "$(usdc 500)"
assert_eq "fund balance" "$(call "$FUND" "balance()(uint256)" | first)" "$(usdc 500)"
expect_revert "no one can draw the fund (deployer)" --from "$DEPLOYER" "$FUND" "coverShortfall(uint256)(uint256)" 1
expect_revert "no one can draw the fund (keeper)" --from "$KEEPER" "$FUND" "coverShortfall(uint256)(uint256)" 1

say "B2. alice opens a 6.7x long: 1_500 collateral, 10_000 size at 100_000"
new_candle
publish_btc 100000
sendq --private-key "$ALICE_PK" "$USDC" "approve(address,uint256)" "$MARGIN" "$(usdc 1500)"
sendq --private-key "$ALICE_PK" "$MARGIN" "deposit(uint256)" "$(usdc 1500)"
sendq --private-key "$ALICE_PK" "$MARGIN" "openPosition(address,bool,uint256)" "$BTC_SERIES" true "$(usdc 10000)"
assert_eq "health factor at open (1500 / 500 maintenance)" "$(call "$MARGIN" "healthFactor(address)(uint256)" "$ALICE" | first)" "3000000000000000000"

say "B3. price falls into the ADL band [1.0, 1.2): liquidation refused, ADL allowed"
new_candle
publish_btc 90500 # pnl -950 -> equity 550 / maintenance 500 = 1.1
assert_eq "health factor" "$(call "$MARGIN" "healthFactor(address)(uint256)" "$ALICE" | first)" "1100000000000000000"
expect_revert "liquidate refused while health >= 1.0" --from "$KEEPER" "$MARGIN" "liquidate(address,uint256)" "$ALICE" 0
sendq --private-key "$KEEPER_PK" "$MARGIN" "deleverage(address)" "$ALICE"
POS="$(call "$MARGIN" "positionOf(address,uint256)(address,bool,uint256,uint256,bool)" "$ALICE" 0)"
assert_eq "position size after ADL (75% left)" "$(sed -n 3p <<<"$POS" | first)" "$(usdc 7500)"
assert_true "position still open" "$(sed -n 5p <<<"$POS")"
assert_eq "collateral after realizing the 25% slice (-237.5)" "$(call "$MARGIN" "collateralOf(address)(uint256)" "$ALICE" | first)" "$(usdc 1262.5)"
# equity 550 / maintenance 375 = 1.4666...
assert_ge "health improved above the ADL threshold" "$(call "$MARGIN" "healthFactor(address)(uint256)" "$ALICE" | first)" "1200000000000000000"
expect_revert "no second ADL once healthy" --from "$KEEPER" "$MARGIN" "deleverage(address)" "$ALICE"

say "B4. price falls further: a stranger liquidates, the penalty goes to the fund"
new_candle
publish_btc 85000 # remaining pnl -1_125 vs collateral 1_262.5 -> equity 137.5 < maintenance 375
assert_lt "health factor below 1.0" "$(call "$MARGIN" "healthFactor(address)(uint256)" "$ALICE" | first)" "1000000000000000000"
expect_revert "ADL refused once liquidatable" --from "$KEEPER" "$MARGIN" "deleverage(address)" "$ALICE"
KEEPER_BEFORE="$(call "$USDC" "balanceOf(address)(uint256)" "$KEEPER" | first)"
sendq --private-key "$KEEPER_PK" "$MARGIN" "liquidate(address,uint256)" "$ALICE" 0
POS="$(call "$MARGIN" "positionOf(address,uint256)(address,bool,uint256,uint256,bool)" "$ALICE" 0)"
assert_false "position closed" "$(sed -n 5p <<<"$POS")"
assert_eq "alice collateral" "$(call "$MARGIN" "collateralOf(address)(uint256)" "$ALICE" | first)" "0"
# penalty = 2% of 7_500 = 150, capped at the 137.5 that survived the loss
assert_eq "fund = 500 seed + 137.5 penalty" "$(call "$FUND" "balance()(uint256)" | first)" "$(usdc 637.5)"
assert_eq "liquidator paid nothing" "$(call "$USDC" "balanceOf(address)(uint256)" "$KEEPER" | first)" "$KEEPER_BEFORE"

say "B5. bob loses more than his collateral: the fund covers the shortfall"
new_candle
publish_btc 85000
sendq --private-key "$DEPLOYER_PK" "$USDC" "mint(address,uint256)" "$BOB" "$(usdc 800)"
sendq --private-key "$BOB_PK" "$USDC" "approve(address,uint256)" "$MARGIN" "$(usdc 800)"
sendq --private-key "$BOB_PK" "$MARGIN" "deposit(uint256)" "$(usdc 800)"
sendq --private-key "$BOB_PK" "$MARGIN" "openPosition(address,bool,uint256)" "$BTC_SERIES" true "$(usdc 10000)"
new_candle
publish_btc 75000 # pnl = 10_000 * -10_000/85_000 = -1_176.470588 vs 800 collateral
sendq --private-key "$KEEPER_PK" "$MARGIN" "liquidate(address,uint256)" "$BOB" 0
assert_eq "bob collateral" "$(call "$MARGIN" "collateralOf(address)(uint256)" "$BOB" | first)" "0"
assert_eq "bob debt resolved" "$(call "$MARGIN" "debtOf(address)(uint256)" "$BOB" | first)" "0"
assert_eq "fund covered the 376.470588 shortfall" "$(call "$FUND" "totalShortfallCovered()(uint256)" | first)" "376470588"
assert_eq "no uncovered bad debt" "$(call "$MARGIN" "uncoveredBadDebt()(uint256)" | first)" "0"
assert_eq "fund balance after cover" "$(call "$FUND" "balance()(uint256)" | first)" "$((637500000 - 376470588))"

say "B6. ledger identity: token balance == totalCollateral + counterpartyBalance"
TOKEN_BAL="$(call "$USDC" "balanceOf(address)(uint256)" "$MARGIN" | first)"
TOTAL_COLL="$(call "$MARGIN" "totalCollateral()(uint256)" | first)"
CP="$(call "$MARGIN" "counterpartyBalance()(int256)" | first)"
assert_eq "margin token balance" "$TOKEN_BAL" "$((TOTAL_COLL + CP))"

say "C. rule-bound margin account: the gate is the only way in"
CAROL_PK="$(key_of 5)"
CAROL="$(cast wallet address --private-key "$CAROL_PK")"
sendq --private-key "$DEPLOYER_PK" "$USDC" "mint(address,uint256)" "$CAROL" "$(usdc 5000)"
sendq --private-key "$CAROL_PK" --value 0.25ether "$REGISTRY" "pinStrategy(bytes32,bytes32,address)" \
  "$(cast keccak "carol-spec")" "$COMMITMENT" "$BTC_SERIES"
CAROL_STRATEGY=$(($(call "$REGISTRY" "nextStrategyId()(uint256)" | first) - 1))
expect_revert_send "only the strategy's owner can bind an account to it" "$KEEPER_PK" "$MARGIN" "bindStrategy(uint256)" "$CAROL_STRATEGY"
sendq --private-key "$CAROL_PK" "$MARGIN" "bindStrategy(uint256)" "$CAROL_STRATEGY"
assert_true "carol's account is strategy-bound" "$(call "$MARGIN" "isStrategyBound(address)(bool)" "$CAROL")"
expect_revert_send "binding is one-way" "$CAROL_PK" "$MARGIN" "bindStrategy(uint256)" "$CAROL_STRATEGY"
sendq --private-key "$CAROL_PK" "$USDC" "approve(address,uint256)" "$MARGIN" "$(usdc 1500)"
sendq --private-key "$CAROL_PK" "$MARGIN" "deposit(uint256)" "$(usdc 1500)"
expect_revert "the ungated open is closed to a bound account" --from "$CAROL" "$MARGIN" \
  "openPosition(address,bool,uint256)" "$BTC_SERIES" true "$(usdc 5000)"

GUARDED_SIG="openGuardedPosition(bool,uint256,${PRED_TUPLE}[])"
# Market falls then bounces: a bullish break of structure holds at the latest candle.
new_candle
publish_btc 75000
new_candle
publish_btc 76000
assert_eq "guarded open passes while the pinned rules hold" \
  "$(call --from "$CAROL" "$MARGIN" "${GUARDED_SIG}(bool,uint256)" true "$(usdc 5000)" "$PRED_LONG" | sed -n 1p)" "true"
sendq --private-key "$CAROL_PK" "$MARGIN" "$GUARDED_SIG" true "$(usdc 5000)" "$PRED_LONG"
assert_eq "carol has one open position" "$(call "$MARGIN" "openPositionCount(address)(uint256)" "$CAROL" | first)" "1"

# The market turns: the same call is now a refusal, and opens nothing.
new_candle
publish_btc 75500
assert_eq "guarded open is refused once the rules stop holding (no revert)" \
  "$(call --from "$CAROL" "$MARGIN" "${GUARDED_SIG}(bool,uint256)" true "$(usdc 5000)" "$PRED_LONG" | sed -n 1p)" "false"
sendq --private-key "$CAROL_PK" "$MARGIN" "$GUARDED_SIG" true "$(usdc 5000)" "$PRED_LONG"
assert_eq "still one open position (the refusal opened nothing)" "$(call "$MARGIN" "openPositionCount(address)(uint256)" "$CAROL" | first)" "1"
sendq --private-key "$CAROL_PK" "$MARGIN" "closePosition(uint256)" 0 # getting out is never gated
assert_eq "a bound account can always close" "$(call "$MARGIN" "openPositionCount(address)(uint256)" "$CAROL" | first)" "0"

say "D. Predict market: no staking on information already in the series"
MARKET="$(json_addr ThresholdMarket)"
BTC_MARKET_ID="$(cast keccak "BTC/USD")"
new_candle
publish_btc 76000
WSTART="$(now)"
WEND=$((WSTART + 4 * BUCKET))
THRESHOLD=$((80000 * 100000000)) # 80_000 in the series' expo -8 units
sendq --private-key "$ALICE_PK" "$MARKET" "openMarket(bytes32,int256,bool,uint256,uint256)" \
  "$BTC_MARKET_ID" "$THRESHOLD" true "$WSTART" "$WEND"
MARKET_ID=$(($(call "$MARKET" "nextMarketId()(uint256)" | first) - 1))
assert_false "the tape has not crossed yet" "$(call "$MARKET" "hasCrossed(uint256)(bool)" "$MARKET_ID")"
sendq --private-key "$ALICE_PK" --value 1ether "$MARKET" "takeSide(uint256,bool)" "$MARKET_ID" true
assert_eq "alice's stake before the cross" "$(call "$MARKET" "yesStake(uint256,address)(uint256)" "$MARKET_ID" "$ALICE" | first)" "1000000000000000000"
new_candle
publish_btc 81000 # the tape now shows the threshold touched
assert_true "the tape has crossed" "$(call "$MARKET" "hasCrossed(uint256)(bool)" "$MARKET_ID")"
expect_revert "staking YES after the crossing reverts" --from "$BOB" --value 1ether "$MARKET" "takeSide(uint256,bool)" "$MARKET_ID" true
expect_revert "staking NO after the crossing reverts too (the market is closed)" --from "$BOB" --value 1ether "$MARKET" "takeSide(uint256,bool)" "$MARKET_ID" false

say "E. loosening a vault waits out the cooling-off"
WL="[$BTC_ID,$ETH_ID]"
LOOSE_SIG="createGuardedVault(address,uint256,bytes32[],uint256)"
expect_revert_send "a looser vault (higher cap) needs a request first" "$ALICE_PK" "$FACTORY" "$LOOSE_SIG" \
  "$EXECUTOR" "$STRATEGY_ID" "$WL" 2000
sendq --private-key "$ALICE_PK" "$FACTORY" "requestLooserVault(uint256,bytes32[],uint256)" "$STRATEGY_ID" "$WL" 2000
expect_revert_send "...and is still refused before the cooldown has elapsed" "$ALICE_PK" "$FACTORY" "$LOOSE_SIG" \
  "$EXECUTOR" "$STRATEGY_ID" "$WL" 2000
# a tighter vault is immediate
sendq --private-key "$ALICE_PK" "$FACTORY" "$LOOSE_SIG" "$EXECUTOR" "$STRATEGY_ID" "[$BTC_ID]" 500
assert_eq "posture follows the newest (tighter) vault" \
  "$(call "$FACTORY" "postureOf(address,uint256)(bool,uint256)" "$ALICE" "$STRATEGY_ID" | sed -n 2p | first)" "500"
cast rpc --rpc-url "$RPC" evm_increaseTime 86401 >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
expect_revert_send "no request exists for cap 3000, so it is still refused" \
  "$ALICE_PK" "$FACTORY" "$LOOSE_SIG" "$EXECUTOR" "$STRATEGY_ID" "$WL" 3000
sendq --private-key "$ALICE_PK" "$FACTORY" "$LOOSE_SIG" "$EXECUTOR" "$STRATEGY_ID" "$WL" 2000
assert_eq "posture after the matured loosening" \
  "$(call "$FACTORY" "postureOf(address,uint256)(bool,uint256)" "$ALICE" "$STRATEGY_ID" | sed -n 2p | first)" "2000"

say "PASS: $PASS assertions"
