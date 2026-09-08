#!/usr/bin/env bash
# Execution-focused load test orchestrator.
#
# Creates users and workflows via curl (with cookie jars for auth),
# then continuously triggers manual/webhook workflows and polls
# execution status. Scales up each round until success rate drops.
#
# Usage: ./workflows-load-test.sh <base_url>
# Env vars:
#   TEST_API_KEY         Admin API key (required)
#   CF_ACCESS_CLIENT_ID  Cloudflare Access client ID (optional)
#   CF_ACCESS_CLIENT_SECRET  Cloudflare Access secret (optional)
#   USERS=20             Number of test users
#   WF_PER_ROUND=5       Workflows added per user per round
#   OBSERVE_WINDOW=60    Observation window in seconds
#   THRESHOLD=95         Execution success rate threshold (%)
#   MAX_ROUNDS=10        Maximum scaling rounds
set -euo pipefail

BASE_URL="${1:?Usage: $0 <base_url>}"
USERS="${USERS:-20}"
WF_PER_ROUND="${WF_PER_ROUND:-5}"
OBSERVE_WINDOW="${OBSERVE_WINDOW:-60}"
THRESHOLD="${THRESHOLD:-95}"
MAX_ROUNDS="${MAX_ROUNDS:-10}"
RESULTS_DIR="${RESULTS_DIR:-/tmp/k6-exec-load}"
PASSWORD="K6LoadTest!2024"

mkdir -p "$RESULTS_DIR"

# ─── Common curl args ────────────────────────────────────────────────

cf_headers() {
  local args=()
  if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
    args+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
  fi
  echo "${args[@]}"
}

api_call() {
  local method="$1" path="$2" cookie_jar="${3:-}" data="${4:-}"
  local url="${BASE_URL}${path}"
  local args=(-s -w "\n%{http_code}" -X "$method"
    -H "Content-Type: application/json"
    -H "Origin: $BASE_URL"
    -H "Referer: $BASE_URL/"
    -H "X-Test-API-Key: ${TEST_API_KEY:-}")
  if [ -n "${CF_ACCESS_CLIENT_ID:-}" ]; then
    args+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
  fi
  if [ -n "$cookie_jar" ]; then
    args+=(-b "$cookie_jar" -c "$cookie_jar")
  fi
  if [ -n "$data" ]; then
    args+=(-d "$data")
  fi
  curl "${args[@]}" "$url"
}

admin_call() {
  local method="$1" path="$2" data="${3:-}"
  local url="${BASE_URL}${path}"
  local args=(-s -w "\n%{http_code}" -X "$method"
    -H "Content-Type: application/json"
    -H "Origin: $BASE_URL"
    -H "Referer: $BASE_URL/"
    -H "Authorization: Bearer ${TEST_API_KEY:-}")
  if [ -n "${CF_ACCESS_CLIENT_ID:-}" ]; then
    args+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
  fi
  if [ -n "$data" ]; then
    args+=(-d "$data")
  fi
  curl "${args[@]}" "$url"
}

# Parse HTTP response: body on stdout, status code on fd 3
parse_response() {
  local response="$1"
  local status
  status=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')
  echo "$body"
  return "$((status == 200 ? 0 : 1))" 2>/dev/null || true
}

echo "========================================="
echo "Execution-Focused Load Test"
echo "  Target:           $BASE_URL"
echo "  Users:            $USERS"
echo "  Workflows/round:  $WF_PER_ROUND per user"
echo "  Observe window:   ${OBSERVE_WINDOW}s"
echo "  Threshold:        ${THRESHOLD}% execution success"
echo "  Max rounds:       $MAX_ROUNDS"
echo "========================================="
echo ""

# ─── Phase 1: Create users with retries ──────────────────────────────

echo "Phase 1: Creating $USERS test users..."
echo '[]' > "$RESULTS_DIR/users.json"

create_user() {
  local i="$1"
  local ts
  ts=$(date +%s%3N)
  local email="k6-vu${i}-${ts}@techops.services"
  local name="k6-user-${i}"
  local jar="$RESULTS_DIR/cookies-user-${i}.txt"

  # Signup with retries
  local max_retries=5
  for attempt in $(seq 1 $max_retries); do
    local res
    res=$(api_call POST "/api/auth/sign-up/email" "$jar" \
      "{\"email\":\"$email\",\"password\":\"$PASSWORD\",\"name\":\"$name\"}")
    local status
    status=$(echo "$res" | tail -1)

    if [ "$status" = "200" ]; then
      break
    elif [ "$status" = "429" ]; then
      local wait=$((attempt * 5))
      echo "    User $i: rate limited on signup, waiting ${wait}s (attempt $attempt/$max_retries)"
      sleep "$wait"
    else
      echo "    User $i: signup failed with $status"
      return 1
    fi

    if [ "$attempt" -eq "$max_retries" ]; then
      echo "    User $i: signup failed after $max_retries retries"
      return 1
    fi
  done

  # Get OTP with retries
  local otp=""
  for attempt in $(seq 1 10); do
    local otp_res
    otp_res=$(admin_call GET "/api/admin/test/otp?email=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$email'))")")
    local otp_status
    otp_status=$(echo "$otp_res" | tail -1)
    local otp_body
    otp_body=$(echo "$otp_res" | sed '$d')

    if [ "$otp_status" = "200" ]; then
      otp=$(echo "$otp_body" | python3 -c "import sys,json; print(json.load(sys.stdin)['otp'])")
      break
    fi
    sleep 1
  done

  if [ -z "$otp" ]; then
    echo "    User $i: OTP retrieval failed"
    return 1
  fi

  # Verify with retries
  for attempt in $(seq 1 $max_retries); do
    local verify_res
    verify_res=$(api_call POST "/api/auth/email-otp/verify-email" "$jar" \
      "{\"email\":\"$email\",\"otp\":\"$otp\"}")
    local verify_status
    verify_status=$(echo "$verify_res" | tail -1)

    if [ "$verify_status" = "200" ]; then
      break
    elif [ "$verify_status" = "429" ]; then
      local wait=$((attempt * 5))
      echo "    User $i: rate limited on verify, waiting ${wait}s (attempt $attempt/$max_retries)"
      sleep "$wait"
    else
      echo "    User $i: verify failed with $verify_status"
      return 1
    fi

    if [ "$attempt" -eq "$max_retries" ]; then
      echo "    User $i: verify failed after $max_retries retries"
      return 1
    fi
  done

  # Sign in
  for attempt in $(seq 1 $max_retries); do
    local signin_res
    signin_res=$(api_call POST "/api/auth/sign-in/email" "$jar" \
      "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}")
    local signin_status
    signin_status=$(echo "$signin_res" | tail -1)

    if [ "$signin_status" = "200" ]; then
      break
    elif [ "$signin_status" = "429" ]; then
      local wait=$((attempt * 5))
      echo "    User $i: rate limited on signin, waiting ${wait}s"
      sleep "$wait"
    else
      echo "    User $i: signin failed with $signin_status"
      return 1
    fi

    if [ "$attempt" -eq "$max_retries" ]; then
      echo "    User $i: signin failed after retries"
      return 1
    fi
  done

  # Create API key
  local apikey=""
  local ak_res
  ak_res=$(api_call POST "/api/api-keys" "$jar" "{\"name\":\"k6-test-vu${i}\"}")
  local ak_status
  ak_status=$(echo "$ak_res" | tail -1)
  if [ "$ak_status" = "200" ]; then
    local ak_body
    ak_body=$(echo "$ak_res" | sed '$d')
    apikey=$(echo "$ak_body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',''))" 2>/dev/null || echo "")
  fi

  # Save user
  python3 -c "
import json
with open('$RESULTS_DIR/users.json') as f:
    users = json.load(f)
users.append({
    'index': $i,
    'email': '$email',
    'cookieJar': '$jar',
    'apiKey': '$apikey',
    'workflows': []
})
with open('$RESULTS_DIR/users.json', 'w') as f:
    json.dump(users, f, indent=2)
"
  echo "  User $i: $email"
  return 0
}

for i in $(seq 1 "$USERS"); do
  create_user "$i" || echo "  User $i: FAILED (skipping)"
done

active_users=$(python3 -c "import json; print(len(json.load(open('$RESULTS_DIR/users.json'))))")
echo ""
echo "Created $active_users / $USERS users."

if [ "$active_users" -eq 0 ]; then
  echo "No users created. Aborting."
  exit 1
fi

if [ "$active_users" -lt "$USERS" ]; then
  echo "WARNING: Not all users created. Continuing with $active_users."
fi
echo ""

# ─── Workflow creation helper ─────────────────────────────────────────

create_workflows_for_round() {
  local round="$1"

  python3 << PYEOF
import json, subprocess, sys

base_url = "$BASE_URL"
results_dir = "$RESULTS_DIR"
wf_per_round = $WF_PER_ROUND
round_num = $round
test_api_key = "${TEST_API_KEY:-}"
cf_id = "${CF_ACCESS_CLIENT_ID:-}"
cf_secret = "${CF_ACCESS_CLIENT_SECRET:-}"

with open(f"{results_dir}/users.json") as f:
    users = json.load(f)

def http_action(aid, label, x, y):
    return {"id": aid, "type": "action", "position": {"x": x, "y": y},
            "data": {"type": "action", "label": label, "config": {
                "actionType": "HTTP Request", "endpoint": f"{base_url}/api/health",
                "httpMethod": "GET", "httpHeaders": "{}", "httpBody": "{}"}}}

def cond(cid, label, x, y):
    return {"id": cid, "type": "action", "position": {"x": x, "y": y},
            "data": {"type": "action", "label": label, "config": {
                "actionType": "Condition", "condition": "1 === 1"}}}

def trigger(ttype, extra=None):
    config = {"triggerType": ttype}
    if extra: config.update(extra)
    return {"id": "trigger-1", "type": "trigger", "position": {"x": 100, "y": 100},
            "data": {"type": "trigger", "label": f"{ttype} Trigger", "config": config}}

patterns = [
    lambda: (trigger("Manual"), [http_action("a1","Act",300,100)],
             [{"id":"e1","source":"trigger-1","target":"a1","type":"default"}], "Manual"),
    lambda: (trigger("Manual"), [cond("c1","Check",300,100), http_action("a1","Act",500,100)],
             [{"id":"e1","source":"trigger-1","target":"c1","type":"default"},
              {"id":"e2","source":"c1","target":"a1","type":"default"}], "Manual"),
    lambda: (trigger("Schedule",{"scheduleCron":"* * * * *","scheduleTimezone":"UTC"}),
             [http_action("a1","Read",300,100), cond("c1","Check",500,100), http_action("a2","Notify",700,100)],
             [{"id":"e1","source":"trigger-1","target":"a1","type":"default"},
              {"id":"e2","source":"a1","target":"c1","type":"default"},
              {"id":"e3","source":"c1","target":"a2","type":"default"}], "Schedule"),
    lambda: (trigger("Webhook"), [http_action("a1","Process",300,100)],
             [{"id":"e1","source":"trigger-1","target":"a1","type":"default"}], "Webhook"),
    lambda: (trigger("Schedule",{"scheduleCron":"* * * * *","scheduleTimezone":"UTC"}),
             [http_action("a1","R1",300,50), http_action("a2","R2",300,200),
              cond("c1","C1",500,50), cond("c2","C2",500,200),
              http_action("a3","N1",700,50), http_action("a4","N2",700,200)],
             [{"id":"e1","source":"trigger-1","target":"a1","type":"default"},
              {"id":"e2","source":"trigger-1","target":"a2","type":"default"},
              {"id":"e3","source":"a1","target":"c1","type":"default"},
              {"id":"e4","source":"a2","target":"c2","type":"default"},
              {"id":"e5","source":"c1","target":"a3","type":"default"},
              {"id":"e6","source":"c2","target":"a4","type":"default"}], "Schedule"),
    lambda: (trigger("Manual"), [http_action("a1","Read",300,100), cond("c1","Check",500,100),
              http_action("a2","Yes",700,50), http_action("a3","No",700,200)],
             [{"id":"e1","source":"trigger-1","target":"a1","type":"default"},
              {"id":"e2","source":"a1","target":"c1","type":"default"},
              {"id":"e3","source":"c1","target":"a2","type":"default"},
              {"id":"e4","source":"c1","target":"a3","type":"default"}], "Manual"),
    lambda: (trigger("Manual"), [http_action("a1","S1",300,50), http_action("a2","S2",300,150),
              http_action("a3","S3",300,250), cond("c1","Agg",500,150)],
             [{"id":"e1","source":"trigger-1","target":"a1","type":"default"},
              {"id":"e2","source":"trigger-1","target":"a2","type":"default"},
              {"id":"e3","source":"trigger-1","target":"a3","type":"default"},
              {"id":"e4","source":"a1","target":"c1","type":"default"},
              {"id":"e5","source":"a2","target":"c1","type":"default"},
              {"id":"e6","source":"a3","target":"c1","type":"default"}], "Manual"),
    lambda: (trigger("Schedule",{"scheduleCron":"* * * * *","scheduleTimezone":"UTC"}),
             [cond("c1","Check",300,100), http_action("a1","Act",500,100)],
             [{"id":"e1","source":"trigger-1","target":"c1","type":"default"},
              {"id":"e2","source":"c1","target":"a1","type":"default"}], "Schedule"),
    lambda: (trigger("Manual"), [http_action("a1","S1",300,100), http_action("a2","S2",500,100),
              http_action("a3","S3",700,100)],
             [{"id":"e1","source":"trigger-1","target":"a1","type":"default"},
              {"id":"e2","source":"a1","target":"a2","type":"default"},
              {"id":"e3","source":"a2","target":"a3","type":"default"}], "Manual"),
    lambda: (trigger("Webhook"), [cond("c1","Filter",300,100), http_action("a1","Act",500,100)],
             [{"id":"e1","source":"trigger-1","target":"c1","type":"default"},
              {"id":"e2","source":"c1","target":"a1","type":"default"}], "Webhook"),
]

def curl_api(method, path, cookie_jar, data=None):
    cmd = ["curl", "-s", "-w", "\\n%{http_code}", "-X", method, f"{base_url}{path}",
           "-H", "Content-Type: application/json",
           "-H", f"Origin: {base_url}", "-H", f"Referer: {base_url}/",
           "-H", f"X-Test-API-Key: {test_api_key}"]
    if cf_id: cmd += ["-H", f"CF-Access-Client-Id: {cf_id}", "-H", f"CF-Access-Client-Secret: {cf_secret}"]
    if cookie_jar: cmd += ["-b", cookie_jar, "-c", cookie_jar]
    if data: cmd += ["-d", data]
    r = subprocess.run(cmd, capture_output=True, text=True)
    lines = r.stdout.strip().split("\\n")
    return "\\n".join(lines[:-1]), lines[-1] if lines else "0"

for user in users:
    created = 0
    for wi in range(wf_per_round):
        pi = (len(user["workflows"]) + wi) % len(patterns)
        t, actions, edges, ttype = patterns[pi]()
        nodes = [t] + actions
        name = f"k6-p{pi}-r{round_num}-w{wi}-vu{user['index']}"
        payload = json.dumps({"name": name, "description": f"Load test r{round_num}", "nodes": nodes, "edges": edges})

        body, status = curl_api("POST", "/api/workflows/create", user["cookieJar"], payload)
        if status != "200":
            print(f"  User {user['index']} wf {wi}: create failed ({status})")
            continue

        wf = json.loads(body)
        wf_id = wf.get("id", "")

        # Enable (go-live)
        curl_api("PUT", f"/api/workflows/{wf_id}/go-live", user["cookieJar"],
                 json.dumps({"name": name}))

        user["workflows"].append({"id": wf_id, "name": name, "triggerType": ttype, "pattern": pi})
        created += 1

    print(f"  User {user['index']}: {created} workflows (total: {len(user['workflows'])})")

with open(f"{results_dir}/users.json", "w") as f:
    json.dump(users, f, indent=2)
PYEOF
}

# ─── Execution trigger + poll helper ──────────────────────────────────

trigger_and_poll() {
  local wf_id="$1" cookie_jar="$2" trigger_type="$3" api_key="${4:-}"

  local res status body
  if [ "$trigger_type" = "Webhook" ] && [ -n "$api_key" ]; then
    # Build webhook curl manually to add Authorization header
    local args=(-s -w "\n%{http_code}" -X POST "${BASE_URL}/api/workflows/${wf_id}/webhook"
      -H "Content-Type: application/json"
      -H "Origin: $BASE_URL" -H "Referer: $BASE_URL/"
      -H "Authorization: Bearer $api_key")
    if [ -n "${CF_ACCESS_CLIENT_ID:-}" ]; then
      args+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
    fi
    args+=(-d '{"test":true}')
    res=$(curl "${args[@]}")
  else
    res=$(api_call POST "/api/workflow/${wf_id}/execute" "$cookie_jar" '{}')
  fi

  status=$(echo "$res" | tail -1)
  body=$(echo "$res" | sed '$d')

  if [ "$status" != "200" ] && [ "$status" != "201" ]; then
    echo "trigger_fail"
    return
  fi

  local exec_id
  exec_id=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('executionId',''))" 2>/dev/null || echo "")

  if [ -z "$exec_id" ]; then
    # Webhook may not return executionId
    echo "triggered_no_id"
    return
  fi

  # Poll for completion (max 30s)
  for _ in $(seq 1 15); do
    sleep 2
    local poll_res
    poll_res=$(api_call GET "/api/workflows/executions/${exec_id}/status" "$cookie_jar")
    local poll_status
    poll_status=$(echo "$poll_res" | tail -1)
    if [ "$poll_status" != "200" ]; then
      continue
    fi
    local poll_body
    poll_body=$(echo "$poll_res" | sed '$d')
    local exec_status
    exec_status=$(echo "$poll_body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "unknown")

    if [ "$exec_status" = "success" ]; then
      echo "success"
      return
    elif [ "$exec_status" = "error" ] || [ "$exec_status" = "cancelled" ]; then
      echo "error"
      return
    fi
  done
  echo "timeout"
}

# ─── Phase 2+: Scaling rounds ────────────────────────────────────────

echo '[]' > "$RESULTS_DIR/rounds.json"
total_wf_per_user=0

for round in $(seq 1 "$MAX_ROUNDS"); do
  echo "========================================="
  echo "Round $round: Adding $WF_PER_ROUND workflows per user"
  echo "========================================="

  create_workflows_for_round "$round"

  total_wf_per_user=$((total_wf_per_user + WF_PER_ROUND))
  total_workflows=$(python3 -c "
import json
users = json.load(open('$RESULTS_DIR/users.json'))
print(sum(len(u['workflows']) for u in users))
")
  echo ""
  echo "Total active workflows: $total_workflows ($active_users users x ~$total_wf_per_user each)"
  echo ""

  # ─── Observation: trigger manual/webhook workflows, poll results ──

  echo "Observing for ${OBSERVE_WINDOW}s — triggering and polling workflows..."

  local_success=0
  local_error=0
  local_timeout=0
  local_trigger_fail=0
  obs_start=$(date +%s)

  while true; do
    now=$(date +%s)
    elapsed=$((now - obs_start))
    if [ "$elapsed" -ge "$OBSERVE_WINDOW" ]; then
      break
    fi

    # Pick a random user and a random manual/webhook workflow to trigger
    python3 -c "
import json, random
users = json.load(open('$RESULTS_DIR/users.json'))
user = random.choice(users)
# Only trigger Manual and Webhook workflows (Schedule ones run via scheduler)
triggerable = [w for w in user['workflows'] if w['triggerType'] in ('Manual', 'Webhook')]
if not triggerable:
    print('SKIP')
else:
    wf = random.choice(triggerable)
    print(f\"{user['index']}|{wf['id']}|{wf['triggerType']}|{user.get('apiKey','')}\")
" > /tmp/k6-pick.txt

    pick=$(cat /tmp/k6-pick.txt)
    if [ "$pick" = "SKIP" ]; then
      sleep 1
      continue
    fi

    user_idx=$(echo "$pick" | cut -d'|' -f1)
    wf_id=$(echo "$pick" | cut -d'|' -f2)
    trigger_type=$(echo "$pick" | cut -d'|' -f3)
    api_key=$(echo "$pick" | cut -d'|' -f4)
    jar="$RESULTS_DIR/cookies-user-${user_idx}.txt"

    result=$(trigger_and_poll "$wf_id" "$jar" "$trigger_type" "$api_key")

    case "$result" in
      success) local_success=$((local_success + 1)) ;;
      error) local_error=$((local_error + 1)) ;;
      timeout) local_timeout=$((local_timeout + 1)) ;;
      trigger_fail) local_trigger_fail=$((local_trigger_fail + 1)) ;;
      triggered_no_id) local_success=$((local_success + 1)) ;;
    esac

    # remaining time calculated inline below
    total_triggered=$((local_success + local_error + local_timeout + local_trigger_fail))
    if [ $((total_triggered % 10)) -eq 0 ] && [ "$total_triggered" -gt 0 ]; then
      echo "  [${elapsed}s/${OBSERVE_WINDOW}s] triggered: $total_triggered | success: $local_success | error: $local_error | timeout: $local_timeout | fail: $local_trigger_fail"
    fi
  done

  total_triggered=$((local_success + local_error + local_timeout + local_trigger_fail))
  success_rate=0
  if [ "$total_triggered" -gt 0 ]; then
    success_rate=$(python3 -c "print(round(100.0 * $local_success / $total_triggered, 2))")
  fi
  throughput=$(python3 -c "print(round($total_triggered / ($OBSERVE_WINDOW / 60.0), 1))")

  round_json="{\"round\":$round,\"total_workflows\":$total_workflows,\"workflows_per_user\":$total_wf_per_user,\"total_triggered\":$total_triggered,\"success\":$local_success,\"errors\":$local_error,\"timeouts\":$local_timeout,\"trigger_failures\":$local_trigger_fail,\"success_rate\":$success_rate,\"throughput_per_min\":$throughput}"

  python3 -c "
import json
with open('$RESULTS_DIR/rounds.json') as f:
    rounds = json.load(f)
rounds.append(json.loads('$round_json'))
with open('$RESULTS_DIR/rounds.json', 'w') as f:
    json.dump(rounds, f, indent=2)
"

  echo ""
  echo "Round $round: $total_workflows workflows | $total_triggered triggered | $local_success success | $local_error error | $local_timeout timeout | ${success_rate}%"

  breached=$(python3 -c "print('yes' if $success_rate < $THRESHOLD else 'no')")
  if [ "$breached" = "yes" ]; then
    echo ""
    echo "========================================="
    echo "THRESHOLD BREACHED in round $round"
    echo "  Success rate: ${success_rate}% < ${THRESHOLD}%"
    echo "  Active workflows: $total_workflows"
    echo "========================================="
    break
  else
    echo "  PASS (${success_rate}% >= ${THRESHOLD}%)"
  fi
done

# ─── Report ───────────────────────────────────────────────────────────

echo ""
echo "========================================="
echo "FINAL REPORT"
echo "========================================="
python3 << REPORT
import json

with open("$RESULTS_DIR/rounds.json") as f:
    rounds = json.load(f)

if not rounds:
    print("No rounds completed.")
else:
    print(f"{'Round':<6} {'Workflows':<10} {'Triggered':<10} {'Success':<8} {'Error':<6} {'Timeout':<8} {'Rate':<8} {'Throughput':<12} {'Status'}")
    print("-" * 85)
    for r in rounds:
        status = "PASS" if r["success_rate"] >= $THRESHOLD else "FAIL"
        print(f"{r['round']:<6} {r['total_workflows']:<10} {r['total_triggered']:<10} {r['success']:<8} {r['errors']:<6} {r['timeouts']:<8} {r['success_rate']:<7}% {r['throughput_per_min']:<11}/min {status}")

    last_good = None
    for r in rounds:
        if r["success_rate"] >= $THRESHOLD:
            last_good = r
    if last_good:
        print(f"\nCAPACITY: {last_good['total_workflows']} active workflows at {last_good['success_rate']}% success, {last_good['throughput_per_min']}/min")
    else:
        print(f"\nFirst round already below threshold.")
REPORT
echo "========================================="

# ─── Cleanup ──────────────────────────────────────────────────────────

echo ""
echo "Cleaning up test users..."
cleanup_res=$(admin_call POST "/api/admin/test/cleanup" | sed '$d')
echo "Cleanup: $cleanup_res"

echo ""
echo "Results: $RESULTS_DIR/rounds.json"
cat "$RESULTS_DIR/rounds.json"
