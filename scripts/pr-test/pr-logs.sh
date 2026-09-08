#!/usr/bin/env bash
set -uo pipefail

# pr-logs.sh - Fetch logs from any PR environment component
# Usage: ./scripts/pr-test/pr-logs.sh <PR_NUMBER> [component] [--lines N] [--errors]

PR_NUMBER="${1:-}"

if [[ -z "$PR_NUMBER" ]]; then
  echo "[ERROR] Usage: $0 <PR_NUMBER> [component] [--lines N] [--errors]" >&2
  echo "" >&2
  echo "Components: app (default), db, db-migration, scheduler-dispatcher," >&2
  echo "" >&2
  echo "Options:" >&2
  echo "  --lines N   Number of log lines (default: 100)" >&2
  echo "  --errors    Filter to error/warn/panic/fatal lines" >&2
  exit 1
fi

if ! [[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  echo "[ERROR] PR_NUMBER must be a positive integer, got: '$PR_NUMBER'" >&2
  exit 1
fi

for cmd in aws-vault kubectl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "[ERROR] Required command not found: $cmd" >&2
    exit 1
  fi
done

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/techops-staging}"

shift
NAMESPACE="pr-${PR_NUMBER}"
COMPONENT="app"
LINES=100
ERRORS_ONLY=false

# Parse remaining args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lines)
      LINES="${2:-100}"
      shift 2
      ;;
    --errors)
      ERRORS_ONLY=true
      shift
      ;;
    -*)
      echo "[ERROR] Unknown option: $1" >&2
      exit 1
      ;;
    *)
      COMPONENT="$1"
      shift
      ;;
  esac
done

# Verify namespace exists
if ! aws-vault exec sky -- kubectl get namespace "$NAMESPACE" &>/dev/null; then
  echo "[ERROR] Namespace '${NAMESPACE}' does not exist" >&2
  exit 1
fi

# Map component names to label selectors
get_selector() {
  local comp="$1"
  case "$comp" in
    app)
      echo "app.kubernetes.io/instance=keeperhub-pr-${PR_NUMBER}"
      ;;
    db)
      echo "cnpg.io/cluster=keeperhub-pr-${PR_NUMBER}-db"
      ;;
    scheduler-dispatcher)
      echo "app.kubernetes.io/instance=scheduler-dispatcher-pr-${PR_NUMBER}"
      ;;
    scheduler-executor)
      echo "app.kubernetes.io/instance=scheduler-executor-pr-${PR_NUMBER}"
      ;;
    event-tracker)
      echo "app.kubernetes.io/instance=events-tracker-pr-${PR_NUMBER}"
      ;;
    localstack)
      echo "app=localstack,pr=pr-${PR_NUMBER}"
      ;;
    redis)
      echo "app=redis,pr=pr-${PR_NUMBER}"
      ;;
    db-migration)
      echo "app.kubernetes.io/instance=keeperhub-pr-${PR_NUMBER}"
      ;;
    *)
      echo ""
      ;;
  esac
}

# Fetch logs for a single component
fetch_component_logs() {
  local comp="$1"
  local line_count="$2"
  local selector
  selector=$(get_selector "$comp")

  if [[ -z "$selector" ]]; then
    echo "[ERROR] Unknown component: ${comp}" >&2
    return 1
  fi

  # Find pods matching the selector
  local pods
  pods=$(aws-vault exec sky -- kubectl get pods -n "$NAMESPACE" -l "$selector" --no-headers -o custom-columns=":metadata.name" 2>/dev/null) || pods=""

  if [[ -z "$pods" ]]; then
    echo "[WARNING] No pods found for component '${comp}' (selector: ${selector})"
    return 0
  fi

  # Init container flag for db-migration
  local container_flag=()
  if [[ "$comp" == "db-migration" ]]; then
    container_flag=(-c db-migration)
  fi

  for pod in $pods; do
    echo "--- ${comp}: ${pod} (last ${line_count} lines) ---"
    local log_output
    log_output=$(aws-vault exec sky -- kubectl logs "$pod" -n "$NAMESPACE" "${container_flag[@]}" --tail="$line_count" 2>&1) || {
      echo "[WARNING] Could not fetch logs for ${pod}"
      continue
    }

    if [[ "$ERRORS_ONLY" == true ]]; then
      local filtered
      filtered=$(echo "$log_output" | grep -iE "(error|warn|panic|fatal)" || true)
      if [[ -z "$filtered" ]]; then
        echo "(no error/warn/panic/fatal lines found)"
      else
        echo "$filtered"
      fi
    else
      echo "$log_output"
    fi
    echo ""
  done
}


if [[ "$COMPONENT" == "all" ]]; then
  echo "Fetching summary logs for all components in ${NAMESPACE}..."
  echo ""
  for comp in "${ALL_COMPONENTS[@]}"; do
    fetch_component_logs "$comp" 20
  done
else
  echo "Fetching logs for '${COMPONENT}' in ${NAMESPACE} (${LINES} lines)..."
  echo ""
  fetch_component_logs "$COMPONENT" "$LINES"
fi
