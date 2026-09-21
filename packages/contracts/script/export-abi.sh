#!/usr/bin/env bash
# Exports the ABI of every deployable Kanon contract from forge's `out/` into
# packages/contracts/abi/<Name>.json (a bare JSON array, ready to hand to
# viem/ethers/wagmi or an indexer), plus abi/index.json listing what was written.
#
#   ./script/export-abi.sh            # forge build, then export
#   ./script/export-abi.sh --no-build # export from the existing out/
#
# `PredicateEngine` is an internal library (no external functions) and has no
# ABI worth exporting. `IERC20` is exported because every client needs it for
# approve/allowance against the collateral token.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$PATH:$HOME/.foundry/bin"

CONTRACTS=(
  CanonicalSeries
  StrategyRegistry
  RefusalGate
  ThresholdMarket
  InsuranceFund
  MarginAccount
  GuardedVault
  CopyVault
  VaultFactory
  IERC20
)

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

if [[ "${1:-}" != "--no-build" ]]; then
  forge build >/dev/null
fi

mkdir -p abi
written=()
for name in "${CONTRACTS[@]}"; do
  artifact="out/${name}.sol/${name}.json"
  if [[ ! -f "$artifact" ]]; then
    echo "missing artifact: $artifact (run forge build)" >&2
    exit 1
  fi
  jq '.abi' "$artifact" > "abi/${name}.json"
  written+=("$name")
  printf 'abi/%s.json  (%s entries)\n' "$name" "$(jq 'length' "abi/${name}.json")"
done

printf '%s\n' "${written[@]}" | jq -R . | jq -s '.' > abi/index.json
echo "wrote ${#written[@]} ABIs + abi/index.json"
