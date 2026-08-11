#!/usr/bin/env bash
set -euo pipefail

# pr-seed.sh - Run seed SQL against a PR environment database
# Usage: ./scripts/pr-test/pr-seed.sh <PR_NUMBER>

PR_NUMBER="${1:-}"

if [[ -z "$PR_NUMBER" ]]; then
  echo "[ERROR] Usage: $0 <PR_NUMBER>" >&2
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
SEED_FILE="${SCRIPT_DIR}/seed-pr-data.sql"
SEED_POD_NAME="pr-test-seed-${PR_NUMBER}-$$"

if [[ ! -f "$SEED_FILE" ]]; then
  echo "[ERROR] Seed SQL file not found: ${SEED_FILE}" >&2
  exit 1
fi

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

# Cleanup function to remove debug pod on failure
cleanup() {
  aws-vault exec sky -- kubectl delete pod "$SEED_POD_NAME" \
    -n "$NAMESPACE" --ignore-not-found &>/dev/null || true
}
trap cleanup EXIT

echo "Seeding PR #${PR_NUMBER} database..."
echo "  Namespace: ${NAMESPACE}"
echo "  SQL file:  ${SEED_FILE}"
echo ""

# Execute seed SQL
SEED_OUTPUT=$(aws-vault exec sky -- kubectl run "$SEED_POD_NAME" \
  --rm -i --restart=Never \
  -n "$NAMESPACE" \
  --image=postgres:16-alpine \
  -- psql "${PR_DB_URL}" \
    -v ON_ERROR_STOP=1 \
    -f - < "$SEED_FILE" 2>&1) || {
  echo "[ERROR] Seed SQL execution failed:" >&2
  echo "$SEED_OUTPUT" >&2
  exit 1
}

echo "Seed SQL executed successfully."
echo ""

# Run verification query
VERIFY_POD_NAME="pr-test-verify-${PR_NUMBER}-$$"

# Update cleanup to also remove verify pod
cleanup() {
  aws-vault exec sky -- kubectl delete pod "$SEED_POD_NAME" \
    -n "$NAMESPACE" --ignore-not-found &>/dev/null || true
  aws-vault exec sky -- kubectl delete pod "$VERIFY_POD_NAME" \
    -n "$NAMESPACE" --ignore-not-found &>/dev/null || true
}

VERIFY_SQL="SELECT 'workflows' as entity, count(*) FROM workflows WHERE user_id = (SELECT id FROM users WHERE email = 'pr-test-do-not-delete@techops.services')
UNION ALL
SELECT 'executions', count(*) FROM workflow_executions WHERE user_id = (SELECT id FROM users WHERE email = 'pr-test-do-not-delete@techops.services')
UNION ALL
SELECT 'org_api_keys', count(*) FROM organization_api_keys WHERE organization_id IN (SELECT organization_id FROM member WHERE user_id = (SELECT id FROM users WHERE email = 'pr-test-do-not-delete@techops.services'))
UNION ALL
SELECT 'wallets', count(*) FROM organization_wallets WHERE organization_id IN (SELECT organization_id FROM member WHERE user_id = (SELECT id FROM users WHERE email = 'pr-test-do-not-delete@techops.services'));"

echo "Verifying seeded data..."
VERIFY_OUTPUT=$(echo "$VERIFY_SQL" | aws-vault exec sky -- kubectl run "$VERIFY_POD_NAME" \
  --rm -i --restart=Never \
  -n "$NAMESPACE" \
  --image=postgres:16-alpine \
  -- psql "${PR_DB_URL}" -t 2>&1) || {
  echo "[WARNING] Verification query failed, but seed may have succeeded." >&2
  echo "$VERIFY_OUTPUT" >&2
  exit 0
}

# Parse counts from verification output
WORKFLOW_COUNT=$(echo "$VERIFY_OUTPUT" | grep "workflows" | awk -F'|' '{print $2}' | tr -d ' ')
EXECUTION_COUNT=$(echo "$VERIFY_OUTPUT" | grep "executions" | awk -F'|' '{print $2}' | tr -d ' ')
API_KEY_COUNT=$(echo "$VERIFY_OUTPUT" | grep "org_api_keys" | awk -F'|' '{print $2}' | tr -d ' ')
WALLET_COUNT=$(echo "$VERIFY_OUTPUT" | grep "wallets" | awk -F'|' '{print $2}' | tr -d ' ')

echo ""
echo "Seeded: ${WORKFLOW_COUNT:-0} workflows, ${EXECUTION_COUNT:-0} executions, ${API_KEY_COUNT:-0} org API keys, ${WALLET_COUNT:-0} wallets"
