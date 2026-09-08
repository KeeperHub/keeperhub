#!/usr/bin/env bash
# Proves the bundled queue does not lose messages across a restart.
#
# TEST SCAFFOLDING. ElasticMQ has no clustering, so a restart is a brief outage
# no matter what; the only question is whether it is also DATA LOSS. Persistence
# is what makes the difference, and this is what measures it.
#
# What it does per iteration: send N messages, restart the pod, drain the queue,
# and check that every message came back. Repeated, because the failure mode
# being measured is not deterministic - H2 can fail to release its file lock on
# an unclean shutdown, and upstream reports that happening on roughly every other
# restart without a grace period and a preStop delay.
#
# Two things it deliberately does not do:
#   - It never calls PurgeQueue. ElasticMQ does not persist purges, so purged
#     messages reappear after a restart and the next iteration would count them.
#     Each iteration tags its messages instead, and deletes them when done.
#   - It does not go through the application. This measures the queue, not the
#     workflow path; a message that survives here but is never processed is a
#     different bug in a different component. The executor is scaled to zero for
#     the duration, because it is a competing consumer on the same queue: it
#     would receive these unsigned messages, reject them under SQS_HMAC_MODE
#     enforce, and route them to the dead-letter queue, which would read here as
#     data loss that never happened.
#
# Usage:
#   KUBE_CONTEXT=<context> ./queue-restart-test.sh [--iterations N] [--messages N]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/keeperhub-stack/self-hosted/config.sh
source "$SCRIPT_DIR/../config.sh"

ITERATIONS=10
MESSAGES=25
LOCAL_PORT="${LOCAL_PORT:-19324}"

while [ $# -gt 0 ]; do
    case $1 in
        --iterations) ITERATIONS="$2"; shift 2 ;;
        --messages) MESSAGES="$2"; shift 2 ;;
        --help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

section() { echo; echo "== $1"; }

require_tools kubectl python3
require_context

if [ "$QUEUE_MODE" != bundled ]; then
    echo "QUEUE_MODE is '$QUEUE_MODE'. This measures the bundled queue's persistence;" >&2
    echo "a queue you brought yourself has its own durability story." >&2
    exit 1
fi

# Discovered from the running release, not configured here.
#
# The queue's Service name, port, account id and queue name used to be settings
# in config.sh. They are not settings any more: under the bundled queue the chart
# computes every queue address from the release namespace, so a copy here would
# be a second source of truth that can only ever drift. Reading the deployed
# executor's own SQS_QUEUE_URL means this measures the queue that is actually
# running, which is also the only thing worth measuring.
discover_queue_url() {
    local url
    url=$(kube_ns get deploy "${RELEASE}-executor" -o \
        "jsonpath={.spec.template.spec.containers[0].env[?(@.name=='SQS_QUEUE_URL')].value}" 2>/dev/null || true)
    if [ -z "$url" ]; then
        cat >&2 <<EOF
Could not read SQS_QUEUE_URL from deployment '${RELEASE}-executor' in namespace '$NAMESPACE'.

This measures a queue that is already installed. Install first, then re-run:

    KUBE_CONTEXT=$KUBE_CONTEXT PROFILE=minikube IMAGE_TAG=<tag> ../install.sh

If the release or namespace differs, pass RELEASE and NAMESPACE to match it.
EOF
        exit 1
    fi
    printf '%s' "$url"
}

# http://<service>.<ns>.svc.cluster.local:<port>/<account>/<queue>
QUEUE_URL_IN_CLUSTER="$(discover_queue_url)"
QUEUE_HOSTPORT="${QUEUE_URL_IN_CLUSTER#http://}"
QUEUE_HOSTPORT="${QUEUE_HOSTPORT%%/*}"
QUEUE_NAME="${QUEUE_HOSTPORT%%.*}"
SQS_PORT="${QUEUE_HOSTPORT##*:}"
QUEUE_PATH="${QUEUE_URL_IN_CLUSTER#*://*/}"

if [ -z "$QUEUE_NAME" ] || [ -z "$SQS_PORT" ] || [ "$QUEUE_PATH" = "$QUEUE_URL_IN_CLUSTER" ]; then
    echo "Could not parse a queue address out of '$QUEUE_URL_IN_CLUSTER'." >&2
    exit 1
fi

# Reached through a port-forward, so the path is kept and only the host swapped.
QUEUE_ENDPOINT="http://127.0.0.1:$LOCAL_PORT"
QUEUE_ADDR="$QUEUE_ENDPOINT/$QUEUE_PATH"

# Reached through a port-forward rather than from inside the cluster, so that
# restarting the queue pod cannot also kill the client doing the measuring.
PF_PID=""
EXECUTOR_REPLICAS=""

stop_port_forward() {
    [ -n "$PF_PID" ] || return 0
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
    PF_PID=""
}

EXECUTOR_DEPLOY="${RELEASE}-executor"

cleanup() {
    stop_port_forward
    if [ -n "$EXECUTOR_REPLICAS" ]; then
        kube_ns scale deployment "$EXECUTOR_DEPLOY" --replicas="$EXECUTOR_REPLICAS" >/dev/null 2>&1 || true
        EXECUTOR_REPLICAS=""
    fi
}
trap cleanup EXIT

# Restored by the trap on every exit path, including an interrupt.
#
# Not optional, and not silently skippable. A running executor is a competing
# consumer on this queue: it receives these deliberately unsigned messages,
# rejects them under SQS_HMAC_MODE enforce and routes them to the dead-letter
# queue. The drain then finds nothing and the run reports total data loss that
# never happened. Refusing to start is the only safe response to not finding it,
# because the alternative is a confident wrong answer about durability.
stand_down_consumer() {
    EXECUTOR_REPLICAS=$(kube_ns get deployment "$EXECUTOR_DEPLOY" \
        -o jsonpath='{.spec.replicas}' 2>/dev/null || true)
    if [ -z "$EXECUTOR_REPLICAS" ]; then
        EXECUTOR_REPLICAS=""
        cat >&2 <<EOF
Deployment '$EXECUTOR_DEPLOY' not found in namespace '$NAMESPACE'.

This test cannot run without standing that consumer down: it would receive the
unsigned messages sent here, reject them, and route them to the dead-letter
queue, which reads as data loss that never happened.

If the release is named differently, pass RELEASE to match it.
EOF
        exit 1
    fi
    kube_ns scale deployment "$EXECUTOR_DEPLOY" --replicas=0 >/dev/null
    kube_ns wait --for=delete pod -l "app.kubernetes.io/serviceName=$EXECUTOR_DEPLOY" --timeout=120s >/dev/null 2>&1 || true
    echo "  consumer    $EXECUTOR_DEPLOY scaled 0 (restored to $EXECUTOR_REPLICAS afterwards)"
}

start_port_forward() {
    # kubectl directly, not through the kube_ns helper: backgrounding a shell
    # function makes $! the subshell's pid, and killing that orphans the kubectl
    # holding the local port. The next forward then fails to bind while the old
    # one keeps pointing at a pod that no longer exists, so every request comes
    # back "connection refused" long after the queue is healthy again.
    local err
    err="$(mktemp -t keeperhub-pf.XXXXXX.log)"
    kubectl --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" \
        port-forward "svc/$QUEUE_NAME" "$LOCAL_PORT:$SQS_PORT" >/dev/null 2>"$err" &
    PF_PID=$!
    local i=0
    # A real SQS call, not a TCP connect: kubectl binds the local port before the
    # tunnel is usable, so a connect check reports ready while requests still
    # fail.
    until python3 -c "
import sys, urllib.request
try:
    urllib.request.urlopen(urllib.request.Request(
        '$QUEUE_ADDR', data=b'Action=GetQueueAttributes&Version=2012-11-05'), timeout=3).read()
except Exception:
    sys.exit(1)
" 2>/dev/null; do
        # Checked before the timeout, because the readiness probe above cannot
        # tell OUR tunnel from someone else's on the same port. If the port is
        # already taken, kubectl exits immediately and an unrelated forward -
        # a stale one from an earlier run, pointed at a different namespace -
        # answers every request. The measurement then runs happily against the
        # wrong queue and reports total data loss that never happened. Cost an
        # hour once; the fix is to notice that our own kubectl is gone.
        if ! kill -0 "$PF_PID" 2>/dev/null; then
            echo "port-forward exited immediately. Local port $LOCAL_PORT is probably taken:" >&2
            sed 's/^/    /' "$err" >&2
            echo "    ss -ltnp | grep $LOCAL_PORT   # find what holds it" >&2
            echo "    LOCAL_PORT=<free port> $0     # or use another port" >&2
            rm -f "$err"
            exit 1
        fi
        i=$((i + 1))
        [ "$i" -lt 30 ] || { echo "port-forward did not come up" >&2; rm -f "$err"; exit 1; }
        sleep 1
    done
    rm -f "$err"
}

restart_port_forward() {
    stop_port_forward
    start_port_forward
}

# Absorbs one message, on purpose.
#
# A consumer that dies mid-long-poll leaves a receiver registered inside
# ElasticMQ, and the next message sent is handed to it and marked in-flight even
# though nothing is there to read it. It then sits invisible for the queue's
# 300s visibility timeout, and that state is persisted, so it survives every
# restart in this test. Measured: with the executor running beforehand, iteration
# 1 recovered 24 of 25 every single time, and the missing one was always
# accounted for as ApproximateNumberOfMessagesNotVisible.
#
# That is not data loss and not something the product suffers from - the message
# comes back when the timeout expires, which is exactly what a visibility timeout
# is for. It is only an artefact of standing the consumer down, so a throwaway
# message is fed to the stale receiver before any measuring starts.
flush_stale_receivers() {
    sqs send "$QUEUE_ENDPOINT" "$QUEUE_ADDR" "flush$$" 1 >/dev/null
    sqs drain "$QUEUE_ENDPOINT" "$QUEUE_ADDR" "flush$$" >/dev/null
}

# Send and drain live in python because the SQS query protocol answers in XML,
# and parsing that with sed is how a test starts lying about what it measured.
sqs() {
    python3 - "$@" <<'PY'
import sys, urllib.parse, urllib.request, xml.etree.ElementTree as ET

action, endpoint, queue, tag = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
NS = "{http://queue.amazonaws.com/doc/2012-11-05/}"


def call(**params):
    params["Version"] = "2012-11-05"
    data = urllib.parse.urlencode(params).encode()
    with urllib.request.urlopen(urllib.request.Request(queue, data=data), timeout=15) as r:
        return ET.fromstring(r.read())


if action == "send":
    count = int(sys.argv[5])
    for i in range(count):
        call(Action="SendMessage", MessageBody=f"{tag}-{i}")
    print(count)

elif action == "drain":
    # VisibilityTimeout is long enough that a message is not handed out twice
    # inside one drain, and every message is deleted once seen - DeleteMessage
    # IS persisted, so nothing carries into the next iteration.
    seen, empties = set(), 0
    while empties < 3:
        root = call(Action="ReceiveMessage", MaxNumberOfMessages="10", VisibilityTimeout="60")
        msgs = root.findall(f".//{NS}Message")
        if not msgs:
            empties += 1
            continue
        empties = 0
        for m in msgs:
            body = m.findtext(f"{NS}Body") or ""
            handle = m.findtext(f"{NS}ReceiptHandle") or ""
            if body.startswith(tag):
                seen.add(body)
            call(Action="DeleteMessage", ReceiptHandle=handle)
    print(len(seen))
PY
}

section "Queue restart durability"
echo "  queue       $QUEUE_NAME (namespace $NAMESPACE)"
echo "  iterations  $ITERATIONS x $MESSAGES messages"

stand_down_consumer
start_port_forward
flush_stale_receivers

failures=0
for iteration in $(seq 1 "$ITERATIONS"); do
    tag="run$$-iter$iteration"
    sqs send "$QUEUE_ENDPOINT" "$QUEUE_ADDR" "$tag" "$MESSAGES" >/dev/null

    kube_ns delete pod "$QUEUE_NAME-0" --wait=true >/dev/null
    kube_ns wait --for=condition=Ready "pod/$QUEUE_NAME-0" --timeout=180s >/dev/null

    # The forward dies with the pod it was pointing at.
    restart_port_forward

    recovered=$(sqs drain "$QUEUE_ENDPOINT" "$QUEUE_ADDR" "$tag")
    if [ "$recovered" -eq "$MESSAGES" ]; then
        echo "  iteration $iteration: $recovered/$MESSAGES recovered"
    else
        echo "  iteration $iteration: $recovered/$MESSAGES recovered - LOST $((MESSAGES - recovered))"
        failures=$((failures + 1))
        # An H2 lock failure shows up here rather than as a crash, so the log is
        # the only place that says which of the two it was.
        kube_ns logs "$QUEUE_NAME-0" --tail=20 | sed 's/^/      /'
    fi
done

section "Result"
if [ "$failures" -eq 0 ]; then
    echo "  $ITERATIONS/$ITERATIONS restarts kept every message"
else
    echo "  $failures/$ITERATIONS restarts lost messages" >&2
    exit 1
fi
