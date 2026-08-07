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
CHART_VERSION="${CHART_VERSION:-0.3.0}"
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
APP_HOST="${APP_HOST:-local.keeperhub.com}"
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
# ElasticMQ speaks the SQS API, so no application code changes: the same
# @aws-sdk/client-sqs reaches it through AWS_ENDPOINT_URL. Unlike LocalStack it
# needs no auth token and its free edition is not being retired.
SQS_HOST="${SQS_HOST:-elasticmq.${NAMESPACE}.svc.cluster.local}"
SQS_PORT="${SQS_PORT:-9324}"
AWS_ENDPOINT_URL="http://${SQS_HOST}:${SQS_PORT}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SQS_ACCOUNT_ID="000000000000"
SQS_QUEUE_NAME="keeperhub-workflow-queue"
# Read the note at the top of this file before changing either URL.
SQS_QUEUE_URL="${AWS_ENDPOINT_URL}/${SQS_ACCOUNT_ID}/${SQS_QUEUE_NAME}"
SQS_DLQ_URL="${AWS_ENDPOINT_URL}/${SQS_ACCOUNT_ID}/${SQS_QUEUE_NAME}-dlq"

# --- Database ----------------------------------------------------------------
# Bring-your-own PostgreSQL 17. The install does not provision one; the test
# harness does, purely so there is something to point at.
PG_HOST="${PG_HOST:-postgresql.${NAMESPACE}.svc.cluster.local}"
PG_USER="${PG_USER:-local}"
PG_PASSWORD="${PG_PASSWORD:-local}"
PG_DATABASE="${PG_DATABASE:-keeperhub}"
# ensureExplicitSslMode (lib/db/connection-utils.ts) deliberately no-ops for
# *.svc.cluster.local, so no sslmode and no CA bundle are needed in-cluster.
DATABASE_URL_IN_CLUSTER="${DATABASE_URL_IN_CLUSTER:-postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:5432/${PG_DATABASE}}"

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
