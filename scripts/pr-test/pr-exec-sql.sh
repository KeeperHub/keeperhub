#!/usr/bin/env bash
set -euo pipefail

# pr-exec-sql.sh - Execute arbitrary SQL against a PR environment database
# Usage: echo "SELECT 1" | bash scripts/pr-test/pr-exec-sql.sh <PR_NUMBER>
#    or: bash scripts/pr-test/pr-exec-sql.sh <PR_NUMBER> < file.sql

PR_NUMBER="${1:-}"

if [[ -z "$PR_NUMBER" ]]; then
  echo "[ERROR] Usage: echo 'SQL' | $0 <PR_NUMBER>" >&2
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

NAMESPACE="pr-${PR_NUMBER}"
ENV_FILE="/tmp/pr-test-${PR_NUMBER}.env"
POD_NAME="pr-test-exec-${PR_NUMBER}-$$"

# Source or generate connection info
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Connection info not found, running pr-connect.sh..."
  if ! bash "${SCRIPT_DIR}/pr-connect.sh" "$PR_NUMBER" > /dev/null; then
    echo "[ERROR] pr-connect.sh failed" >&2
    exit 1
  fi
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

# Cleanup function to remove pod on exit
cleanup() {
  aws-vault exec sky -- kubectl delete pod "$POD_NAME" \
    -n "$NAMESPACE" --ignore-not-found &>/dev/null || true
}
trap cleanup EXIT

# Read SQL from stdin and execute
SQL_OUTPUT=$(aws-vault exec sky -- kubectl run "$POD_NAME" \
  --rm -i --restart=Never \
  -n "$NAMESPACE" \
  --image=postgres:16-alpine \
  -- psql "${PR_DB_URL}" \
    -v ON_ERROR_STOP=1 \
    -f - 2>&1) || {
  echo "[ERROR] SQL execution failed:" >&2
  echo "$SQL_OUTPUT" >&2
  exit 1
}

echo "$SQL_OUTPUT"
