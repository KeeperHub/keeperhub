#!/usr/bin/env bash
set -euo pipefail

# pr-connect.sh - Validate PR namespace and extract DB credentials from k8s secrets
# Usage: ./scripts/pr-test/pr-connect.sh <PR_NUMBER>

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

NAMESPACE="pr-${PR_NUMBER}"

echo "Checking namespace ${NAMESPACE}..."
if ! aws-vault exec sky -- kubectl get namespace "$NAMESPACE" &>/dev/null; then
  echo "[ERROR] Namespace '${NAMESPACE}' does not exist" >&2
  exit 1
fi

SECRET_NAME="keeperhub-pr-${PR_NUMBER}-db-credentials"
echo "Extracting DB credentials from secret ${SECRET_NAME}..."

PASSWORD_B64=$(aws-vault exec sky -- kubectl get secret "$SECRET_NAME" \
  -n "$NAMESPACE" \
  -o jsonpath='{.data.password}' 2>/dev/null) || {
  echo "[ERROR] Secret '${SECRET_NAME}' not found in namespace '${NAMESPACE}'" >&2
  exit 1
}

if [[ -z "$PASSWORD_B64" ]]; then
  echo "[ERROR] Password field is empty in secret '${SECRET_NAME}'" >&2
  exit 1
fi

PR_DB_PASSWORD=$(echo "$PASSWORD_B64" | base64 -d)

# URL-encode the password for use in connection strings (handles +, =, / etc.)
PR_DB_PASSWORD_ENCODED=$(printf '%s' "$PR_DB_PASSWORD" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=''))" 2>/dev/null) || {
  # Fallback: manual encoding of common special chars
  PR_DB_PASSWORD_ENCODED="${PR_DB_PASSWORD//\%/%25}"
  PR_DB_PASSWORD_ENCODED="${PR_DB_PASSWORD_ENCODED//+/%2B}"
  PR_DB_PASSWORD_ENCODED="${PR_DB_PASSWORD_ENCODED//=/%3D}"
  PR_DB_PASSWORD_ENCODED="${PR_DB_PASSWORD_ENCODED////%2F}"
  PR_DB_PASSWORD_ENCODED="${PR_DB_PASSWORD_ENCODED//@/%40}"
}

PR_APP_URL="https://app-pr-${PR_NUMBER}.keeperhub.com"
PR_DB_HOST="keeperhub-pr-${PR_NUMBER}-db-rw.${NAMESPACE}.svc.cluster.local"
PR_DB_PORT="5432"
PR_DB_NAME="keeperhub"
PR_DB_USER="keeperhub"
PR_DB_URL="postgresql://${PR_DB_USER}:${PR_DB_PASSWORD_ENCODED}@${PR_DB_HOST}:${PR_DB_PORT}/${PR_DB_NAME}"

ENV_FILE="/tmp/pr-test-${PR_NUMBER}.env"

cat > "$ENV_FILE" <<EOF
PR_NAMESPACE=${NAMESPACE}
PR_APP_URL=${PR_APP_URL}
PR_DB_HOST=${PR_DB_HOST}
PR_DB_PORT=${PR_DB_PORT}
PR_DB_NAME=${PR_DB_NAME}
PR_DB_USER=${PR_DB_USER}
PR_DB_PASSWORD=${PR_DB_PASSWORD}
PR_DB_URL=${PR_DB_URL}
EOF

echo ""
echo "PR_NAMESPACE=${NAMESPACE}"
echo "PR_APP_URL=${PR_APP_URL}"
echo "PR_DB_HOST=${PR_DB_HOST}"
echo "PR_DB_PORT=${PR_DB_PORT}"
echo "PR_DB_NAME=${PR_DB_NAME}"
echo "PR_DB_USER=${PR_DB_USER}"
echo "PR_DB_PASSWORD=${PR_DB_PASSWORD}"
echo "PR_DB_URL=${PR_DB_URL}"
echo ""
echo "Connection info written to ${ENV_FILE}"
