#!/usr/bin/env bash
set -uo pipefail

# pr-preflight.sh - Run health checks on a PR environment
# Usage: ./scripts/pr-test/pr-preflight.sh <PR_NUMBER>

PR_NUMBER="${1:-}"

if [[ -z "$PR_NUMBER" ]]; then
  echo "[ERROR] Usage: $0 <PR_NUMBER>" >&2
  exit 1
fi

if ! [[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  echo "[ERROR] PR_NUMBER must be a positive integer, got: '$PR_NUMBER'" >&2
  exit 1
fi

for cmd in aws-vault kubectl curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "[ERROR] Required command not found: $cmd" >&2
    exit 1
  fi
done

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/techops-staging}"

NAMESPACE="pr-${PR_NUMBER}"
ENV_FILE="/tmp/pr-test-${PR_NUMBER}.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
KUBECTL_TIMEOUT=30

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

TOTAL=0
PASSED=0
FAILED=0
RESULTS=()

run_check() {
  local name="$1"
  local status="$2"
  local detail="${3:-}"
  TOTAL=$((TOTAL + 1))
  if [[ "$status" == "PASS" ]]; then
    PASSED=$((PASSED + 1))
    RESULTS+=("[PASS] ${name}")
  else
    FAILED=$((FAILED + 1))
    if [[ -n "$detail" ]]; then
      RESULTS+=("[FAIL] ${name} -- ${detail}")
    else
      RESULTS+=("[FAIL] ${name}")
    fi
  fi
}

echo "Running preflight checks for PR #${PR_NUMBER} (namespace: ${NAMESPACE})..."
echo ""

# --- Check 1: Namespace exists ---
echo "  Checking namespace..."
if timeout "$KUBECTL_TIMEOUT" aws-vault exec sky -- kubectl get namespace "$NAMESPACE" &>/dev/null; then
  run_check "Namespace exists" "PASS"
else
  run_check "Namespace exists" "FAIL" "Namespace '${NAMESPACE}' not found"
fi

# --- Check 2: All pods running ---
echo "  Checking pod statuses..."
POD_OUTPUT=$(timeout "$KUBECTL_TIMEOUT" aws-vault exec sky -- kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null) || POD_OUTPUT=""

if [[ -z "$POD_OUTPUT" ]]; then
  run_check "All pods running" "FAIL" "Could not list pods or no pods found"
else
  BAD_PODS=""
  while IFS= read -r line; do
    pod_name=$(echo "$line" | awk '{print $1}')
    pod_status=$(echo "$line" | awk '{print $3}')
    if [[ "$pod_status" != "Running" && "$pod_status" != "Completed" ]]; then
      BAD_PODS="${BAD_PODS}${pod_name}(${pod_status}) "
    fi
  done <<< "$POD_OUTPUT"

  if [[ -z "$BAD_PODS" ]]; then
    run_check "All pods running" "PASS"
  else
    run_check "All pods running" "FAIL" "Unhealthy pods: ${BAD_PODS}"

    # Fetch logs for CrashLoopBackOff pods
    for pod_info in $BAD_PODS; do
      pod_name="${pod_info%%(*}"
      pod_status="${pod_info#*(}"
      pod_status="${pod_status%)}"
      if [[ "$pod_status" == "CrashLoopBackOff" ]]; then
        echo ""
        echo "  --- Last 10 log lines for ${pod_name} (CrashLoopBackOff) ---"
        timeout "$KUBECTL_TIMEOUT" aws-vault exec sky -- kubectl logs "$pod_name" -n "$NAMESPACE" --tail=10 2>/dev/null || echo "  (could not fetch logs)"
        echo "  ---"
      fi
    done
  fi
fi

# --- Check 3: Pod restart counts ---
echo "  Checking pod restarts..."
if [[ -n "$POD_OUTPUT" ]]; then
  HIGH_RESTARTS=""
  while IFS= read -r line; do
    pod_name=$(echo "$line" | awk '{print $1}')
    restarts=$(echo "$line" | awk '{print $4}')
    # Handle cases where restart count has extra info like "2 (3h ago)"
    restarts="${restarts%%[^0-9]*}"
    if [[ "$restarts" =~ ^[0-9]+$ ]] && [[ "$restarts" -gt 2 ]]; then
      HIGH_RESTARTS="${HIGH_RESTARTS}${pod_name}(${restarts} restarts) "
    fi
  done <<< "$POD_OUTPUT"

  if [[ -z "$HIGH_RESTARTS" ]]; then
    run_check "Pod restart counts" "PASS"
  else
    run_check "Pod restart counts" "FAIL" "High restarts: ${HIGH_RESTARTS}"
  fi
else
  run_check "Pod restart counts" "FAIL" "No pod data available"
fi

# --- Check 4: App pod ready ---
echo "  Checking app pod readiness..."
APP_OUTPUT=$(timeout "$KUBECTL_TIMEOUT" aws-vault exec sky -- kubectl get pods -n "$NAMESPACE" \
  -l "app.kubernetes.io/instance=keeperhub-pr-${PR_NUMBER}" \
  --no-headers 2>/dev/null) || APP_OUTPUT=""

if [[ -z "$APP_OUTPUT" ]]; then
  run_check "App pod ready" "FAIL" "No app pod found"
else
  app_ready=$(echo "$APP_OUTPUT" | head -1 | awk '{print $2}')
  if [[ "$app_ready" == "1/1" ]]; then
    run_check "App pod ready" "PASS"
  else
    run_check "App pod ready" "FAIL" "App pod readiness: ${app_ready}"
  fi
fi

# --- Check 5: DB accessible ---
echo "  Checking database connectivity..."
DB_POD_NAME="pr-test-dbcheck-${PR_NUMBER}-$$"
DB_CHECK=$(timeout 60 aws-vault exec sky -- kubectl run "$DB_POD_NAME" \
  --rm -i --restart=Never \
  -n "$NAMESPACE" \
  --image=postgres:16-alpine \
  -- psql "${PR_DB_URL}" -c "SELECT 1;" 2>&1) || true

# Clean up pod if it wasn't auto-removed
timeout "$KUBECTL_TIMEOUT" aws-vault exec sky -- kubectl delete pod "$DB_POD_NAME" -n "$NAMESPACE" --ignore-not-found &>/dev/null || true

if echo "$DB_CHECK" | grep -q "1 row"; then
  run_check "DB accessible" "PASS"
else
  run_check "DB accessible" "FAIL" "Could not connect to database"
fi

# --- Check 6: App URL responding ---
echo "  Checking app URL..."
CF_HEADERS=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  CF_HEADERS=(-H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}")
fi
HTTP_CODE=$(curl -sSf -o /dev/null -w "%{http_code}" --max-time 15 "${CF_HEADERS[@]}" "${PR_APP_URL}" 2>/dev/null) || HTTP_CODE="000"

if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "302" ]]; then
  run_check "App URL responding" "PASS"
else
  run_check "App URL responding" "FAIL" "HTTP ${HTTP_CODE} from ${PR_APP_URL}"
fi

# --- Check 7: Helm releases healthy ---
echo "  Checking Helm releases..."
if command -v helm &>/dev/null; then
  HELM_OUTPUT=$(timeout "$KUBECTL_TIMEOUT" aws-vault exec sky -- helm list -n "$NAMESPACE" --no-headers 2>/dev/null) || HELM_OUTPUT=""

  if [[ -z "$HELM_OUTPUT" ]]; then
    run_check "Helm releases healthy" "FAIL" "No Helm releases found"
  else
    BAD_RELEASES=""
    while IFS= read -r line; do
      release_name=$(echo "$line" | awk '{print $1}')
      if ! echo "$line" | grep -q "deployed"; then
        BAD_RELEASES="${BAD_RELEASES}${release_name} "
      fi
    done <<< "$HELM_OUTPUT"

    if [[ -z "$BAD_RELEASES" ]]; then
      run_check "Helm releases healthy" "PASS"
    else
      run_check "Helm releases healthy" "FAIL" "Unhealthy releases: ${BAD_RELEASES}"
    fi
  fi
else
  run_check "Helm releases healthy" "FAIL" "helm command not found"
fi

# --- Summary ---
echo ""
echo "============================================"
echo "  Preflight Results: PR #${PR_NUMBER}"
echo "============================================"
for result in "${RESULTS[@]}"; do
  echo "  ${result}"
done
echo "--------------------------------------------"
echo "  Total: ${TOTAL}  Passed: ${PASSED}  Failed: ${FAILED}"
echo "============================================"
echo ""

if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi

exit 0
