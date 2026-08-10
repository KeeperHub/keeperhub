#!/usr/bin/env bash
# Configuration for a self-hosted KeeperHub install.
#
# Sourced by install.sh and by the scripts under test-harness/. Everything that
# has to agree across the install lives here exactly once, because the value
# most likely to drift is also the one that fails least obviously:
#
#   The SQS queue URL is a cryptographic input. Producers sign
#   "sqs\n<queueUrl>\n<caller>\n<sha256(body)>\n<ts>" (lib/sqs-message-auth.ts)
#   and the executor verifies against its own SQS_QUEUE_URL. One byte of
#   difference between any producer and the consumer rejects every trigger as
#   bad_signature, visible only as a warn line while all pods stay green.
#
# Override any of these in the environment before running install.sh.
#
# shellcheck disable=SC2034
# Most variables here are consumed by the scripts that source this file.

# The cluster and namespace to install into. KUBE_CONTEXT is required rather
# than defaulted, because a bare kubectl follows whatever context happens to be
# current, and on a machine with production access that is how an install lands
# somewhere it should not.
KUBE_CONTEXT="${KUBE_CONTEXT:-}"
NAMESPACE="${NAMESPACE:-keeperhub}"
RELEASE="${RELEASE:-keeperhub}"

CHART_REPO_NAME="techops-services"
CHART_REPO_URL="https://techops-services.github.io/helm-charts"
CHART_NAME="techops-services/keeperhub-stack"
CHART_VERSION="${CHART_VERSION:-0.4.0}"
# Point at a working-tree chart instead of the published one, for developing
# chart changes alongside this profile: CHART_DIR=../../../helm-charts/charts/keeperhub-stack
CHART_DIR="${CHART_DIR:-}"
HELM_TIMEOUT="${HELM_TIMEOUT:-15m0s}"

# Where the images come from. Defaults suit the test harness, which builds them
# locally and side-loads them; a real install points these at a registry.
IMAGE_REPO="${IMAGE_REPO:-keeperhub-local}"
IMAGE_TAG="${IMAGE_TAG:-}"
IMAGE_PULL_POLICY="${IMAGE_PULL_POLICY:-Never}"

# The hostname the app is served on.
#
# Deliberately inside *.keeperhub.com. lib/trusted-origins.ts hardcodes the
# trusted-origin list to http://localhost:*, http://127.0.0.1:* and
# https://*.keeperhub.com, with no environment variable to extend it. That list
# backs the CSRF guard in proxy.ts and better-auth, so on any other hostname
# every cookie-authenticated POST/PATCH/PUT/DELETE is rejected. The UI still
# loads and reads fine, so it looks like the app works until you try to save:
# enabling a workflow returns "Failed to update workflow state" and the only
# trace is "[csrf] blocked: untrusted origin" in the app log.
#
# A real client cannot do this - they do not own keeperhub.com. Making the
# trusted origins configurable is a prerequisite for any client domain.
#
# Not "local.keeperhub.com": that name belongs to deploy/local, and nginx-ingress
# rejects a second Ingress claiming the same host and path with an admission
# error. The two profiles are meant to be able to share a cluster.
APP_HOST="${APP_HOST:-selfhosted.keeperhub.com}"
INGRESS_CLASS="${INGRESS_CLASS:-nginx}"
TLS_ISSUER="${TLS_ISSUER:-mkcert-ca-issuer}"

# Cloudflare's documented always-pass Turnstile test keys, the same pair the
# PR-environment values use. Dummy values, not credentials.
#
# The two are NOT delivered the same way, and getting that wrong yields a signup
# form that renders and then fails:
#
#   TURNSTILE_SECRET_KEY is read at runtime, so the values file supplies it.
#     Without it lib/auth.ts throws at module load and every route importing the
#     auth module returns 500.
#   NEXT_PUBLIC_TURNSTILE_SITE_KEY is read by a client component
#     (components/auth/connect-auth-panel.tsx), so Next.js inlines it into the
#     browser bundle at BUILD time. Setting it in the values file does nothing;
#     it has to be a build arg. Symptom when missing: the captcha widget never
#     renders, the browser sends no token, and signup fails with
#     "Missing CAPTCHA response".
TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY:-1x00000000000000000000AA}"
TURNSTILE_SECRET_KEY="${TURNSTILE_SECRET_KEY:-1x0000000000000000000000000000000AA}"

# --- Queue -------------------------------------------------------------------
# QUEUE_MODE=bundled  the chart runs ElasticMQ, persistent, single node
# QUEUE_MODE=byo      point the values at your own SQS-compatible endpoint,
#                     including real AWS SQS
#
# ElasticMQ speaks the SQS API, so nothing in the application changes between
# the two: the same @aws-sdk/client-sqs reaches either through AWS_ENDPOINT_URL.
QUEUE_MODE="${QUEUE_MODE:-bundled}"

# The queue Service name. Also appears inside SQS_QUEUE_URL, which is an HMAC
# signing input, so changing it on an existing install rejects every in-flight
# message. Must match `queue.name` in the chart values.
QUEUE_NAME="${QUEUE_NAME:-elasticmq}"
SQS_HOST="${SQS_HOST:-${QUEUE_NAME}.${NAMESPACE}.svc.cluster.local}"
SQS_PORT="${SQS_PORT:-9324}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SQS_ACCOUNT_ID="${SQS_ACCOUNT_ID:-000000000000}"
SQS_QUEUE_NAME="${SQS_QUEUE_NAME:-keeperhub-workflow-queue}"

# Overridable in full, because a real SQS URL has a different shape entirely
# (https://sqs.<region>.amazonaws.com/<account>/<name>) and is not derivable
# from the parts above.
#
# Only defaulted when the chart runs the queue. Under QUEUE_MODE=byo an UNSET
# endpoint is meaningful: it is what sends the SDK to real AWS SQS with its
# normal credential resolution. Setting it there selects a self-hosted
# SQS-compatible endpoint instead, and install.sh merges the extra values
# fragment that carries it. Defaulting it would silently rule out real SQS.
if [ "$QUEUE_MODE" = "bundled" ]; then
    AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://${SQS_HOST}:${SQS_PORT}}"
else
    AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-}"
fi
# Two different jobs, depending on whether an endpoint is set.
#
# With a custom endpoint, these are dummies that only exist because the SDK
# refuses to sign a request without credentials; ElasticMQ ignores them, so they
# default to "test" and are passed as plain values.
#
# Against real AWS they are real credentials. They are then NOT defaulted, they
# go into a Secret rather than a values file, and AWS_SESSION_TOKEN carries the
# temporary-credential case. Leave all three empty to use the default credential
# chain instead, which is what an IRSA-enabled cluster wants.
if [ -n "$AWS_ENDPOINT_URL" ]; then
    AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
    AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
else
    AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
    AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"
fi
AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}"
AWS_CREDENTIALS_SECRET="${AWS_CREDENTIALS_SECRET:-keeperhub-aws-credentials}"

# True when the operator supplied real AWS credentials for a real SQS queue.
# Deliberately not true for the ElasticMQ dummies, which travel as plain values.
use_aws_credentials() {
    [ "$QUEUE_MODE" = byo ] && [ -z "$AWS_ENDPOINT_URL" ] \
        && [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ]
}
# Read the note at the top of this file before changing either URL. Derived from
# the endpoint only when there is one; with real AWS SQS both must be given in
# full, because that URL shape is not derivable from anything here.
if [ -n "$AWS_ENDPOINT_URL" ]; then
    SQS_QUEUE_URL="${SQS_QUEUE_URL:-${AWS_ENDPOINT_URL}/${SQS_ACCOUNT_ID}/${SQS_QUEUE_NAME}}"
    SQS_DLQ_URL="${SQS_DLQ_URL:-${AWS_ENDPOINT_URL}/${SQS_ACCOUNT_ID}/${SQS_QUEUE_NAME}-dlq}"
else
    SQS_QUEUE_URL="${SQS_QUEUE_URL:-}"
    SQS_DLQ_URL="${SQS_DLQ_URL:-}"
fi

# --- Database ----------------------------------------------------------------
# DB_MODE=bundled  the chart runs PostgreSQL as a CloudNativePG Cluster, which
#                  brings HA, failover, backup and restore with it. Requires the
#                  CNPG operator to be installed cluster-wide first.
# DB_MODE=byo      supply DATABASE_URL yourself, as a Kubernetes Secret.
DB_MODE="${DB_MODE:-bundled}"

PG_NAME="${PG_NAME:-${RELEASE}-postgres}"
PG_USER="${PG_USER:-keeperhub}"
PG_DATABASE="${PG_DATABASE:-keeperhub}"
PG_INSTANCES="${PG_INSTANCES:-1}"
PG_STORAGE_SIZE="${PG_STORAGE_SIZE:-20Gi}"
# kubernetes.io/basic-auth Secret the installer creates and CNPG bootstraps from.
PG_CREDENTIALS_SECRET="${PG_CREDENTIALS_SECRET:-${RELEASE}-db-credentials}"

# The host MUST be the fully qualified .svc.cluster.local form.
#
# ensureExplicitSslMode (lib/db/connection-utils.ts) only skips forcing
# sslmode=verify-full for that suffix. Anything shorter gets verify-full applied
# and then fails TLS against CloudNativePG's in-cluster certificate - which is
# why CNPG's own generated `uri` and `fqdn-uri` Secret keys are unusable here
# and the connection string is composed by hand.
#
# -rw is CNPG's primary Service and is repointed automatically on failover, so
# it stays correct with PG_INSTANCES > 1.
if [ "$DB_MODE" = "bundled" ]; then
    PG_HOST="${PG_HOST:-${PG_NAME}-rw.${NAMESPACE}.svc.cluster.local}"
else
    PG_HOST="${PG_HOST:-postgresql.${NAMESPACE}.svc.cluster.local}"
fi
PG_PASSWORD="${PG_PASSWORD:-}"
DATABASE_URL_IN_CLUSTER="${DATABASE_URL_IN_CLUSTER:-}"

# Name and key of the Secret holding DATABASE_URL when DB_MODE=byo.
DB_SECRET_NAME="${DB_SECRET_NAME:-keeperhub-db}"
DB_SECRET_KEY="${DB_SECRET_KEY:-DATABASE_URL}"

validate_modes() {
    case "$DB_MODE" in bundled|byo) ;; *) echo "DB_MODE must be 'bundled' or 'byo', got '$DB_MODE'" >&2; exit 1 ;; esac
    case "$QUEUE_MODE" in bundled|byo) ;; *) echo "QUEUE_MODE must be 'bundled' or 'byo', got '$QUEUE_MODE'" >&2; exit 1 ;; esac
    if [ "$QUEUE_MODE" = byo ] && { [ -z "$SQS_QUEUE_URL" ] || [ -z "$SQS_DLQ_URL" ]; }; then
        cat >&2 <<EOF
QUEUE_MODE=byo needs SQS_QUEUE_URL and SQS_DLQ_URL.

Real AWS SQS - give both in full and leave AWS_ENDPOINT_URL unset, so the SDK
resolves credentials the normal way:

    SQS_QUEUE_URL=https://sqs.<region>.amazonaws.com/<account>/<queue>
    SQS_DLQ_URL=https://sqs.<region>.amazonaws.com/<account>/<queue>-dlq

Your own SQS-compatible endpoint - set AWS_ENDPOINT_URL too, and the URLs are
derived from it unless you give them:

    AWS_ENDPOINT_URL=http://my-queue.my-namespace.svc.cluster.local:9324
EOF
        exit 1
    fi
}

kube() {
    kubectl --context "$KUBE_CONTEXT" "$@"
}

kube_ns() {
    kubectl --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" "$@"
}

require_tools() {
    local missing=0 tool
    for tool in "$@"; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            echo "  missing: $tool" >&2
            missing=1
        fi
    done
    [ "$missing" -eq 0 ] || { echo "Install the missing tools and re-run." >&2; exit 1; }
}

require_context() {
    if [ -z "$KUBE_CONTEXT" ]; then
        cat >&2 <<EOF
KUBE_CONTEXT is not set.

This install targets whichever cluster you name, and refuses to guess: a bare
kubectl follows the current context, which on a machine with production access
is how an install reaches the wrong cluster.

    KUBE_CONTEXT=<context> $0

Available:
$(kubectl config get-contexts -o name 2>/dev/null | sed 's/^/    /')
EOF
        exit 1
    fi
    if ! kubectl --context "$KUBE_CONTEXT" version >/dev/null 2>&1; then
        echo "Cannot reach cluster for context '$KUBE_CONTEXT'." >&2
        exit 1
    fi
}
