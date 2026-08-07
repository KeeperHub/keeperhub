#!/usr/bin/env bash
# Builds the KeeperHub images, side-loads them into minikube and installs the
# keeperhub-stack umbrella chart - the same chart staging and prod use.
#
# Assumes deploy/local/setup-local.sh has already provisioned the cluster,
# PostgreSQL, the queue and the TLS issuer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# .env supplies developer-specific secrets. It is sourced BEFORE common.sh on
# purpose: common.sh then overwrites every infrastructure value it owns, so a
# stale .env left over from the docker-compose stack - an AWS_ENDPOINT_URL or
# SQS_QUEUE_URL still pointing at LocalStack, say - cannot silently repoint this
# deployment. Getting that wrong would produce a queue URL mismatch between
# components, which surfaces only as every message being rejected as
# bad_signature.
if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.env"
    set +a
fi

# shellcheck source=deploy/local/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

SKIP_BUILD=false
DRY_RUN=false

usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

  --skip-build   Reuse images already loaded in the cluster
  --dry-run      Render the values and print the helm command without applying
  --help         Show this message
EOF
}

for arg in "$@"; do
    case $arg in
        --skip-build) SKIP_BUILD=true ;;
        --dry-run) DRY_RUN=true ;;
        --help) usage; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
    esac
done

section() { echo; echo "== $1"; }
ok() { echo "  ok    $1"; }

cd "$REPO_ROOT"

# Derived from the git state unless pinned. Pinning is useful when iterating on
# the values file or the manifests, because it reuses images already built and
# loaded instead of producing a new tag on every run:
#   IMAGE_TAG=$(git rev-parse --short HEAD) ./deploy/local/deploy.sh --skip-build
IMAGE_TAG="${IMAGE_TAG:-$(resolve_image_tag)}"
export IMAGE_TAG

preflight() {
    section "Preflight"
    require_tools docker kubectl helm envsubst
    if ! kube get namespace "$NAMESPACE" >/dev/null 2>&1; then
        echo "Namespace '$NAMESPACE' not found. Run: make setup-local-kubernetes" >&2
        exit 1
    fi
    if ! kube_ns get deployment elasticmq >/dev/null 2>&1; then
        echo "Queue not found. Run: make setup-local-kubernetes" >&2
        exit 1
    fi
    ok "cluster ready, image tag $IMAGE_TAG"
}

# One bake session builds all five targets. app, migrator, workflow-runner and
# executor share the deps -> source -> builder chain, so pnpm install and the
# Next.js build run once rather than once per image.
build_images() {
    section "Building images"
    # NEXT_PUBLIC_* values are inlined into the browser bundle by Next.js at
    # build time, so the site key has to be present HERE. It cannot be supplied
    # through the values file like the rest of the app config. docker-bake.hcl
    # already declares it as a variable and passes it to the app target.
    NEXT_PUBLIC_TURNSTILE_SITE_KEY="$TURNSTILE_TEST_SITE_KEY" \
    docker buildx bake \
        -f docker-bake.hcl \
        -f deploy/local/docker-bake.local.hcl \
        --set "*.cache-from=" \
        --set "*.cache-to=" \
        local
    ok "built"
}

# 'minikube image load' is a docker save | docker load round-trip and is the
# dominant cost of a warm redeploy, so skip images the node already has.
load_images() {
    section "Loading images into minikube"
    local present image
    present=$(minikube -p "$MINIKUBE_PROFILE" image ls 2>/dev/null || true)

    for image in \
        "${IMAGE_REPO}:app-${IMAGE_TAG}" \
        "${IMAGE_REPO}:migrator-${IMAGE_TAG}" \
        "${IMAGE_REPO}:workflow-runner-${IMAGE_TAG}" \
        "${IMAGE_REPO}:executor-${IMAGE_TAG}" \
        "${IMAGE_REPO}:schedule-${IMAGE_TAG}"
    do
        if printf '%s' "$present" | grep -q "$image"; then
            echo "  skip  $image (already in node)"
        else
            echo "  load  $image"
            minikube -p "$MINIKUBE_PROFILE" image load "$image"
        fi
    done
    ok "images available in cluster"
}

# The chart has no Secret template, so these are created imperatively - the same
# thing the PR-environment workflow does for the runner's db-url secret.
#
# Values come from .env when set, otherwise a generated one is stored on first
# run and reused afterwards, so re-deploying never silently rotates a key and
# orphans data encrypted under the old one.
#
# The format is not cosmetic and differs per secret, so it is passed in
# explicitly rather than assumed:
#
#   b64 - must base64-decode to exactly 32 bytes. INTERNAL_SERVICE_HMAC_SECRET
#         (scripts/seed-internal-service-hmac.ts rejects anything else) and
#         AGENTIC_WALLET_HMAC_KMS_KEY (lib/agentic-wallet/hmac-secret-store.ts
#         refuses to start otherwise).
#   hex - 64 hex characters, i.e. a 32-byte key. INTEGRATION_ENCRYPTION_KEY,
#         which lib/db/integrations.ts reads as aes-256-gcm key material.
#   any - opaque string, no constraint.
generate_secret() {
    case "$1" in
        b64) openssl rand -base64 32 ;;
        *) openssl rand -hex 32 ;;
    esac
}

secret_has_format() {
    local value fmt
    value="$1"; fmt="$2"
    case "$fmt" in
        b64) [ "$(printf '%s' "$value" | base64 -d 2>/dev/null | wc -c)" -eq 32 ] ;;
        hex) printf '%s' "$value" | grep -qE '^[0-9a-fA-F]{64}$' ;;
        *) [ -n "$value" ] ;;
    esac
}

secret_value_or_keep() {
    local secret_name key fmt from_env existing decoded
    secret_name="$1"; key="$2"; fmt="$3"; from_env="${4:-}"

    if [ -n "$from_env" ]; then
        printf '%s' "$from_env"
        return
    fi

    existing=$(kube_ns get secret "$secret_name" -o "jsonpath={.data.$key}" 2>/dev/null || true)
    if [ -n "$existing" ]; then
        decoded=$(printf '%s' "$existing" | base64 -d 2>/dev/null || true)
        # Reuse only if it is still valid for its format. Without this check a
        # value generated in the wrong format stays wrong forever, and the
        # symptom is remote from the cause: a bad HMAC secret means the seed
        # script rejects it, the store row is never written, and scheduled
        # triggers then silently 401 with nothing obviously broken.
        if secret_has_format "$decoded" "$fmt"; then
            printf '%s' "$decoded"
            return
        fi
        echo "  regenerating $key (stored value is not a valid $fmt secret)" >&2
    fi

    generate_secret "$fmt"
}

create_secrets() {
    section "Creating secrets"

    local hmac agentic auth oauth mcp
    hmac=$(secret_value_or_keep keeperhub-local-shared INTERNAL_SERVICE_HMAC_SECRET b64 "${INTERNAL_SERVICE_HMAC_SECRET:-}")
    agentic=$(secret_value_or_keep keeperhub-local-shared AGENTIC_WALLET_HMAC_KMS_KEY b64 "${AGENTIC_WALLET_HMAC_KMS_KEY:-}")
    auth=$(secret_value_or_keep keeperhub-local-shared BETTER_AUTH_SECRET any "${BETTER_AUTH_SECRET:-}")
    oauth=$(secret_value_or_keep keeperhub-local-shared OAUTH_JWT_SECRET any "${OAUTH_JWT_SECRET:-}")
    mcp=$(secret_value_or_keep keeperhub-local-shared MCP_SESSION_SECRET any "${MCP_SESSION_SECRET:-}")

    # Turnkey is optional locally. The keys must exist because the app and
    # executor reference them, but empty values are fine until an organisation
    # actually has an active Turnkey wallet.
    kube_ns create secret generic keeperhub-local-shared \
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
    local enc
    enc=$(secret_value_or_keep keeperhub-executor-integration-encryption-key \
        keeperhub-executor-integration-encryption-key hex "${INTEGRATION_ENCRYPTION_KEY:-}")

    kube_ns create secret generic keeperhub-executor-db-url \
        --from-literal=keeperhub-executor-db-url="$DATABASE_URL_IN_CLUSTER" \
        --dry-run=client -o yaml | kube apply -f -

    kube_ns create secret generic keeperhub-executor-integration-encryption-key \
        --from-literal=keeperhub-executor-integration-encryption-key="$enc" \
        --dry-run=client -o yaml | kube apply -f -

    # Outbound email. Created unconditionally, even with an empty value, because
    # the values file references it with a plain secretKeyRef and the common
    # chart provides no way to mark that optional - a missing Secret is
    # CreateContainerConfigError, not a degraded install.
    #
    # An empty key is a legitimate state: sendEmail returns false and nothing is
    # delivered, so signup, invitations and password reset all dead-end at the
    # "enter the code" step. Supply SENDGRID_API_KEY in .env to make them work.
    # There is no local mail-catcher option because lib/email.ts posts to
    # SendGrid's HTTP API rather than SMTP; see KEEP-1119.
    # Deliberately NOT secret_value_or_keep: that generates a random value when
    # it finds nothing, which for an API key would replace a clean "not
    # configured" state with a bogus credential and turn silence into 401s from
    # SendGrid. Order here is .env, then whatever is already stored, then empty.
    local sendgrid
    sendgrid="${SENDGRID_API_KEY:-}"
    if [ -z "$sendgrid" ]; then
        sendgrid=$(kube_ns get secret keeperhub-local-email \
            -o "jsonpath={.data.SENDGRID_API_KEY}" 2>/dev/null | base64 -d 2>/dev/null || true)
    fi
    kube_ns create secret generic keeperhub-local-email \
        --from-literal=SENDGRID_API_KEY="$sendgrid" \
        --dry-run=client -o yaml | kube apply -f -
    if [ -z "$sendgrid" ]; then
        echo "  note  no SENDGRID_API_KEY - outbound email is off, so signup cannot be completed"
    fi

    # Pods read these through secretKeyRef, and updating a Secret does NOT
    # restart the pods consuming it - an env var is resolved once, at pod start.
    # So without this, changing a secret leaves the running pods holding the old
    # value while everything derived from the new one disagrees with them. The
    # HMAC secret makes that concrete: the dispatcher would keep signing with the
    # stale value while the database row held the new one, and every internal
    # call would 401 with all pods green.
    #
    # Staging solves this with the stakater reloader annotation, which needs an
    # operator that a stock cluster does not have. A checksum in the pod template
    # is the operator-free equivalent: when it changes, helm rolls the pods.
    SECRETS_CHECKSUM=$(printf '%s' "$hmac$agentic$auth$oauth$mcp$enc$sendgrid" | sha256sum | cut -c1-16)
    export SECRETS_CHECKSUM

    ok "secrets applied (checksum $SECRETS_CHECKSUM)"
}

apply_runner_sa() {
    section "Applying workflow-runner ServiceAccount"
    kube apply -f "$REPO_ROOT/$PROFILE_DIR/runner-sa.yaml"
    ok "keeperhub-workflow-runner"
}

# envsubst with an explicit allowlist. The old sed-based substitution corrupted
# any value containing '/' or '&', and a bare envsubst would eat unrelated
# shell-looking text in the values file such as $(date).
SUBST_VARS=(
    IMAGE_TAG
    APP_HOST
    DATABASE_URL_IN_CLUSTER
    AWS_ENDPOINT_URL
    AWS_REGION
    SQS_QUEUE_URL
    SQS_DLQ_URL
)

render_values() {
    local var names=""

    # envsubst reads the ENVIRONMENT, so every variable has to be exported, not
    # merely set as a shell variable by common.sh. This is worth asserting
    # rather than assuming: an unexported variable is substituted with an empty
    # string, not left as a "${...}" placeholder, so the leftover-placeholder
    # check below cannot detect it. An empty APP_HOST renders an Ingress with an
    # empty TLS host, which the API server rejects with an RFC 1123 error that
    # says nothing about the real cause.
    for var in "${SUBST_VARS[@]}"; do
        if [ -z "${!var:-}" ]; then
            echo "Substitution variable $var is unset or empty." >&2
            echo "It should be defined in deploy/local/lib/common.sh." >&2
            exit 1
        fi
        export "${var?}"
        names="$names \${$var}"
    done

    RENDERED_VALUES="$(mktemp -t keeperhub-local-values.XXXXXX.yaml)"
    envsubst "$names" < "$REPO_ROOT/$VALUES_TEMPLATE" > "$RENDERED_VALUES"

    # Catches a placeholder in the values file that is not in SUBST_VARS.
    if grep -q '\${' "$RENDERED_VALUES"; then
        echo "Unsubstituted placeholders remain in the rendered values:" >&2
        grep -n '\${' "$RENDERED_VALUES" >&2
        exit 1
    fi
}

deploy_stack() {
    section "Deploying keeperhub-stack $CHART_VERSION"
    helm repo add "$CHART_REPO_NAME" "$CHART_REPO_URL" >/dev/null
    helm repo update "$CHART_REPO_NAME" >/dev/null

    if [ "$DRY_RUN" = true ]; then
        echo "  rendered values: $RENDERED_VALUES"
        helm template "$RELEASE" "$CHART_NAME" \
            --version "$CHART_VERSION" \
            --namespace "$NAMESPACE" \
            -f "$RENDERED_VALUES"
        return 0
    fi

    # --atomic rolls the whole release back if any component fails to become
    # ready. The timeout is 15m rather than the old 5m because a cold first
    # deploy waits behind the full migration set plus image starts.
    helm upgrade --install "$RELEASE" "$CHART_NAME" \
        --kube-context "$MINIKUBE_PROFILE" \
        --version "$CHART_VERSION" \
        --namespace "$NAMESPACE" \
        -f "$RENDERED_VALUES" \
        --set "app.podAnnotations.keeperhub\.local/secrets-checksum=$SECRETS_CHECKSUM" \
        --set "executor.podAnnotations.keeperhub\.local/secrets-checksum=$SECRETS_CHECKSUM" \
        --set "schedule.podAnnotations.keeperhub\.local/secrets-checksum=$SECRETS_CHECKSUM" \
        --atomic \
        --wait \
        --timeout "$HELM_TIMEOUT"
    ok "release $RELEASE deployed"
}

main() {
    preflight
    if [ "$SKIP_BUILD" = false ]; then
        build_images
    else
        echo "  skipping image build (--skip-build)"
    fi
    # Always runs, even with --skip-build. Loading is a separate concern from
    # building: images live in the host daemon and have to be side-loaded into
    # the minikube node, and a freshly created cluster has none of them no
    # matter how recently they were built. load_images already skips anything
    # the node already has, so this is cheap when there is nothing to do.
    load_images
    create_secrets
    apply_runner_sa
    render_values
    deploy_stack

    [ "$DRY_RUN" = true ] && exit 0

    cat <<EOF

== Deployed

  kubectl --context $MINIKUBE_PROFILE -n $NAMESPACE get pods

If https://$APP_HOST/ does not resolve:
  1. minikube tunnel            # in another terminal
  2. echo "\$(minikube -p $MINIKUBE_PROFILE ip) $APP_HOST" | sudo tee -a /etc/hosts
EOF
}

main
