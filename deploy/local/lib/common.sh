#!/usr/bin/env bash
# Shared definitions for the local minikube stack.
#
# Sourced by deploy/local/setup-local.sh and deploy/local/deploy.sh. Every value
# that has to agree across the stack lives here exactly once, because the two
# things that historically drifted are both load-bearing:
#
#   1. The SQS queue URL is a cryptographic input. Producers sign
#      "sqs\n<queueUrl>\n<caller>\n<sha256(body)>\n<ts>" (lib/sqs-message-auth.ts)
#      and the executor verifies against its own SQS_QUEUE_URL. One byte of
#      difference between any producer and the consumer and every trigger is
#      rejected as bad_signature.
#   2. The cluster sizing used to be stated in three places with three different
#      numbers (setup-local.sh, deploy.sh, README).
#
# shellcheck disable=SC2034
# Most variables here are consumed by the scripts that source this file, not by
# this file itself, so shellcheck cannot see their use.

# A dedicated profile rather than the default "minikube" one. Two reasons, both
# practical: this stack needs a calico cluster and a CNI can only be chosen at
# creation, so sharing the default profile would mean destroying whatever else a
# developer keeps there; and every kubectl/helm call below pins --context to
# this name, so a local command can never wander onto a real cluster that
# happens to be the current context.
MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-keeperhub}"
NAMESPACE="local"
RELEASE="keeperhub"

# Cluster sizing. Measured pod requests for the full stack (control plane,
# calico, ingress-nginx, cert-manager, postgres, elasticmq, app, executor,
# schedule dispatcher, plus a transient runner Job) come to roughly 3.3Gi, and
# steady-state RSS under real use lands around 4.5-5.5Gi. 4GB cannot schedule
# the stack at all.
MIN_MEMORY_GB=8
MIN_CPU_CORES=4
MIN_DISK_GB=40
# Below this the stack cannot be scheduled, so setup aborts rather than
# producing a confusing --atomic rollback later.
FLOOR_MEMORY_GB=6

# NetworkPolicy is only enforced by a CNI that implements it. minikube's default
# accepts a NetworkPolicy object and silently enforces nothing, which would make
# any egress check pass while blocking nothing. The CNI is fixed at cluster
# creation, so changing this requires recreating the cluster.
CNI="calico"

CHART_REPO_NAME="techops-services"
CHART_REPO_URL="https://techops-services.github.io/helm-charts"
CHART_NAME="techops-services/keeperhub-stack"
CHART_VERSION="0.3.0"
VALUES_TEMPLATE="deploy/keeperhub-stack/local/values.yaml"
HELM_TIMEOUT="15m0s"

# Single local image repository, one tag prefix per component. Mirrors the
# staging/prod shape of "<repo>:<component>-<tag>" so the local values file has
# the same structure as deploy/keeperhub-stack/{staging,prod}/values.yaml.
IMAGE_REPO="keeperhub-local"

APP_HOST="workflow.keeperhub.local"

# --- Queue -------------------------------------------------------------------
# ElasticMQ, not LocalStack. It speaks the SQS API, needs no auth token, and
# declares its queues statically so readiness implies queue-ready.
SQS_HOST="elasticmq.${NAMESPACE}.svc.cluster.local"
SQS_PORT="9324"
SQS_STATS_PORT="9325"
AWS_ENDPOINT_URL="http://${SQS_HOST}:${SQS_PORT}"
AWS_REGION="us-east-1"
SQS_ACCOUNT_ID="000000000000"
SQS_QUEUE_NAME="keeperhub-workflow-queue"
# Read the module docstring at the top of this file before changing either URL.
SQS_QUEUE_URL="${AWS_ENDPOINT_URL}/${SQS_ACCOUNT_ID}/${SQS_QUEUE_NAME}"
SQS_DLQ_URL="${AWS_ENDPOINT_URL}/${SQS_ACCOUNT_ID}/${SQS_QUEUE_NAME}-dlq"

# --- Database ----------------------------------------------------------------
PG_RELEASE="postgresql"
PG_USER="local"
PG_PASSWORD="local"
PG_DATABASE="keeperhub"
PG_HOST="${PG_RELEASE}.${NAMESPACE}.svc.cluster.local"
# ensureExplicitSslMode (lib/db/connection-utils.ts) deliberately no-ops for
# *.svc.cluster.local, so no sslmode and no CA bundle are needed in-cluster.
DATABASE_URL_IN_CLUSTER="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:5432/${PG_DATABASE}"
# Host-side access goes through a port-forward. The host is literally
# "localhost" there, which is what lets scripts/backfill-drizzle-migrations.ts
# and scripts/seed/dev-bootstrap.ts run without ALLOW_REMOTE.
#
# 5434 rather than the more obvious 5433, because docker-compose already
# publishes its own postgres on 5433. Sharing that port is worse than it sounds:
# 'kubectl port-forward' simply fails to bind, and anything that then connects
# to localhost:5433 silently reaches the compose database instead of the cluster
# one. That is a wrong-database write, not an error, so the two are kept apart.
PG_LOCAL_PORT="5434"
DATABASE_URL_PORT_FORWARD="postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_LOCAL_PORT}/${PG_DATABASE}"

# Pinned third-party chart and image versions. Everything here used to float on
# "latest" or on no version at all, which makes a local failure unreproducible.
CERT_MANAGER_VERSION="v1.21.1"
# appVersion 17.6.0, matching POSTGRES_IMAGE_TAG below.
POSTGRES_CHART_VERSION="16.7.27"
POSTGRES_IMAGE_REPO="bitnamilegacy/postgresql"
POSTGRES_IMAGE_TAG="17.6.0-debian-12-r4"
ELASTICMQ_IMAGE="softwaremill/elasticmq-native:1.6.16"

# kubectl/helm always target the local cluster explicitly. A bare kubectl picks
# up whatever context is current, which on a machine that also has cluster
# access is how a local command reaches a real environment.
kube() {
    kubectl --context "$MINIKUBE_PROFILE" "$@"
}

kube_ns() {
    kubectl --context "$MINIKUBE_PROFILE" --namespace "$NAMESPACE" "$@"
}

# Image tag: content-addressed on a clean tree so a redeploy re-uses images
# already loaded into the node, unique on a dirty tree so an edited build is
# never mistaken for an older one. Never "latest": the chart cannot set
# imagePullPolicy on initContainers, so a :latest tag would make kubelet default
# to Always and fail on a side-loaded image.
resolve_image_tag() {
    local sha dirty
    sha=$(git rev-parse --short HEAD)
    dirty=""
    if [ -n "$(git status --porcelain)" ]; then
        dirty="-dirty-$(date +%s)"
    fi
    printf '%s%s' "$sha" "$dirty"
}

# Shared prerequisite and resource gates, previously duplicated (and divergent)
# between the two scripts.
require_tools() {
    local missing=0 tool
    for tool in "$@"; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            echo "  missing: $tool" >&2
            missing=1
        fi
    done
    if [ "$missing" -eq 1 ]; then
        echo "Install the missing tools and re-run." >&2
        exit 1
    fi
}

check_host_resources() {
    local total_mem_kb avail_mem_kb avail_mem_gb free_disk_gb

    if ! docker info >/dev/null 2>&1; then
        echo "Docker daemon is not running." >&2
        exit 1
    fi

    total_mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
    avail_mem_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
    avail_mem_gb=$((avail_mem_kb / 1024 / 1024))
    echo "  memory available: ${avail_mem_gb}GB (total $((total_mem_kb / 1024 / 1024))GB)"

    if [ "$avail_mem_gb" -lt "$FLOOR_MEMORY_GB" ]; then
        cat >&2 <<EOF

Only ${avail_mem_gb}GB of memory is available and the stack needs at least
${FLOOR_MEMORY_GB}GB (${MIN_MEMORY_GB}GB recommended). Free some memory and re-run.

Refusing to continue: an under-resourced cluster fails later as pods that never
schedule and a helm --atomic rollback, which is far harder to diagnose than this
message.
EOF
        exit 1
    fi

    free_disk_gb=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')
    echo "  disk free: ${free_disk_gb}GB"
    if [ "$free_disk_gb" -lt "$MIN_DISK_GB" ]; then
        echo "  warning: less than ${MIN_DISK_GB}GB free; five side-loaded images need room" >&2
    fi
}
