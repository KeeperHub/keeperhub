#!/usr/bin/env bash
# Installs KeeperHub into an existing Kubernetes cluster.
#
# This is the self-hosted install. It assumes the cluster is already there and
# does not create one - platform bar is any Kubernetes 1.28 or later with a
# default StorageClass and an ingress controller. Standing up a throwaway
# cluster to try this against is test scaffolding, and lives in test-harness/.
#
# Prerequisites the install does NOT provide:
#   - a reachable PostgreSQL 17 (bring your own; point DATABASE_URL_IN_CLUSTER at it)
#   - an ingress controller
#   - a cert-manager Issuer named by TLS_ISSUER, if you want TLS
#   - container images reachable by the cluster, at IMAGE_REPO:<component>-IMAGE_TAG
#
# Usage:
#   KUBE_CONTEXT=<context> IMAGE_TAG=<tag> ./install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# .env supplies operator-specific secrets. Sourced BEFORE config.sh so that
# config.sh still owns every infrastructure value: a stale .env cannot silently
# repoint the queue, which would surface only as bad_signature on every trigger.
if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.env"
    set +a
fi

# shellcheck source=deploy/keeperhub-stack/self-hosted/config.sh
source "$SCRIPT_DIR/config.sh"

DRY_RUN=false
for arg in "$@"; do
    case $arg in
        --dry-run) DRY_RUN=true ;;
        --help)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

section() { echo; echo "== $1"; }
ok() { echo "  ok    $1"; }

preflight() {
    section "Preflight"
    require_tools kubectl helm envsubst openssl
    require_context
    if [ -z "$IMAGE_TAG" ]; then
        echo "IMAGE_TAG is not set. It must name images the cluster can resolve." >&2
        exit 1
    fi
    ok "context $KUBE_CONTEXT, namespace $NAMESPACE, images $IMAGE_REPO:*-$IMAGE_TAG"
}

# The manifests carry ${NAMESPACE}, so they are rendered the same way the values
# file is rather than applied raw.
render_manifest() {
    envsubst '${NAMESPACE}' < "$SCRIPT_DIR/$1"
}

apply_manifests() {
    section "Applying namespace and cluster resources"
    if [ "$DRY_RUN" = true ]; then
        # A dry run must not touch the cluster, so print instead of applying.
        render_manifest namespace.yaml
        render_manifest elasticmq.yaml
        render_manifest runner-sa.yaml
        return 0
    fi

    render_manifest namespace.yaml | kube apply -f -
    # The queue. Part of the install rather than a prerequisite: a self-hosted
    # install needs one, and ElasticMQ is what we support. Declares its queues
    # statically, so readiness implies queue-ready with no bootstrap race.
    render_manifest elasticmq.yaml | kube apply -f -
    # Zero-RBAC ServiceAccount for per-execution runner pods. Not chart-rendered,
    # because the executor submits those Jobs through the API rather than Helm.
    # Without it the Jobs are admitted but their pods are rejected, and with
    # backoffLimit 0 the execution dies with no retry.
    render_manifest runner-sa.yaml | kube apply -f -
    kube wait --for=condition=Available deployment/elasticmq -n "$NAMESPACE" --timeout=180s
    ok "queue ready at $AWS_ENDPOINT_URL"
}

# Formats differ per secret and are not interchangeable:
#   b64 - must base64-decode to exactly 32 bytes (INTERNAL_SERVICE_HMAC_SECRET,
#         AGENTIC_WALLET_HMAC_KMS_KEY)
#   hex - 64 hex characters (INTEGRATION_ENCRYPTION_KEY, aes-256-gcm material)
#   any - opaque
generate_secret() {
    case "$1" in
        b64) openssl rand -base64 32 ;;
        *) openssl rand -hex 32 ;;
    esac
}

secret_has_format() {
    case "$2" in
        b64) [ "$(printf '%s' "$1" | base64 -d 2>/dev/null | wc -c)" -eq 32 ] ;;
        hex) printf '%s' "$1" | grep -qE '^[0-9a-fA-F]{64}$' ;;
        *) [ -n "$1" ] ;;
    esac
}

# Prefer an operator-supplied value, else keep what is already installed, else
# generate. Keeping the stored value matters: regenerating on every run would
# orphan data encrypted under the previous key.
secret_value_or_keep() {
    local secret_name key fmt from_env existing decoded
    secret_name="$1"; key="$2"; fmt="$3"; from_env="${4:-}"

    if [ -n "$from_env" ]; then printf '%s' "$from_env"; return; fi

    existing=$(kube_ns get secret "$secret_name" -o "jsonpath={.data.$key}" 2>/dev/null || true)
    if [ -n "$existing" ]; then
        decoded=$(printf '%s' "$existing" | base64 -d 2>/dev/null || true)
        if secret_has_format "$decoded" "$fmt"; then printf '%s' "$decoded"; return; fi
        echo "  regenerating $key (stored value is not a valid $fmt secret)" >&2
    fi
    generate_secret "$fmt"
}

create_secrets() {
    section "Creating secrets"
    local hmac agentic auth oauth mcp enc sendgrid

    hmac=$(secret_value_or_keep keeperhub-shared INTERNAL_SERVICE_HMAC_SECRET b64 "${INTERNAL_SERVICE_HMAC_SECRET:-}")
    agentic=$(secret_value_or_keep keeperhub-shared AGENTIC_WALLET_HMAC_KMS_KEY b64 "${AGENTIC_WALLET_HMAC_KMS_KEY:-}")
    auth=$(secret_value_or_keep keeperhub-shared BETTER_AUTH_SECRET any "${BETTER_AUTH_SECRET:-}")
    oauth=$(secret_value_or_keep keeperhub-shared OAUTH_JWT_SECRET any "${OAUTH_JWT_SECRET:-}")
    mcp=$(secret_value_or_keep keeperhub-shared MCP_SESSION_SECRET any "${MCP_SESSION_SECRET:-}")

    # Turnkey is optional. The keys must exist because the app and executor
    # reference them, but empty is fine until an org has an active wallet.
    kube_ns create secret generic keeperhub-shared \
        --from-literal=INTERNAL_SERVICE_HMAC_SECRET="$hmac" \
        --from-literal=AGENTIC_WALLET_HMAC_KMS_KEY="$agentic" \
        --from-literal=BETTER_AUTH_SECRET="$auth" \
        --from-literal=OAUTH_JWT_SECRET="$oauth" \
        --from-literal=MCP_SESSION_SECRET="$mcp" \
        --from-literal=TURNKEY_API_PUBLIC_KEY="${TURNKEY_API_PUBLIC_KEY:-}" \
        --from-literal=TURNKEY_API_PRIVATE_KEY="${TURNKEY_API_PRIVATE_KEY:-}" \
        --from-literal=TURNKEY_ORGANIZATION_ID="${TURNKEY_ORGANIZATION_ID:-}" \
        --dry-run=client -o yaml | kube apply -f -

    # Runner Job pods receive these by secretKeyRef, built by the executor as
    # "<RUNNER_SECRET_PREFIX>-<slug>" with the key equal to the name.
    # DATABASE_URL and INTEGRATION_ENCRYPTION_KEY are non-optional there, so a
    # missing secret means every runner pod fails CreateContainerConfigError.
    enc=$(secret_value_or_keep keeperhub-executor-integration-encryption-key \
        keeperhub-executor-integration-encryption-key hex "${INTEGRATION_ENCRYPTION_KEY:-}")

    kube_ns create secret generic keeperhub-executor-db-url \
        --from-literal=keeperhub-executor-db-url="$DATABASE_URL_IN_CLUSTER" \
        --dry-run=client -o yaml | kube apply -f -
    kube_ns create secret generic keeperhub-executor-integration-encryption-key \
        --from-literal=keeperhub-executor-integration-encryption-key="$enc" \
        --dry-run=client -o yaml | kube apply -f -

    # Outbound email. Created unconditionally, even empty, because the values
    # file references it with a plain secretKeyRef and the common chart offers no
    # way to mark that optional - a missing Secret is CreateContainerConfigError,
    # not a degraded install. Not the generate-if-missing path above: inventing a
    # random API key would replace a clean unconfigured state with 401s.
    sendgrid="${SENDGRID_API_KEY:-}"
    if [ -z "$sendgrid" ]; then
        sendgrid=$(kube_ns get secret keeperhub-email -o "jsonpath={.data.SENDGRID_API_KEY}" 2>/dev/null | base64 -d 2>/dev/null || true)
    fi
    kube_ns create secret generic keeperhub-email \
        --from-literal=SENDGRID_API_KEY="$sendgrid" \
        --dry-run=client -o yaml | kube apply -f -
    if [ -z "$sendgrid" ]; then
        echo "  note  no SENDGRID_API_KEY - outbound email is off, so signup, invitations"
        echo "        and password reset cannot be completed (see KEEP-1119)"
    fi

    # Pods read these through secretKeyRef, and updating a Secret does not
    # restart the pods consuming it - an env var is resolved once, at pod start.
    # A checksum in the pod template is the operator-free equivalent of the
    # reloader annotation staging uses: when it changes, helm rolls the pods.
    SECRETS_CHECKSUM=$(printf '%s' "$hmac$agentic$auth$oauth$mcp$enc$sendgrid" | sha256sum | cut -c1-16)
    export SECRETS_CHECKSUM
    ok "secrets applied (checksum $SECRETS_CHECKSUM)"
}

SUBST_VARS=(
    IMAGE_REPO IMAGE_TAG IMAGE_PULL_POLICY APP_HOST INGRESS_CLASS TLS_ISSUER
    NAMESPACE DATABASE_URL_IN_CLUSTER AWS_ENDPOINT_URL AWS_REGION
    SQS_QUEUE_URL SQS_DLQ_URL TURNSTILE_SECRET_KEY
)

render_values() {
    local var names=""
    # envsubst reads the ENVIRONMENT, so every variable must be exported, not
    # merely set. Worth asserting rather than assuming: an unexported variable is
    # substituted with an empty string, not left as a placeholder, so the
    # leftover-placeholder check below cannot catch it. An empty APP_HOST renders
    # an Ingress with an empty TLS host, which the API server rejects with an RFC
    # 1123 error that says nothing about the real cause.
    for var in "${SUBST_VARS[@]}"; do
        if [ -z "${!var:-}" ]; then
            echo "Substitution variable $var is unset or empty (see config.sh)." >&2
            exit 1
        fi
        export "${var?}"
        names="$names \${$var}"
    done

    RENDERED_VALUES="$(mktemp -t keeperhub-self-hosted-values.XXXXXX.yaml)"
    envsubst "$names" < "$SCRIPT_DIR/values.yaml" > "$RENDERED_VALUES"

    if grep -q '\${' "$RENDERED_VALUES"; then
        echo "Unsubstituted placeholders remain:" >&2
        grep -n '\${' "$RENDERED_VALUES" >&2
        exit 1
    fi
}

install_chart() {
    section "Installing keeperhub-stack $CHART_VERSION"
    helm repo add "$CHART_REPO_NAME" "$CHART_REPO_URL" >/dev/null
    helm repo update "$CHART_REPO_NAME" >/dev/null

    if [ "$DRY_RUN" = true ]; then
        helm template "$RELEASE" "$CHART_NAME" \
            --version "$CHART_VERSION" --namespace "$NAMESPACE" -f "$RENDERED_VALUES"
        return 0
    fi

    # --atomic rolls the whole release back if any component fails readiness.
    helm upgrade --install "$RELEASE" "$CHART_NAME" \
        --kube-context "$KUBE_CONTEXT" \
        --version "$CHART_VERSION" \
        --namespace "$NAMESPACE" \
        -f "$RENDERED_VALUES" \
        --set "app.podAnnotations.keeperhub\.io/secrets-checksum=$SECRETS_CHECKSUM" \
        --set "executor.podAnnotations.keeperhub\.io/secrets-checksum=$SECRETS_CHECKSUM" \
        --set "schedule.podAnnotations.keeperhub\.io/secrets-checksum=$SECRETS_CHECKSUM" \
        --atomic --wait --timeout "$HELM_TIMEOUT"
    ok "release $RELEASE installed"
}

main() {
    preflight
    # NAMESPACE is needed by render_manifest below, and the values renderer
    # exports the rest.
    export NAMESPACE
    apply_manifests
    # Secrets mutate the cluster, so a dry run skips them and renders with a
    # placeholder checksum rather than creating anything.
    if [ "$DRY_RUN" = true ]; then
        SECRETS_CHECKSUM="dry-run"
    else
        create_secrets
    fi
    render_values
    install_chart
    [ "$DRY_RUN" = true ] && exit 0

    cat <<EOF

== Installed

  kubectl --context $KUBE_CONTEXT -n $NAMESPACE get pods

KeeperHub is served at https://$APP_HOST/ once that name resolves to your
ingress controller.
EOF
}

main
