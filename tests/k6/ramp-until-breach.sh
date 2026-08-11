#!/usr/bin/env bash
# Ramps k6 load test from 1 VU, increasing by STEP every STEP_DURATION,
# until success rate drops below THRESHOLD or MAX_VUS is reached.
#
# Usage: ./ramp-until-breach.sh <base_url> [threshold%] [step_size] [step_duration] [max_vus]
# Env: TEST_API_KEY, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET,
#      LOAD_TEST_BYPASS_TOKEN, LOAD_TEST_USER_PASSWORD
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${1:?Usage: $0 <base_url> [threshold%] [step_size] [step_duration] [max_vus]}"
THRESHOLD="${2:-99}"
STEP="${3:-5}"
STEP_DURATION="${4:-30s}"
MAX_VUS="${5:-500}"
RESULTS_DIR="${RESULTS_DIR:-/tmp/k6-results}"

mkdir -p "$RESULTS_DIR"
echo '[]' > "$RESULTS_DIR/all-tiers.json"

current_vus=1
step_number=0
breached=false

echo "========================================="
echo "k6 Ramp-Until-Breach Load Test"
echo "  Target:    $BASE_URL"
echo "  Threshold: ${THRESHOLD}% success rate"
echo "  Step size: +${STEP} VUs"
echo "  Duration:  ${STEP_DURATION} per step"
echo "  Max VUs:   ${MAX_VUS}"
echo "========================================="
echo ""

while [ "$current_vus" -le "$MAX_VUS" ]; do
  step_number=$((step_number + 1))
  echo "========================================="
  echo "Step ${step_number}: ${current_vus} VUs (threshold: ${THRESHOLD}%)"
  echo "========================================="

  summary_file="$RESULTS_DIR/step-${step_number}-vus-${current_vus}.json"
  output_file="$RESULTS_DIR/step-${step_number}-vus-${current_vus}-output.txt"

  tier_exit=0
  k6 run "$SCRIPT_DIR/load-test.js" \
    --vus "$current_vus" \
    --duration "$STEP_DURATION" \
    --summary-export "$summary_file" \
    -e BASE_URL="$BASE_URL" \
    -e TEST_API_KEY="${TEST_API_KEY:-}" \
    -e CF_ACCESS_CLIENT_ID="${CF_ACCESS_CLIENT_ID:-}" \
    -e CF_ACCESS_CLIENT_SECRET="${CF_ACCESS_CLIENT_SECRET:-}" \
    -e LOAD_TEST_BYPASS_TOKEN="${LOAD_TEST_BYPASS_TOKEN:-}" \
    -e LOAD_TEST_USER_PASSWORD="${LOAD_TEST_USER_PASSWORD:-}" \
    -e K6_SCENARIO=ci \
    --no-usage-report \
    2>&1 | tee "$output_file" || tier_exit=$?

  # Parse metrics from k6 summary export
  if [ -f "$summary_file" ]; then
    tier_json=$(python3 -c "
import json, sys, re

with open('$summary_file') as f:
    data = json.load(f)

metrics = data.get('metrics', {})

dur = metrics.get('http_req_duration', {})
p95 = dur.get('p(95)', 0)
p99 = dur.get('p(99)', 0)
avg = dur.get('avg', 0)
med = dur.get('med', 0)

failed = metrics.get('http_req_failed', {})
fail_rate = failed.get('value', 0)

reqs = metrics.get('http_reqs', {})
total_reqs = int(reqs.get('count', 0))
rps = reqs.get('rate', 0)

checks = metrics.get('checks', {})
check_passes = int(checks.get('passes', 0))
check_fails = int(checks.get('fails', 0))

rg = data.get('root_group', {}).get('checks', {})
if rg and check_passes == 0:
    check_passes = sum(c.get('passes', 0) for c in rg.values())
    check_fails = sum(c.get('fails', 0) for c in rg.values())

success_rate = (1 - fail_rate) * 100

issues = []
with open('$output_file') as f:
    output = f.read()

error_patterns = [
    (r'status (\d{3})', 'HTTP errors'),
    (r'connection refused', 'Connection refused'),
    (r'context deadline exceeded', 'Timeout'),
    (r'i/o timeout', 'I/O timeout'),
    (r'no such host', 'DNS resolution failed'),
]

status_codes = {}
for line in output.split('\n'):
    for pattern, label in error_patterns:
        matches = re.findall(pattern, line, re.IGNORECASE)
        for m in matches:
            if pattern == r'status (\d{3})':
                code = int(m)
                if code >= 400:
                    status_codes[code] = status_codes.get(code, 0) + 1
            elif label not in issues:
                issues.append(label)

for code, count in sorted(status_codes.items()):
    issues.append(f'HTTP {code} ({count}x)')

failed_checks = re.findall(r'(.+?)\.+:\s+\d+\.\d+%\s+.*\u2717\s+(\d+)', output)
for check_name, fail_count in failed_checks:
    check_name = check_name.strip()
    if int(fail_count) > 0:
        issues.append(f'{check_name} failed ({fail_count}x)')

result = {
    'step': $step_number,
    'vus': $current_vus,
    'exit_code': $tier_exit,
    'total_requests': total_reqs,
    'rps': round(rps, 1),
    'success_rate': round(success_rate, 2),
    'p95_ms': round(p95, 1),
    'p99_ms': round(p99, 1),
    'avg_ms': round(avg, 1),
    'median_ms': round(med, 1),
    'checks_passed': check_passes,
    'checks_failed': check_fails,
    'issues': issues if issues else ['None']
}

print(json.dumps(result))
")
  else
    tier_json="{\"step\":$step_number,\"vus\":$current_vus,\"exit_code\":$tier_exit,\"total_requests\":0,\"rps\":0,\"success_rate\":0,\"p95_ms\":0,\"p99_ms\":0,\"avg_ms\":0,\"median_ms\":0,\"checks_passed\":0,\"checks_failed\":0,\"issues\":[\"k6 failed to produce summary\"]}"
  fi

  # Append to results array
  python3 -c "
import json
with open('$RESULTS_DIR/all-tiers.json') as f:
    arr = json.load(f)
arr.append(json.loads('''$tier_json'''))
with open('$RESULTS_DIR/all-tiers.json', 'w') as f:
    json.dump(arr, f, indent=2)
"

  # Extract success rate and check threshold
  success_rate=$(python3 -c "import json; print(json.loads('''$tier_json''')['success_rate'])")
  echo ""
  echo "Step ${step_number} result: ${current_vus} VUs | success: ${success_rate}% | threshold: ${THRESHOLD}%"
  echo ""

  # Check if we breached the threshold
  breached_check=$(python3 -c "print('yes' if $success_rate < $THRESHOLD else 'no')")
  if [ "$breached_check" = "yes" ]; then
    echo "========================================="
    echo "THRESHOLD BREACHED at ${current_vus} VUs"
    echo "  Success rate: ${success_rate}% < ${THRESHOLD}%"
    echo "========================================="
    breached=true
    break
  fi

  # Increment VUs
  current_vus=$((current_vus + STEP))
done

echo ""
echo "========================================="
if [ "$breached" = "true" ]; then
  echo "Test stopped: threshold breached at step ${step_number} (${current_vus} VUs)"
else
  echo "Test completed: all steps passed up to ${MAX_VUS} VUs"
fi
echo "Results: $RESULTS_DIR/all-tiers.json"
echo "========================================="

cat "$RESULTS_DIR/all-tiers.json"
