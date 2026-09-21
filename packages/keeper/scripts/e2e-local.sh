#!/usr/bin/env bash
# End-to-end run of the keeper against a local anvil, using MockPyth as the feed.
#
#   ./scripts/e2e-local.sh
#
# Same approach as packages/contracts/script/e2e-local.sh: starts its own anvil
# (port $ANVIL_PORT, default 8646 - aborts if something is already listening),
# deploys with script/Deploy.s.sol (which deploys MockPyth on chain 31337), and
# drives the price by hand. Nothing here touches a real network. Anvil is
# killed on exit, pass or fail.
#
#   1. three accounts open 10_000 longs at 100_000 (bob is well collateralised)
#   2. price falls to 90_500: alice is in the ADL band (1.1), carol is below
#      1.0, bob is healthy
#   3. a DRY-RUN keeper pass reports what it would do and changes nothing
#   4. a BROADCAST keeper pass deleverages alice, liquidates carol, skips bob
#   5. a second pass finds nothing left to do (idempotent)
#   6. price falls to 85_000 in a fresh bucket WITHOUT anyone sampling it: the
#      keeper records the sample itself, then liquidates alice
#   7. the keeper earned nothing in USDC; the fund got the penalties
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$PKG/../contracts"
export PATH="$PATH:$HOME/.foundry/bin"

PORT="${ANVIL_PORT:-8646}"
RPC="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t kanon-keeper-anvil.XXXXXX.log)"
OUT="$(mktemp -t kanon-keeper-out.XXXXXX.log)"

MNEMONIC="test test test test test test test test test test test junk"
key_of() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
DEPLOYER_PK="$(key_of 0)"
ALICE_PK="$(key_of 1)"
KEEPER_PK="$(key_of 2)"
BOB_PK="$(key_of 4)"
CAROL_PK="$(key_of 5)"
ALICE="$(cast wallet address --private-key "$ALICE_PK")"
KEEPER="$(cast wallet address --private-key "$KEEPER_PK")"
BOB="$(cast wallet address --private-key "$BOB_PK")"
CAROL="$(cast wallet address --private-key "$CAROL_PK")"

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
fail() { printf '  FAIL %s\n' "$*" >&2; echo "(anvil log: $LOG, keeper output: $OUT)" >&2; exit 1; }
first() { awk 'NR==1{print $1}'; }
call() { cast call --rpc-url "$RPC" "$@"; }
sendq() { cast send --rpc-url "$RPC" "$@" >/dev/null; }
assert_eq() { [[ "$2" == "$3" ]] && ok "$1 = $3" || fail "$1: expected '$3', got '$2'"; }
assert_lt() { python3 -c "import sys; sys.exit(0 if int('$2') < int('$3') else 1)" && ok "$1 ($2 < $3)" || fail "$1: $2 !< $3"; }
assert_ge() { python3 -c "import sys; sys.exit(0 if int('$2') >= int('$3') else 1)" && ok "$1 ($2 >= $3)" || fail "$1: $2 !>= $3"; }
usdc() { python3 -c "print(int(round($1 * 10**6)))"; }
now() { cast block latest --rpc-url "$RPC" --field timestamp; }
json_addr() { jq -r ".$1" "$CONTRACTS/deployments/31337.json"; }

new_candle() {
  local t nb
  t="$(now)"
  nb=$(((t / BUCKET + 1) * BUCKET + 10))
  cast rpc --rpc-url "$RPC" evm_setNextBlockTimestamp "$nb" >/dev/null
  cast rpc --rpc-url "$RPC" evm_mine >/dev/null
}
set_btc_price() { # whole dollars; updates MockPyth only
  sendq --private-key "$DEPLOYER_PK" "$PYTH" "setPrice(bytes32,int64,uint64,int32,uint256)" \
    "$BTC_FEED" "$(($1 * 100000000))" 1 -8 "$(now)"
}
publish_btc() { set_btc_price "$1"; sendq --private-key "$DEPLOYER_PK" "$BTC_SERIES" "recordSample()"; }

health() { call "$MARGIN" "healthFactor(address)(uint256)" "$1" | first; }
open_count() { call "$MARGIN" "openPositionCount(address)(uint256)" "$1" | first; }
pos_size() { call "$MARGIN" "positionOf(address,uint256)(address,bool,uint256,uint256,bool)" "$1" 0 | sed -n 3p | first; }
usdc_of() { call "$USDC" "balanceOf(address)(uint256)" "$1" | first; }

# run the keeper once; stdout (JSON lines) goes to $OUT, the last line is the report
keeper() { # extra env assignments are passed as args: keeper KEEPER_BROADCAST=true
  (cd "$PKG" && env "$@" \
    RPC_URL="$RPC" CHAIN_ID=31337 MARGIN_ACCOUNT_ADDRESS="$MARGIN" START_BLOCK=0 \
    ../../node_modules/.bin/vite-node src/cli.ts) >"$OUT" 2>"$OUT.err" || { cat "$OUT" "$OUT.err" >&2; fail "keeper exited non-zero"; }
  printf '  keeper output:\n'
  jq -c 'select(.event=="action" or .event=="account") | del(.ts)' "$OUT" | sed 's/^/    /'
}
report() { jq -c 'select(.event=="report") | .report' "$OUT"; }
outcome_of() { report | jq -r --arg a "$(echo "$1" | tr 'A-F' 'a-f')" '.accounts[] | select(.account|ascii_downcase==$a) | .outcome'; }
sent_count() { report | jq '[.accounts[].actions[] | select(.outcome=="sent")] | length'; }

# ----------------------------------------------------------------------------
say "anvil + deploy"
if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then fail "something is already listening on $RPC; set ANVIL_PORT"; fi
anvil --port "$PORT" --silent >"$LOG" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
assert_eq "chain id" "$(cast chain-id --rpc-url "$RPC")" "31337"
(cd "$CONTRACTS" && forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --broadcast >/dev/null)
USDC="$(json_addr CollateralToken)"; PYTH="$(json_addr Pyth)"
BTC_SERIES="$(json_addr CanonicalSeriesBTCUSD)"; MARGIN="$(json_addr MarginAccount)"; FUND="$(json_addr InsuranceFund)"
for a in USDC PYTH BTC_SERIES MARGIN FUND; do
  [[ "$(cast code "${!a}" --rpc-url "$RPC")" != "0x" ]] || fail "$a has no code on chain"
done
ok "deployed (MockPyth at $PYTH, MarginAccount at $MARGIN)"

# ----------------------------------------------------------------------------
say "1. three accounts open 10_000 longs at 100_000"
new_candle
publish_btc 100000
open_long() { # pk addr collateral
  sendq --private-key "$DEPLOYER_PK" "$USDC" "mint(address,uint256)" "$2" "$(usdc "$3")"
  sendq --private-key "$1" "$USDC" "approve(address,uint256)" "$MARGIN" "$(usdc "$3")"
  sendq --private-key "$1" "$MARGIN" "deposit(uint256)" "$(usdc "$3")"
  sendq --private-key "$1" "$MARGIN" "openPosition(address,bool,uint256)" "$BTC_SERIES" true "$(usdc 10000)"
}
open_long "$ALICE_PK" "$ALICE" 1500
open_long "$BOB_PK" "$BOB" 5000
open_long "$CAROL_PK" "$CAROL" 1200
assert_eq "alice health at open" "$(health "$ALICE")" "3000000000000000000"

say "2. price falls to 90_500"
new_candle
publish_btc 90500
assert_eq "alice health (ADL band)" "$(health "$ALICE")" "1100000000000000000"
assert_lt "carol health (liquidatable)" "$(health "$CAROL")" "1000000000000000000"
assert_ge "bob health (healthy)" "$(health "$BOB")" "1200000000000000000"
KEEPER_USDC_BEFORE="$(usdc_of "$KEEPER")"
FUND_BEFORE="$(call "$FUND" "balance()(uint256)" | first)"

say "3. dry-run pass: reports the plan, sends nothing"
keeper KEEPER_BROADCAST=false KEEPER_ADDRESS="$KEEPER"
assert_eq "alice outcome" "$(outcome_of "$ALICE")" "would_send"
assert_eq "carol outcome" "$(outcome_of "$CAROL")" "would_send"
assert_eq "bob outcome" "$(outcome_of "$BOB")" "healthy"
assert_eq "dry run did not touch alice" "$(pos_size "$ALICE")" "$(usdc 10000)"
assert_eq "dry run did not touch carol" "$(open_count "$CAROL")" "1"

say "4. broadcast pass: deleverage alice, liquidate carol, skip bob"
keeper KEEPER_BROADCAST=true PRIVATE_KEY="$KEEPER_PK"
assert_eq "alice outcome" "$(outcome_of "$ALICE")" "recovered"
assert_eq "carol outcome" "$(outcome_of "$CAROL")" "closed"
assert_eq "bob outcome" "$(outcome_of "$BOB")" "healthy"
assert_eq "alice position after ADL (75% left)" "$(pos_size "$ALICE")" "$(usdc 7500)"
assert_eq "alice still open" "$(open_count "$ALICE")" "1"
assert_ge "alice health back above the ADL threshold" "$(health "$ALICE")" "1200000000000000000"
assert_eq "carol has no open position" "$(open_count "$CAROL")" "0"
assert_eq "bob untouched" "$(pos_size "$BOB")" "$(usdc 10000)"

say "5. second pass: nothing left to do"
keeper KEEPER_BROADCAST=true PRIVATE_KEY="$KEEPER_PK"
assert_eq "transactions sent" "$(sent_count)" "0"
assert_eq "alice outcome" "$(outcome_of "$ALICE")" "healthy"

say "6. price falls to 85_000 in a fresh bucket that nobody samples"
new_candle
set_btc_price 85000
if call "$MARGIN" "healthFactor(address)(uint256)" "$ALICE" >/dev/null 2>&1; then fail "health should be unreadable before a sample"; else ok "healthFactor reverts NoRecentPrice until the bucket is sampled"; fi
keeper KEEPER_BROADCAST=true PRIVATE_KEY="$KEEPER_PK"
assert_eq "alice outcome" "$(outcome_of "$ALICE")" "closed"
assert_eq "alice has no open position" "$(open_count "$ALICE")" "0"
assert_eq "the keeper recorded the sample itself" "$(report | jq '[.accounts[].actions[] | select(.action=="record_sample" and .outcome=="sent")] | length')" "1"

say "7. economics"
assert_eq "keeper USDC unchanged (liquidator is paid nothing)" "$(usdc_of "$KEEPER")" "$KEEPER_USDC_BEFORE"
assert_ge "fund grew by the penalties" "$(call "$FUND" "balance()(uint256)" | first)" "$((FUND_BEFORE + 1))"
assert_eq "bob untouched to the end" "$(open_count "$BOB")" "1"

say "PASS: $PASS assertions"
