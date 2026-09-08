#!/usr/bin/env bash
# Local full-stack rig for the protocol-coverage suites.
#
# Reproduces the e2e-vitest-ephemeral CI environment on a developer
# machine so suite changes are validated in minutes instead of a
# 30-minute CI round: shared postgres database, an anvil mainnet fork,
# a production app build, and the same chains-row patching CI applies.
# All node/pnpm invocations run inside a node:22 container - no host
# node required. A Sepolia fork exists only for the Tier 1 `sim`
# path (aave-v3 still carries Sepolia testData); no Tier 2 coverage
# suite targets Sepolia since the chronicle/superfluid re-homing.
#
#   scripts/protocol-local.sh up            # build + start everything
#   scripts/protocol-local.sh test [suite]  # run all suites or one (e.g. superfluid)
#   scripts/protocol-local.sh sim [chain]   # Tier 1 fork simulations (no app needed)
#                                           # chain: ethereum|sepolia|base|arbitrum
#   scripts/protocol-local.sh snapshot [chain]  # warm + package a fork RPC cache
#   scripts/protocol-local.sh down [--purge]
#
# Fork RPC caches: `snapshot` pins a fresh fork behind head with an
# empty host dir mounted at foundry's RPC cache path, runs the Tier 1
# sweep once to warm it, and stops the fork gracefully so anvil
# flushes every upstream fetch to
# .claude/fork-snapshots/<chain>-<block>/. The cache stores upstream
# fetches, never local mutations, so a consumer starts pristine at the
# pin and the sweep re-runs cleanly on top. Exporting
# MAINNET_FORK_CACHE_DIR / SEPOLIA_FORK_CACHE_DIR points start_fork at
# such a dir: it re-pins the fork to the block in the dir name and
# mounts the cache, so every slot the warm sweep touched is served
# locally with zero hot-path upstream reads.
#
# Signing: real on-chain writes need TURNKEY_API_PUBLIC_KEY,
# TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID exported in the
# calling shell (`up` seeds a real Turnkey wallet when they are set).
# Without them, `up` seeds a placeholder wallet row: dispatch and read
# paths work, write steps fail loudly at signing. Keys are only ever
# passed as process environment - never written to disk.
#
# Fork upstreams default to public endpoints. Known constraint (see
# specs/protocol-coverage-methodology.md): a fork on a public upstream
# that serves state only for recent blocks is healthy for ~15 minutes;
# export ANVIL_FORK_MAINNET_URL (mainnet) / ANVIL_FORK_URL (sepolia)
# for an upstream that serves historical state at the pin.

set -euo pipefail

APP_PORT="${APP_PORT:-3001}"
DB_NAME="${PROTOCOL_LOCAL_DB:-keeperhub_protocol_local}"
DB_PORT="${PROTOCOL_LOCAL_DB_PORT:-5433}"
APP_CONTAINER=kh-protocol-local-app
NODE_IMAGE=node:22
# anvil 1.7.1, the newest foundry release, pinned by digest - the same
# pin CI runs (see e2e-tests-ephemeral.yml). `latest` on GHCR is
# foundry's nightly tag, not a release, so this rig used to run a
# different anvil every day than the one that had produced a cached
# fork, and one nightly could not fork any OP-stack chain at all.
# `stable` is unmaintained (still 1.5.1, 2025-12-22). Override to try a
# different anvil; a fork cache is only reusable across matching ones.
FOUNDRY_IMAGE="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry:v1.7.1@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATABASE_URL="postgresql://postgres:postgres@localhost:${DB_PORT}/${DB_NAME}"
RESULTS_FILE=".claude/protocol-local-results.json"

# Logs go to stderr so helpers whose stdout is captured by command
# substitution (mainnet_upstream) can log without corrupting their result.
log() { printf '[protocol-local] %s\n' "$*" >&2; }

run_node() {
  # shellcheck disable=SC2068 # word-splitting of env pairs is intended
  docker run --rm --network host -v "$REPO_DIR":/app -w /app \
    -e DATABASE_URL="$DATABASE_URL" \
    ${TURNKEY_API_PUBLIC_KEY:+-e TURNKEY_API_PUBLIC_KEY} \
    ${TURNKEY_API_PRIVATE_KEY:+-e TURNKEY_API_PRIVATE_KEY} \
    ${TURNKEY_ORGANIZATION_ID:+-e TURNKEY_ORGANIZATION_ID} \
    ${TESTNET_FUNDER_PK:+-e TESTNET_FUNDER_PK} \
    "$NODE_IMAGE" bash -c "set -o pipefail && corepack enable >/dev/null 2>&1 && corepack prepare pnpm@9 --activate >/dev/null 2>&1 && $*"
}

db_container() {
  docker ps --filter "name=keeperhub-db" --filter "status=running" \
    --format '{{.Names}}' | grep -vi 'test' | head -n1
}

psql_local() {
  local container
  container="$(db_container)"
  if [ -z "$container" ]; then
    log "no running keeperhub db container; start it: docker compose --profile infra up -d db"
    exit 1
  fi
  docker exec "$container" psql -U postgres "$@"
}

wait_for_fork() {
  local port="$1" chain_hex="$2" name="$3" retries=0
  until curl -sf -m 5 -X POST "http://localhost:${port}" \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' | grep -q "\"${chain_hex}\""; do
    retries=$((retries + 1))
    if [ "$retries" -ge 30 ]; then
      log "${name} fork did not become ready on :${port} in 60s"
      docker logs "$name" 2>&1 | tail -10 || true
      exit 1
    fi
    sleep 2
  done
  log "${name} ready on :${port}"
}

mainnet_upstream() {
  # Explicit env, else the public default. No upstream is ever adopted
  # from other containers: a scraped URL carries no chain guarantee (a
  # Sepolia archive key would fork "mainnet" from Sepolia state, and
  # anvil reports the configured chain id regardless, so the readiness
  # probe cannot catch it) and could silently burn dRPC quota.
  if [ -n "${ANVIL_FORK_MAINNET_URL:-}" ]; then
    printf '%s' "$ANVIL_FORK_MAINNET_URL"
    return
  fi
  log "WARNING: mainnet fork on public upstream - healthy for ~15 minutes only; export ANVIL_FORK_MAINNET_URL for an archive upstream"
  printf '%s' "https://ethereum-rpc.publicnode.com"
}

start_fork() {
  local name="$1" port="$2" chain_id="$3" chain_hex="$4" upstream="$5" cache_dir="${6:-}" cache_mode="${7:-consume}"
  docker rm -f "$name" 2>/dev/null || true
  # Pin the fork a few blocks behind head so every node behind a load
  # balanced public upstream already has the block. This removes one
  # source of transient bad state (reason-less reverts that replay green
  # one block earlier - observed on morpho/aave under a degraded
  # upstream); it does not make a throttled public upstream reliable.
  # The durable fix is exporting an archive ANVIL_FORK_*_URL.
  local pin="" head=""
  local -a pin_args=() mount_args=()
  if [ -n "$cache_dir" ]; then
    # Fork RPC fetch cache (see cmd_snapshot). Measured behavior
    # (then-current foundry nightly, 2026-07-07; the pinned 1.7.1 writes
    # the same rpc/<chain>/<block>/storage.json layout, but the file is
    # zstd-compressed and its schema is not guaranteed stable across
    # anvil versions - treat a cache as reusable only by the version
    # that wrote it):
    # - anvil (uid 1000, HOME=/home/foundry in the image) persists its
    #   upstream fetches to
    #   $HOME/.foundry/cache/rpc/<chain>/<block>/storage.json, and only
    #   flushes on graceful shutdown (SIGTERM); SIGKILL loses it.
    # - A fresh anvil with the cache mounted serves every previously
    #   fetched account/slot locally (zero upstream requests, verified
    #   through a counting proxy) and starts pristine: the cache holds
    #   upstream fetches, never local mutations, so warmed writes are
    #   not visible and the sweep re-runs cleanly on top.
    # - Cold state still lazy-fetches from --fork-url and fails loudly
    #   when it cannot. anvil also needs the upstream live at startup
    #   (chain id, block env) and for the mining loop's block-hash
    #   reads, so the cache cuts hot-path state reads; it does not
    #   replace the upstream.
    # The cached values were fetched at the pin in the dir name, so the
    # fork must re-pin there.
    local chain_name
    case "$chain_id" in
      1) chain_name=mainnet ;;
      11155111) chain_name=sepolia ;;
      *) log "no fork-cache naming defined for chain id ${chain_id}"; exit 1 ;;
    esac
    if [ ! -d "$cache_dir" ]; then
      log "fork cache dir not found: ${cache_dir}"
      exit 1
    fi
    local cache_base
    cache_base="$(basename "$cache_dir")"
    case "$cache_base" in
      "${chain_name}"-*) ;;
      *)
        log "fork cache dir '${cache_base}' does not match chain '${chain_name}' (expected ${chain_name}-<block>)"
        exit 1
        ;;
    esac
    pin="${cache_base##*-}"
    if ! [[ "$pin" =~ ^[0-9]+$ ]]; then
      log "cannot parse the pinned block from '${cache_base}' (expected ${chain_name}-<block>)"
      exit 1
    fi
    # Producers mount an empty dir for anvil to fill; consumers must
    # bring the flushed cache or every read silently goes upstream.
    if [ "$cache_mode" = "consume" ] && [ ! -f "${cache_dir}/rpc/${chain_name}/${pin}/storage.json" ]; then
      log "fork cache dir ${cache_dir} has no rpc/${chain_name}/${pin}/storage.json (empty or mispackaged cache)"
      exit 1
    fi
    local cache_abs
    cache_abs="$(cd "$cache_dir" && pwd)"
    mount_args=(-v "${cache_abs}:/home/foundry/.foundry/cache")
    pin_args=(--fork-block-number "$pin")
    log "${name}: fork RPC cache ${cache_base} mounted (re-pinned to its fetch block ${pin})"
  else
    head=$(curl -sf -X POST -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
      "$upstream" | grep -oE '"result":"0x[0-9a-f]+"' | cut -d'"' -f4) || true
    if [ -n "$head" ]; then
      pin=$((head - 12))
      pin_args=(--fork-block-number "$pin")
    fi
  fi
  docker run -d --name "$name" -p "${port}:8545" ${mount_args[@]+"${mount_args[@]}"} --entrypoint anvil \
    "$FOUNDRY_IMAGE" \
    --host 0.0.0.0 --fork-url "$upstream" ${pin_args[@]+"${pin_args[@]}"} --chain-id "$chain_id" --block-time 1 >/dev/null
  wait_for_fork "$port" "$chain_hex" "$name"
}

# Rig-owned containers (not the compose service names): the compose
# services declare fixed container_names that collide across checkouts
# and with manually started forks. Ports must match the chains-row
# patch below; override holders must be stopped or ports overridden.
# Cache dirs are per-chain envs (not one shared var) so a mainnet
# cache can never be loaded into the Sepolia fork; start_fork's
# dir-name prefix guard enforces the same invariant.
start_mainnet_fork() {
  start_fork kh-protocol-local-fork-mainnet "${MAINNET_FORK_PORT:-8548}" 1 "0x1" "$(mainnet_upstream)" \
    "${MAINNET_FORK_CACHE_DIR:-}"
}

# Tier 1 `sim` only: pinned-block fork for protocols whose fixtures bind
# state recorded at a specific block (testData.pinnedBlock; pendle - its
# markets expire, so live-head bindings rot). The pin is resolved from
# the registry via scripts/protocol-pinned-block.ts, so a fixture
# refresh touches only the protocol's testData. A fixed pin needs an
# upstream that serves historical state (public endpoints refuse state
# reads even a few hundred blocks behind head), so this fork only
# starts when ANVIL_FORK_MAINNET_URL is exported; without it the pinned
# protocols self-skip (chains.test.ts gates each pinned suite on
# PROTOCOL_SIM_RPC_<chainId>_PINNED). Sets PINNED_SIM_RPC for cmd_sim.
start_pinned_mainnet_fork() {
  PINNED_SIM_RPC=""
  if [ -z "${ANVIL_FORK_MAINNET_URL:-}" ]; then
    log "ANVIL_FORK_MAINNET_URL not set: skipping the pinned-block mainnet fork - pinned-fixture protocols (pendle) will self-skip"
    return
  fi
  local pin
  pin=$(run_node "pnpm tsx scripts/protocol-pinned-block.ts 1" | tail -1)
  if ! [[ "$pin" =~ ^[0-9]+$ ]]; then
    log "could not resolve the chain-1 pinned block from the registry (got '${pin}')"
    exit 1
  fi
  local name=kh-protocol-local-fork-mainnet-pinned
  local port="${PINNED_FORK_PORT:-8549}"
  docker rm -f "$name" 2>/dev/null || true
  docker run -d --name "$name" -p "${port}:8545" --entrypoint anvil \
    "$FOUNDRY_IMAGE" \
    --host 0.0.0.0 --fork-url "$ANVIL_FORK_MAINNET_URL" \
    --fork-block-number "$pin" --chain-id 1 --block-time 1 >/dev/null
  wait_for_fork "$port" "0x1" "$name"
  log "pinned mainnet fork at block ${pin} on :${port}"
  PINNED_SIM_RPC="PROTOCOL_SIM_RPC_1_PINNED=http://localhost:${port}"
}

# Tier 1 `sim` only: aave-v3 still carries Sepolia testData. No Tier 2
# coverage suite targets Sepolia, so `up`/`test` never start this fork.
start_sepolia_fork() {
  start_fork kh-protocol-local-fork-sepolia "${SEPOLIA_FORK_PORT:-8547}" 11155111 "0xaa36a7" \
    "${ANVIL_FORK_URL:-https://ethereum-sepolia-rpc.publicnode.com}" "${SEPOLIA_FORK_CACHE_DIR:-}"
}

# Tier 1 `sim` only: Base + Arbitrum One forks for the multi-chain read
# sweep (chainlink price feeds on both, plus ajna's Base reads). Public
# upstreams are acceptable here - simulations read forked state and never
# mine against the upstream - so no archive endpoint is required; override
# with ANVIL_FORK_BASE_URL / ANVIL_FORK_ARBITRUM_URL for a private one.
start_base_fork() {
  start_fork kh-protocol-local-fork-base "${BASE_FORK_PORT:-8550}" 8453 "0x2105" \
    "${ANVIL_FORK_BASE_URL:-https://base-rpc.publicnode.com}"
}

start_arbitrum_fork() {
  start_fork kh-protocol-local-fork-arbitrum "${ARBITRUM_FORK_PORT:-8551}" 42161 "0xa4b1" \
    "${ANVIL_FORK_ARBITRUM_URL:-https://arbitrum-one-rpc.publicnode.com}"
}

patch_chains() {
  # Same patch CI applies: point chain 1 at the local fork and null the
  # fallback so nothing leaks to live mainnet on failure. The port must
  # track the same override start_mainnet_fork honors, or a port
  # override would leave the chains row pointing at a dead socket.
  psql_local -d "$DB_NAME" \
    -c "UPDATE chains SET default_primary_rpc = 'http://localhost:${MAINNET_FORK_PORT:-8548}', default_fallback_rpc = NULL WHERE chain_id = 1" >/dev/null
  log "chain 1 row patched to the local fork (:${MAINNET_FORK_PORT:-8548})"
}

cmd_up() {
  psql_local -c "CREATE DATABASE \"${DB_NAME}\"" 2>/dev/null || true
  log "database ${DB_NAME} ready on :${DB_PORT}"

  log "workflow schema + migrations + seeds (containerized pnpm)"
  run_node "pnpm db:setup-workflow >/dev/null && pnpm db:migrate >/dev/null && CHAIN_RPC_CONFIG=\"\${CHAIN_RPC_CONFIG:-}\" pnpm db:seed | tail -1"

  if [ -n "${TURNKEY_API_PUBLIC_KEY:-}" ] && [ -n "${TURNKEY_API_PRIVATE_KEY:-}" ] && [ -n "${TURNKEY_ORGANIZATION_ID:-}" ]; then
    log "seeding real Turnkey wallet"
    run_node "pnpm db:seed-test-wallet | tail -2"
  else
    log "TURNKEY_* not set: seeding placeholder wallet (writes will fail at signing)"
    # db:seed-test-wallet creates the persistent user/org/member before it
    # refuses on the missing Turnkey env - run it for those side effects
    # and tolerate the refusal, then satisfy the wallet lookup ourselves.
    run_node "pnpm db:seed-test-wallet >/dev/null 2>&1 || true"
    psql_local -d "$DB_NAME" -c "
      INSERT INTO organization_wallets (id, user_id, email, wallet_address, organization_id, turnkey_sub_org_id, turnkey_wallet_id, turnkey_private_key_id, is_active)
      SELECT 'protocol-local-placeholder', u.id, u.email, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', o.id, 'placeholder', 'placeholder', 'placeholder', true
      FROM users u JOIN organization o ON o.slug = 'e2e-test-org'
      WHERE u.email = 'pr-test-do-not-delete@techops.services'
      ON CONFLICT (id) DO NOTHING" | tail -1
  fi

  start_mainnet_fork
  patch_chains

  if [ ! -f "$REPO_DIR/.next/BUILD_ID" ] || [ "${1:-}" = "--rebuild" ]; then
    log "production build (several minutes; sandbox guards required at build time)"
    run_node "BETTER_AUTH_SECRET=protocol-local-secret CI=true TEST_API_KEY=protocol-local-api-key NEXT_PUBLIC_BILLING_ENABLED=true NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED=true SANDBOX_BACKEND=remote SANDBOX_URL=http://localhost:8787 pnpm build 2>&1 | tail -3"
  else
    log "reusing existing production build (.next/BUILD_ID present; pass --rebuild to force)"
  fi

  docker rm -f "$APP_CONTAINER" 2>/dev/null || true
  docker run -d --name "$APP_CONTAINER" --network host -v "$REPO_DIR":/app -w /app \
    -e PORT="$APP_PORT" \
    -e DATABASE_URL="$DATABASE_URL" \
    -e BETTER_AUTH_SECRET=protocol-local-secret \
    -e OAUTH_JWT_SECRET=protocol-local-oauth-secret \
    -e MCP_SESSION_SECRET=protocol-local-mcp-secret \
    -e CI=true \
    -e TEST_API_KEY=protocol-local-api-key \
    -e INTEGRATION_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    -e WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
    -e AWS_ENDPOINT_URL=http://localhost:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e SAFE_FETCH_SHADOW=true \
    -e SANDBOX_BACKEND=remote -e SANDBOX_URL=http://localhost:8787 \
    ${TURNKEY_API_PUBLIC_KEY:+-e TURNKEY_API_PUBLIC_KEY} \
    ${TURNKEY_API_PRIVATE_KEY:+-e TURNKEY_API_PRIVATE_KEY} \
    ${TURNKEY_ORGANIZATION_ID:+-e TURNKEY_ORGANIZATION_ID} \
    "$NODE_IMAGE" bash -c "corepack enable >/dev/null 2>&1 && corepack prepare pnpm@9 --activate >/dev/null 2>&1 && pnpm start" >/dev/null

  local retries=0
  until curl -sf -m 3 "http://localhost:${APP_PORT}" >/dev/null 2>&1; do
    retries=$((retries + 1))
    if [ "$retries" -ge 40 ]; then
      log "app did not become ready on :${APP_PORT}"
      docker logs "$APP_CONTAINER" 2>&1 | tail -20
      exit 1
    fi
    sleep 3
  done
  # A curl 200 alone is not proof of OUR app: a foreign listener already
  # holding the port answers while our container dies on EADDRINUSE, and
  # every request then lands in the wrong app and database. Require the
  # rig's own container to still be running.
  if [ "$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null)" != "true" ]; then
    log "port :${APP_PORT} answered but ${APP_CONTAINER} is not running - a foreign process holds the port (try APP_PORT=<other> or stop the squatter)"
    docker logs "$APP_CONTAINER" 2>&1 | tail -5
    exit 1
  fi
  log "app ready on :${APP_PORT} - rig is up"
}

cmd_test() {
  local suite="${1:-}"
  local target="tests/e2e/vitest/protocol-coverage"
  if [ -n "$suite" ]; then
    target="tests/e2e/vitest/protocol-coverage/${suite}"
  fi

  # Re-assert the chains patch (some general e2e tests rewrite rows).
  patch_chains

  log "running ${target}"
  local started ended
  started=$(date +%s)
  # ANVIL_FORK_MAINNET_URL gates the mainnet suites (the actual RPC the
  # app uses comes from the patched chains row); TESTNET_FUNDER_PK gates
  # ajna's live-Base reads and reaches the container by name via run_node
  # (-e, value resolved out-of-band) so the key never appears in argv.
  # Keep the vitest exit status but run the report first (|| alone would
  # let set -e abort before it); re-exit with it so callers and automation
  # see red runs as red.
  local rc=0
  run_node "PROTOCOL_E2E_BASE_URL=http://localhost:${APP_PORT} ANVIL_FORK_MAINNET_URL=http://localhost:${MAINNET_FORK_PORT:-8548} pnpm vitest run ${target} --reporter=default --reporter=json --outputFile=${RESULTS_FILE}" || rc=$?
  ended=$(date +%s)
  log "suite wall-clock: $((ended - started))s"
  log "coverage report with executed results:"
  run_node "pnpm coverage:report --results ${RESULTS_FILE}"
  return "$rc"
}

cmd_sim() {
  local chain="${1:-}"
  local target="tests/e2e/vitest/protocol-simulation"
  # Chain selection is env-driven: chains.test.ts gates each chain on its
  # PROTOCOL_SIM_RPC_<chainId> var, so export only the requested one(s).
  local env_rpc
  case "$chain" in
    "")
      env_rpc="PROTOCOL_SIM_RPC_1=http://localhost:${MAINNET_FORK_PORT:-8548} PROTOCOL_SIM_RPC_11155111=http://localhost:${SEPOLIA_FORK_PORT:-8547} PROTOCOL_SIM_RPC_8453=http://localhost:${BASE_FORK_PORT:-8550} PROTOCOL_SIM_RPC_42161=http://localhost:${ARBITRUM_FORK_PORT:-8551}"
      ;;
    ethereum)
      env_rpc="PROTOCOL_SIM_RPC_1=http://localhost:${MAINNET_FORK_PORT:-8548}"
      ;;
    sepolia)
      env_rpc="PROTOCOL_SIM_RPC_11155111=http://localhost:${SEPOLIA_FORK_PORT:-8547}"
      ;;
    base)
      env_rpc="PROTOCOL_SIM_RPC_8453=http://localhost:${BASE_FORK_PORT:-8550}"
      ;;
    arbitrum)
      env_rpc="PROTOCOL_SIM_RPC_42161=http://localhost:${ARBITRUM_FORK_PORT:-8551}"
      ;;
    *)
      log "unknown chain '${chain}' (expected: ethereum, sepolia, base, arbitrum)"
      exit 1
      ;;
  esac
  # Tier 1 needs only the forks for the requested chain(s) - no app, no
  # database beyond none at all. The ethereum runs additionally start the
  # pinned-block fork (archive upstream permitting) so pinned-fixture
  # protocols execute instead of self-skipping.
  local PINNED_SIM_RPC=""
  case "$chain" in
    "") start_mainnet_fork; start_pinned_mainnet_fork; start_sepolia_fork; start_base_fork; start_arbitrum_fork ;;
    ethereum) start_mainnet_fork; start_pinned_mainnet_fork ;;
    sepolia) start_sepolia_fork ;;
    base) start_base_fork ;;
    arbitrum) start_arbitrum_fork ;;
  esac
  log "running Tier 1 simulations: ${target}${chain:+ (${chain})}"
  local started ended
  started=$(date +%s)
  local rc=0
  run_node "${env_rpc} ${PINNED_SIM_RPC} pnpm vitest run ${target} --reporter=default --reporter=json --outputFile=.claude/protocol-sim-results.json" || rc=$?
  ended=$(date +%s)
  log "simulation wall-clock: $((ended - started))s"
  return "$rc"
}

cmd_snapshot() {
  # Produce a fork RPC fetch cache: resolve a pin behind head, mount an
  # empty host cache dir into a fresh fork pinned there, run the Tier 1
  # sweep once to warm every account/slot it touches (eth_call reads
  # included - the cache records fetches, not transaction commits),
  # then stop the fork gracefully so anvil flushes the cache. See
  # start_fork for the measured flush/load behavior. Because the cache
  # holds upstream fetches and no sweep mutations, consumers start
  # pristine at the pin and the sweep re-runs cleanly on top.
  local chain="${1:-ethereum}"
  local name port upstream cid chex env_rpc chain_name cache_var
  case "$chain" in
    ethereum)
      name=kh-protocol-local-fork-mainnet
      port="${MAINNET_FORK_PORT:-8548}"
      upstream="$(mainnet_upstream)"
      cid=1 chex="0x1"
      chain_name=mainnet cache_var=MAINNET_FORK_CACHE_DIR
      env_rpc="PROTOCOL_SIM_RPC_1=http://localhost:${port}"
      ;;
    sepolia)
      name=kh-protocol-local-fork-sepolia
      port="${SEPOLIA_FORK_PORT:-8547}"
      upstream="${ANVIL_FORK_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
      cid=11155111 chex="0xaa36a7"
      chain_name=sepolia cache_var=SEPOLIA_FORK_CACHE_DIR
      env_rpc="PROTOCOL_SIM_RPC_11155111=http://localhost:${port}"
      ;;
    *)
      log "unknown chain '${chain}' (expected: ethereum, sepolia)"
      exit 1
      ;;
  esac
  # The cache dir is named for the pin and must be mounted before the
  # fork starts, so resolve the pin here rather than inside start_fork.
  local head pin
  head=$(curl -sf -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
    "$upstream" | grep -oE '"result":"0x[0-9a-f]+"' | cut -d'"' -f4) || true
  if [ -z "$head" ]; then
    log "could not resolve head from ${upstream}; a cache without a pin is not consumable"
    exit 1
  fi
  pin=$((head - 12))
  local cache_dir=".claude/fork-snapshots/${chain_name}-${pin}"
  mkdir -p "$cache_dir"
  # anvil runs as uid 1000 in the foundry image and must create
  # rpc/<chain>/<block>/ inside the mount, whatever uid owns it here.
  chmod 777 "$cache_dir"
  start_fork "$name" "$port" "$cid" "$chex" "$upstream" "$cache_dir" produce
  log "warming ${chain} fork (pin ${pin}) with the Tier 1 sweep"
  local rc=0
  run_node "${env_rpc} pnpm vitest run tests/e2e/vitest/protocol-simulation --reporter=default" || rc=$?
  if [ "$rc" -ne 0 ]; then
    # A red sweep's fetches are still valid pinned-block values (the
    # cache records no mutations), so keep the cache but propagate the
    # failure so automation treats the run as degraded.
    log "WARNING: sweep exited ${rc}; keeping the partially warmed cache"
  fi
  # Graceful stop: anvil flushes its cache on SIGTERM only.
  docker stop --time 30 "$name" >/dev/null
  if [ ! -f "${cache_dir}/rpc/${chain_name}/${pin}/storage.json" ]; then
    log "anvil flushed no cache to ${cache_dir} (expected rpc/${chain_name}/${pin}/storage.json)"
    exit 1
  fi
  log "fork cache written: ${cache_dir} ($(du -sh "$cache_dir" | cut -f1))"
  log "consume with: ${cache_var}=${cache_dir} scripts/protocol-local.sh sim"
  return "$rc"
}

cmd_down() {
  docker rm -f "$APP_CONTAINER" kh-protocol-local-fork-sepolia kh-protocol-local-fork-mainnet kh-protocol-local-fork-mainnet-pinned kh-protocol-local-fork-base kh-protocol-local-fork-arbitrum 2>/dev/null || true
  if [ "${1:-}" = "--purge" ]; then
    psql_local -c "DROP DATABASE IF EXISTS \"${DB_NAME}\""
    log "database ${DB_NAME} dropped"
  fi
  log "rig is down"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  test) shift; cmd_test "$@" ;;
  sim) shift; cmd_sim "$@" ;;
  snapshot) shift; cmd_snapshot "$@" ;;
  down) shift; cmd_down "$@" ;;
  # Usage: print the whole leading comment block (skip the shebang,
  # stop at the first non-comment line) instead of grepping every
  # comment in the file behind a hardcoded line bound that truncated
  # the header whenever it grew.
  *) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 1 ;;
esac
