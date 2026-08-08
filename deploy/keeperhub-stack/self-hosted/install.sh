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
    validate_modes
    if [ -z "$IMAGE_TAG" ]; then
        echo "IMAGE_TAG is not set. It must name images the cluster can resolve." >&2
        exit 1
    fi

    # CloudNativePG is a prerequisite, not something this install provides: its
    # CRDs are cluster-scoped. Checked here rather than in the chart, because a
    # template gated on .Capabilities would silently render nothing under
    # `helm template` and prove nothing.
    if [ "$DB_MODE" = bundled ] && [ "$DRY_RUN" != true ]; then
        if ! kube get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
            cat >&2 <<EOF
DB_MODE=bundled needs the CloudNativePG operator, and its CRD is not installed.

    kubectl apply --server-side -f \\
      https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml

Or set DB_MODE=byo and point DB_SECRET_NAME at a Secret holding your own
connection string.
EOF
            exit 1
        fi
    fi

    # The chart renders a bare secretKeyRef with no `optional`, so a missing
    # Secret is CreateContainerConfigError and --atomic rolls the whole release
    # back with a message that names the container, not the Secret. Fail here
    # instead, where it can say what is actually wrong.
    if [ "$DB_MODE" = byo ] && [ "$DRY_RUN" != true ]; then
        if ! kube_ns get secret "$DB_SECRET_NAME" >/dev/null 2>&1; then
            echo "DB_MODE=byo but Secret '$DB_SECRET_NAME' does not exist in namespace '$NAMESPACE'." >&2
            echo "Create it with key '$DB_SECRET_KEY' holding the connection string, then re-run." >&2
            exit 1
        fi
    fi

    ok "context $KUBE_CONTEXT, namespace $NAMESPACE, db=$DB_MODE queue=$QUEUE_MODE, images $IMAGE_REPO:*-$IMAGE_TAG"
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
        render_manifest runner-sa.yaml
        return 0
    fi

    render_manifest namespace.yaml | kube apply -f -
    # Zero-RBAC ServiceAccount for per-execution runner pods. Not chart-rendered,
    # because the executor submits those Jobs through the API rather than Helm.
    # Without it the Jobs are admitted but their pods are rejected, and with
    # backoffLimit 0 the execution dies with no retry.
    render_manifest runner-sa.yaml | kube apply -f -
    ok "namespace and runner service account applied"
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

# In bundled mode: generate/keep the database password, create the basic-auth
# Secret CloudNativePG bootstraps from, and compose the connection string into
# the Secret every component reads.
#
# Hex rather than base64 on purpose. A "/" in a password breaks URL parsing in
# the migration step, and 64 hex characters carry more entropy than the base64
# form anyway. The encode step downstream is then defence in depth rather than
# load-bearing.
create_db_secrets() {
    [ "$DB_MODE" = bundled ] || return 0
    local pw
    pw=$(secret_value_or_keep "$PG_CREDENTIALS_SECRET" password hex "${PG_PASSWORD:-}")

    kube_ns create secret generic "$PG_CREDENTIALS_SECRET" \
        --type=kubernetes.io/basic-auth \
        --from-literal=username="$PG_USER" \
        --from-literal=password="$pw" \
        --dry-run=client -o yaml | kube apply -f -

    # Composed by hand rather than read from CloudNativePG's generated Secret:
    # its uri/fqdn-uri keys use hosts that do not end .svc.cluster.local, which
    # makes the application force sslmode=verify-full and fail TLS against the
    # in-cluster certificate.
    DATABASE_URL_IN_CLUSTER="postgresql://${PG_USER}:${pw}@${PG_HOST}:5432/${PG_DATABASE}"

    kube_ns create secret generic "$DB_SECRET_NAME" \
        --from-literal="$DB_SECRET_KEY=$DATABASE_URL_IN_CLUSTER" \
        --dry-run=client -o yaml | kube apply -f -
    ok "database credentials and connection string ($PG_HOST)"
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

    # Runner Job pods get DATABASE_URL from here. In byo mode the installer does
    # not know the URL, so it is copied out of the operator-supplied Secret.
    local runner_db_url="$DATABASE_URL_IN_CLUSTER"
    if [ -z "$runner_db_url" ]; then
        runner_db_url=$(kube_ns get secret "$DB_SECRET_NAME" -o "jsonpath={.data.$DB_SECRET_KEY}" 2>/dev/null | base64 -d 2>/dev/null || true)
    fi
    kube_ns create secret generic keeperhub-executor-db-url \
        --from-literal=keeperhub-executor-db-url="$runner_db_url" \
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
    SECRETS_CHECKSUM=$(printf '%s' "$hmac$agentic$auth$oauth$mcp$enc$sendgrid$runner_db_url" | sha256sum | cut -c1-16)
    export SECRETS_CHECKSUM
    ok "secrets applied (checksum $SECRETS_CHECKSUM)"
}

# Which placeholders each values file may contain, kept per file rather than as
# one list. A variable is then only required when the mode that uses it is
# selected: PG_* is meaningless under DB_MODE=byo, and AWS_ENDPOINT_URL is
# deliberately unset under QUEUE_MODE=byo, where its absence is what sends the
# SDK to real AWS.
BASE_SUBST_VARS=(
    IMAGE_REPO IMAGE_TAG IMAGE_PULL_POLICY APP_HOST INGRESS_CLASS TLS_ISSUER
    NAMESPACE AWS_REGION TURNSTILE_SECRET_KEY DB_SECRET_NAME DB_SECRET_KEY
)
DB_BUNDLED_SUBST_VARS=(PG_NAME PG_INSTANCES PG_DATABASE PG_USER PG_CREDENTIALS_SECRET PG_STORAGE_SIZE)
DB_BYO_SUBST_VARS=()
QUEUE_BUNDLED_SUBST_VARS=(QUEUE_NAME AWS_ENDPOINT_URL SQS_QUEUE_URL SQS_DLQ_URL)
QUEUE_BYO_SUBST_VARS=(SQS_QUEUE_URL SQS_DLQ_URL)
QUEUE_BYO_ENDPOINT_SUBST_VARS=(AWS_ENDPOINT_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY)

VALUES_ARGS=()

render_values_file() {
    local file="$1"; shift
    local var names="" rendered

    # envsubst reads the ENVIRONMENT, so every variable must be exported, not
    # merely set. Worth asserting rather than assuming: an unexported variable is
    # substituted with an empty string, not left as a placeholder, so the
    # leftover-placeholder check below cannot catch it. An empty APP_HOST renders
    # an Ingress with an empty TLS host, which the API server rejects with an RFC
    # 1123 error that says nothing about the real cause.
    for var in "$@"; do
        if [ -z "${!var:-}" ]; then
            echo "Substitution variable $var is unset or empty (see config.sh)." >&2
            exit 1
        fi
        export "${var?}"
        names="$names \${$var}"
    done

    rendered="$(mktemp -t "keeperhub-${file%.yaml}.XXXXXX.yaml")"
    # Named explicitly rather than substituting everything in the environment,
    # so an unrelated shell variable that happens to share a name with a word in
    # the file cannot rewrite it.
    envsubst "$names" < "$SCRIPT_DIR/$file" > "$rendered"

    if grep -q '\${' "$rendered"; then
        echo "Unsubstituted placeholders remain in $file:" >&2
        grep -n '\${' "$rendered" >&2
        exit 1
    fi
    VALUES_ARGS+=(-f "$rendered")
}

# Mode selection COMPOSES values files; it never overrides keys to null. Helm's
# null-deletion only fires for keys present in the chart's own defaults, and
# app.env is {} there, so `AWS_ENDPOINT_URL: null` in a later -f does not remove
# the key - it crashes the subchart on a nil dereference. Omitting the key from
# the file that is merged is the only way to express "not set".
render_values() {
    section "Rendering values"
    render_values_file values.yaml "${BASE_SUBST_VARS[@]}"

    local db_vars=() queue_vars=()
    case "$DB_MODE" in
        bundled) db_vars=("${DB_BUNDLED_SUBST_VARS[@]}") ;;
        byo) db_vars=("${DB_BYO_SUBST_VARS[@]+"${DB_BYO_SUBST_VARS[@]}"}") ;;
    esac
    case "$QUEUE_MODE" in
        bundled) queue_vars=("${QUEUE_BUNDLED_SUBST_VARS[@]}") ;;
        byo) queue_vars=("${QUEUE_BYO_SUBST_VARS[@]}") ;;
    esac

    render_values_file "values.db-$DB_MODE.yaml" "${db_vars[@]+"${db_vars[@]}"}"
    render_values_file "values.queue-$QUEUE_MODE.yaml" "${queue_vars[@]}"

    # Only when an endpoint was given. Its ABSENCE is what selects real AWS SQS,
    # so this cannot be folded into values.queue-byo.yaml with an empty value.
    local composed="values.yaml + db-$DB_MODE + queue-$QUEUE_MODE"
    if [ "$QUEUE_MODE" = byo ] && [ -n "$AWS_ENDPOINT_URL" ]; then
        render_values_file values.queue-byo-endpoint.yaml "${QUEUE_BYO_ENDPOINT_SUBST_VARS[@]}"
        composed="$composed + queue-byo-endpoint"
    fi
    ok "$composed"
}

# A working-tree chart when CHART_DIR is set, the published one otherwise. The
# --version flag is meaningless for a directory and helm rejects it there.
chart_ref() {
    if [ -n "$CHART_DIR" ]; then
        printf '%s' "$CHART_DIR"
    else
        printf '%s' "$CHART_NAME"
    fi
}


install_chart() {
    local version_args=()
    if [ -n "$CHART_DIR" ]; then
        section "Installing keeperhub-stack from $CHART_DIR"
    else
        section "Installing keeperhub-stack $CHART_VERSION"
        helm repo add "$CHART_REPO_NAME" "$CHART_REPO_URL" >/dev/null
        helm repo update "$CHART_REPO_NAME" >/dev/null
        version_args=(--version "$CHART_VERSION")
    fi

    if [ "$DRY_RUN" = true ]; then
        helm template "$RELEASE" "$(chart_ref)" \
            "${version_args[@]+"${version_args[@]}"}" \
            --namespace "$NAMESPACE" "${VALUES_ARGS[@]}"
        return 0
    fi

    # --atomic rolls the whole release back if any component fails readiness.
    helm upgrade --install "$RELEASE" "$(chart_ref)" \
        --kube-context "$KUBE_CONTEXT" \
        "${version_args[@]+"${version_args[@]}"}" \
        --namespace "$NAMESPACE" \
        "${VALUES_ARGS[@]}" \
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
        create_db_secrets
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
