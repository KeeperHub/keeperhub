#!/usr/bin/env bash
# Mutation check for the Tier 0 protocol calldata tests.
#
# A coverage suite whose validity is never falsified can rot silently
# (seeded-but-never-runnable test data has shipped before). This script
# introduces a representative defect - renaming an ABI input in a
# protocol definition - and asserts the calldata tests go red, then
# restores the file. Run it after changing the Tier 0 harness; wire it
# into nightly CI alongside the full sweep.
#
# Requires a clean protocols/aave-v3.ts (the mutation target).

set -euo pipefail

TARGET=protocols/aave-v3.ts
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if ! git diff --quiet "$TARGET"; then
  echo "[mutation-check] $TARGET has local changes; commit or stash first" >&2
  exit 1
fi

run_tests() {
  # RUN_LOCAL=1 (CI, or any host with node): run pnpm directly.
  # Default: containerized node for hosts without a node toolchain.
  if [ "${RUN_LOCAL:-}" = "1" ]; then
    pnpm vitest run tests/unit/protocol-calldata.test.ts >/dev/null 2>&1
  else
    docker run --rm --network host -v "$REPO_DIR":/app -w /app node:22 bash -c \
      "corepack enable >/dev/null 2>&1 && corepack prepare pnpm@9 --activate >/dev/null 2>&1 && pnpm vitest run tests/unit/protocol-calldata.test.ts >/dev/null 2>&1"
  fi
}

restore() { git checkout -- "$TARGET"; }
trap restore EXIT

echo "[mutation-check] baseline run (must pass)"
if ! run_tests; then
  echo "[mutation-check] FAIL: baseline is already red; fix that first" >&2
  exit 1
fi

echo "[mutation-check] mutating: rename ABI input onBehalfOf in $TARGET"
sed -i 's/{ name: "onBehalfOf", type: "address" }/{ name: "onBehalfOff", type: "address" }/' "$TARGET"
if git diff --quiet "$TARGET"; then
  echo "[mutation-check] FAIL: mutation did not apply (pattern drifted?)" >&2
  exit 1
fi

echo "[mutation-check] mutated run (must fail)"
if run_tests; then
  echo "[mutation-check] FAIL: tests stayed green under a broken ABI - Tier 0 lost its teeth" >&2
  exit 1
fi

echo "[mutation-check] PASS: mutation killed by the calldata tests"
