#!/usr/bin/env bash
# Configuration for a self-hosted KeeperHub install.
#
# Sourced by install.sh and by the scripts under test-harness/.
#
# This file no longer substitutes anything into the values files. Those are
# ordinary Helm input now, and every setting below is passed through as a --set
# on the chart's `global` map. The values files remain usable without this
# script; it exists to turn environment variables into helm flags, run the
# preflight checks helm cannot, and refuse to guess a cluster.
#
# One thing here is a cryptographic input rather than a mere address:
#
#   The SQS queue URL is signed. Producers sign
#   "sqs\n<queueUrl>\n<caller>\n<sha256(body)>\n<ts>" (lib/sqs-message-auth.ts)
#   and the executor verifies against its own SQS_QUEUE_URL. One byte of
#   difference between any producer and the consumer rejects every trigger as
#   bad_signature, visible only as a warn line while all pods stay green. Under
#   the bundled queue the chart computes it and strictEndpointCheck verifies it;
#   under QUEUE_MODE=byo you supply it and nothing can check it for you.
#
# Override any of these in the environment before running install.sh.
#
# shellcheck disable=SC2034
# Most variables here are consumed by the scripts that source this file.

# ---------------------------------------------------------------------------
# The settings file
# ---------------------------------------------------------------------------
# ENV_FILE names one file that holds every setting for an install. It is the
# single place a hostname, a credential or a mode is written down; install.sh,
# bootstrap-cluster.sh and build-images.sh all read the same one, so they cannot
# disagree about what is being built or where it is served.
#
#   ENV_FILE=/path/to/my-install.env ./install.sh
#
# Anything already set in the environment wins, so a one-off override still
# works: APP_HOST=other.example ./install.sh
ENV_FILE="${ENV_FILE:-}"

# Read a settings file WITHOUT letting the shell parse the values.
#
# `set -a; . file` cannot be used and this is not a style preference. A shell
# assignment performs quote removal, so an unquoted JSON value silently loses
# its double quotes. CHAIN_RPC_CONFIG went from 493 characters to 453 that way
# and stopped being valid JSON, which parseRpcConfig catches and turns into an
# empty config - the install then falls back to public RPC defaults with no
# websocket URLs, and the Block and Event triggers connect to nothing while
# every pod stays green.
#
# Assigning from a variable never re-parses the bytes, so the value arrives
# exactly as written.
load_env_file() {
    local file="$1" line name value
    [ -n "$file" ] || return 0
    if [ ! -f "$file" ]; then
        echo "ENV_FILE=$file does not exist." >&2
        exit 1
    fi

    # The `|| [ -n "$line" ]` tail reads a final line with no newline.
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        case "$line" in
            ''|'#'*|' '*'#'*|$'\t'*) continue ;;
        esac
        case "$line" in *=*) ;; *) continue ;; esac

        name="${line%%=*}"
        value="${line#*=}"

        # A commented-out assignment is an opt-out, not a value, and anything
        # that is not a plain identifier is prose that happened to contain "=".
        case "$name" in
            [A-Za-z_]*) ;;
            *) continue ;;
        esac
        case "$name" in *[!A-Za-z0-9_]*) continue ;; esac

        # Strip one layer of matching surrounding quotes.
        #
        # The settings file has to survive two different readers. This one takes
        # each line literally, while the image build is a plain
        # `set -a; . .env`, and the shell performs quote removal. An unquoted
        # JSON value therefore loses its double quotes on the build side, and a
        # quoted one keeps its outer quotes on this side. Quoting the file and
        # stripping here is the only form that means the same thing to both.
        case "$value" in
            \'*\') value="${value#\'}"; value="${value%\'}" ;;
            \"*\") value="${value#\"}"; value="${value%\"}" ;;
        esac

        # An empty entry stays unset rather than becoming "". Several settings
        # are read with `??`, which falls back on undefined but not on an empty
        # string, so exporting "" would replace a working default with nothing.
        [ -n "$value" ] || continue

        # Already set in the environment wins, so a per-run override holds.
        [ -n "${!name:-}" ] && continue

        export "$name=$value"
    done <"$file"
}

load_env_file "$ENV_FILE"

# The cluster and namespace to install into. KUBE_CONTEXT is required rather
# than defaulted, because a bare kubectl follows whatever context happens to be
# current, and on a machine with production access that is how an install lands
# somewhere it should not.
KUBE_CONTEXT="${KUBE_CONTEXT:-}"
NAMESPACE="${NAMESPACE:-keeperhub}"
RELEASE="${RELEASE:-keeperhub}"

# The chart repository. This is the only host the install reaches that
# KeeperHub operates, so it is overridable for an installer who mirrors the
# chart rather than pulling it from us. CHART_DIR below bypasses the repository
# entirely and installs from a local directory.
CHART_REPO_NAME="${CHART_REPO_NAME:-techops-services}"
CHART_REPO_URL="${CHART_REPO_URL:-https://techops-services.github.io/helm-charts}"
CHART_NAME="${CHART_NAME:-${CHART_REPO_NAME}/keeperhub-stack}"
CHART_VERSION="${CHART_VERSION:-0.5.0}"
# Point at a working-tree chart instead of the published one, for developing
# chart changes alongside this profile: CHART_DIR=../../../helm-charts/charts/keeperhub-stack
CHART_DIR="${CHART_DIR:-}"
HELM_TIMEOUT="${HELM_TIMEOUT:-15m0s}"

# PROFILE=minikube also merges values.minikube.yaml, which carries the settings
# that only make sense on the throwaway cluster test-harness/ builds. Anything
# else installs the base profile alone.
PROFILE="${PROFILE:-}"

# Where the images come from. No defaults: the chart fails the render naming the
# value rather than installing something that cannot pull.
IMAGE_REPO="${IMAGE_REPO:-}"
IMAGE_TAG="${IMAGE_TAG:-}"
IMAGE_PULL_POLICY="${IMAGE_PULL_POLICY:-}"

# The Code step's execution sandbox, applied from sandbox.yaml.
#
# Off by default, which matches what the chart does: keeperhub-stack does not
# render a sandbox, so an install has never had one. Everything except the Code
# step works without it, and the failure is loud and local - that one step ends
# with a connection error rather than the install misbehaving.
#
# On, it needs the sandbox image present in the same repository as the rest, and
# it adds the one workload in the install that executes code the operator did
# not write. sandbox.yaml documents what that pod is denied.
SANDBOX_ENABLED="${SANDBOX_ENABLED:-false}"

# The egress policy in networkpolicy.yaml: deny everything, then allow DNS, the
# install's own namespace, the API server and the public internet minus every
# private range.
#
# Off by default for two reasons. It does nothing at all on a cluster whose CNI
# ignores NetworkPolicy, which is most default installs and includes minikube
# without --cni=calico, so an operator could believe they were protected when
# they were not. And a policy that silently drops traffic is a poor first
# experience; better to install, confirm the product works, then close it down.
EGRESS_POLICY="${EGRESS_POLICY:-false}"

# Prove the egress policy rather than report what the cluster looks like.
#
# On, install.sh runs two TCP connects from a pod that is already running in the
# namespace: one to the API server, which the policy allows and which must
# succeed, and one to the kubelet port on the API server's own node, which the
# policy denies and which must NOT. That measures both halves - the policy is
# enforced, and it did not lock out the one caller that needs the API server.
#
# It creates nothing and deletes nothing. It costs one kubectl exec, it never
# fails the install, and it reports "inconclusive" whenever it cannot run.
#
# Off by default only because it reaches into a pod, which an operator should
# opt into rather than discover. Turn it on the first time you enable the
# policy on a new cluster shape.
EGRESS_POLICY_VERIFY="${EGRESS_POLICY_VERIFY:-false}"

# The API server addresses and ports the egress policy allows.
#
# Leave both empty. install.sh reads them from the cluster it was pointed at,
# which is the only way to be right on more than one kind of cluster: the
# address is 10.96.0.1 on kubeadm and minikube, 10.43.0.1 on k3s, and the port
# is 443 through the Service but 6443 or 8443 behind it.
#
# They are settings at all because a discovery can be wrong for a cluster this
# profile has not seen. Anything set here replaces what was discovered. Give a
# space- or comma-separated list; a bare address without a prefix becomes /32,
# or /128 for IPv6:
#
#   APISERVER_CIDR="10.43.0.1 192.168.1.10"
#   APISERVER_PORT="443 6443"
#
# BOTH the Service address and the endpoint behind it are allowed, and that is
# not belt and braces. A pod addresses the API server by the Service ClusterIP,
# kube-proxy rewrites the destination to the endpoint, and the CNI evaluates
# egress policy on whichever of the two it sees. Measured on minikube with
# calico: with only the ClusterIP allowed, every connection to the API server
# timed out, because calico sees the rewritten address. Allowing both is the
# only form that holds whichever address the CNI matches on.
APISERVER_CIDR="${APISERVER_CIDR:-}"
APISERVER_PORT="${APISERVER_PORT:-}"

# The hostname the app is served on, and how it is exposed.
#
# Any hostname works. The application ships a fixed trusted-origin list
# (lib/trusted-origins.ts) covering localhost and *.keeperhub.com, which backs
# the CSRF guard; the profile extends it with this host through
# ADDITIONAL_TRUSTED_ORIGINS so a client domain is trusted out of the box.
#
# Worth knowing because the failure mode is quiet: an untrusted origin still
# loads and reads, and only writes fail, with 403 and "[csrf] blocked:
# untrusted origin" in the app log. If you serve the app on more origins than
# APP_HOST, add them to ADDITIONAL_TRUSTED_ORIGINS yourself.
APP_HOST="${APP_HOST:-}"
INGRESS_CLASS="${INGRESS_CLASS:-}"
TLS_ISSUER="${TLS_ISSUER:-}"

# Transactional mail. Both are required, and the preflight refuses to install
# without them.
#
# SendGrid is the only supported sender, so bring your own account. The app
# posts to SendGrid's HTTP API and reads the key at runtime, which means no mail
# server is involved and there is no SMTP setting to look for.
#
# The failure mode without a key is quiet rather than loud: the app still
# generates verification codes, invitations and password resets and still stores
# them, but delivers none of them. Signup then stops at the six-digit code
# prompt with no way to obtain a code, which reads as a broken app rather than
# an unconfigured one. That is why this is a preflight failure.
#
# FROM_ADDRESS must be a sender identity verified in the SAME SendGrid account
# that issued the key. SendGrid rejects every send from an unverified sender.
#
# A separate variable, SENDGRID_API_URL, overrides where the send is posted.
# Leave it alone unless your egress policy forbids a direct call, in which case
# point it at a relay of yours that accepts SendGrid's request shape.
SENDGRID_API_KEY="${SENDGRID_API_KEY:-}"
FROM_ADDRESS="${FROM_ADDRESS:-}"

# A second hostname served by the same app, added to the ingress and to
# ADDITIONAL_TRUSTED_ORIGINS alongside APP_HOST.
#
# It exists because some third parties will only accept a hostname whose domain
# you can prove you own. A Google OAuth redirect and a Turnstile widget both
# want that, and a reserved domain such as example.com cannot be proved. So the
# install can serve the reserved name it is evaluated on and a real name the
# third parties accept, at the same time, without choosing between them.
#
# Leave empty for a single-host install, which is the normal case.
APP_ALIAS_HOST="${APP_ALIAS_HOST:-}"

# Cloudflare Turnstile.
#
# The two keys are NOT delivered the same way, and getting that wrong yields a
# signup form that renders and then fails:
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
TURNSTILE_SECRET_KEY="${TURNSTILE_SECRET_KEY:-}"

# --- Queue -------------------------------------------------------------------
# QUEUE_MODE=bundled  the chart runs ElasticMQ, persistent, single node
# QUEUE_MODE=byo      point the values at your own SQS-compatible endpoint,
#                     including real AWS SQS
#
# ElasticMQ speaks the SQS API, so nothing in the application changes between
# the two: the same @aws-sdk/client-sqs reaches either through AWS_ENDPOINT_URL.
QUEUE_MODE="${QUEUE_MODE:-bundled}"

# Under QUEUE_MODE=bundled the chart computes every queue address from the
# release namespace, so nothing here applies.
#
# Under QUEUE_MODE=byo an UNSET endpoint is meaningful: it is what sends the SDK
# to real AWS SQS with its normal credential resolution. Setting it selects a
# self-hosted SQS-compatible endpoint instead, and install.sh merges the extra
# values fragment that carries it.
AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-}"
SQS_QUEUE_URL="${SQS_QUEUE_URL:-}"
SQS_DLQ_URL="${SQS_DLQ_URL:-}"
AWS_REGION="${AWS_REGION:-}"

# Two different jobs, depending on whether an endpoint is set.
#
# With a custom endpoint these are dummies that exist only because the SDK
# refuses to sign a request without credentials; ElasticMQ ignores them.
#
# Against real AWS they are real credentials. They then go into a Secret rather
# than a values file, and AWS_SESSION_TOKEN carries the temporary-credential
# case. Leave all three empty to use the default credential chain instead, which
# is what an IRSA-enabled cluster wants.
AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"
AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}"
AWS_CREDENTIALS_SECRET="${AWS_CREDENTIALS_SECRET:-keeperhub-aws-credentials}"

# True when the operator supplied real AWS credentials for a real SQS queue.
# Deliberately not true for the ElasticMQ dummies, which travel as plain values.
use_aws_credentials() {
    [ "$QUEUE_MODE" = byo ] && [ -z "$AWS_ENDPOINT_URL" ] \
        && [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ]
}

# --- Database ----------------------------------------------------------------
# DB_MODE=bundled  the chart runs PostgreSQL as a CloudNativePG Cluster, which
#                  brings HA, failover, backup and restore with it. Requires the
#                  CNPG operator to be installed cluster-wide first.
# DB_MODE=byo      supply DATABASE_URL yourself, as a Kubernetes Secret.
DB_MODE="${DB_MODE:-bundled}"
PG_INSTANCES="${PG_INSTANCES:-}"
PG_STORAGE_SIZE="${PG_STORAGE_SIZE:-}"

# Name and key of the Secret holding DATABASE_URL. In bundled mode the chart
# writes it; in byo mode you create it and the chart reads it.
DB_SECRET_NAME="${DB_SECRET_NAME:-keeperhub-db}"
DB_SECRET_KEY="${DB_SECRET_KEY:-DATABASE_URL}"

# --- Runner credentials ------------------------------------------------------
# The executor hands runner Job pods their credentials by secretKeyRef, building
# each reference as "<prefix>-<slug>" with the key equal to the name
# (keeperhub-executor/k8s-job.ts). Only DATABASE_URL and
# INTEGRATION_ENCRYPTION_KEY are non-optional there; the eight below are marked
# optional, so a runner with none of them starts, exits 0 and looks healthy while
# every step that needed one silently did nothing.
#
# The optionality lives in application code, which this programme does not
# change. What the install layer can do is say which are absent, at install time
# rather than after a confusing execution.
RUNNER_SECRET_PREFIX="${RUNNER_SECRET_PREFIX:-keeperhub-executor}"
STRICT_RUNNER_SECRETS="${STRICT_RUNNER_SECRETS:-false}"

# Which environment variable supplies each runner slug.
#
# check_runner_secrets below only reports what is absent. This list is what lets
# install.sh create them, so an operator who has the credentials does not have to
# run eight kubectl commands by hand and get the "key equals the name" convention
# right eight times.
#
# slug|environment variable
RUNNER_SECRET_SOURCES=(
    "chain-rpc-config|CHAIN_RPC_CONFIG"
    "etherscan-api-key|ETHERSCAN_API_KEY"
    "openai-api-key|OPENAI_API_KEY"
    "sendgrid-api-key|SENDGRID_API_KEY"
    "turnkey-api-private-key|TURNKEY_API_PRIVATE_KEY"
    "turnkey-api-public-key|TURNKEY_API_PUBLIC_KEY"
)

# An OAuth client id is needed twice, under two names, and the two do different
# jobs. Deriving the second from the first so nobody has to know that.
#
#   NEXT_PUBLIC_GITHUB_CLIENT_ID  compiled into the browser bundle. Decides
#                                 whether the sign-in button is rendered.
#   GITHUB_CLIENT_ID              read at runtime. lib/auth.ts gates the
#                                 provider on `enabled: !!process.env.
#                                 GITHUB_CLIENT_ID`.
#
# Set only the public one and the result is the quiet kind of broken: the button
# appears, because the bundle has an id, and the provider behind it is disabled,
# so the flow fails after the user has already committed to it.
GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID:-${NEXT_PUBLIC_GITHUB_CLIENT_ID:-}}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-${NEXT_PUBLIC_GOOGLE_CLIENT_ID:-}}"

# Secret material the chart stores rather than generates.
#
# These reach the app through secrets.values in the chart, which writes them
# into keeperhub-shared and keeperhub-email. Everything else in those Secrets is
# generated and must not be overridden here: regenerating an encryption key
# orphans the data encrypted with the old one.
#
# Creating only the runner copies is not enough and the failure is quiet. The
# runner Secrets serve workflow steps inside Job pods; the app reads these. Miss
# them and the app logs "SENDGRID_API_KEY environment variable is not
# configured" while the variable is demonstrably mounted, because what is
# mounted is an empty string the chart wrote.
CHART_SECRET_VARS=(
    SENDGRID_API_KEY
    TURNKEY_API_PRIVATE_KEY
    TURNKEY_API_PUBLIC_KEY
    TURNKEY_ORGANIZATION_ID
)

# Third-party configuration passed to the app, each one optional.
#
# Rendered into a values fragment at install time, and ONLY when the variable is
# actually set. That is deliberate rather than tidy: several of these are read
# with `??`, which falls back on undefined but NOT on an empty string, so
# supplying an empty value would replace a working default with nothing.
# BASE_RPC_URL is the clearest case - lib/payments/x402/reconcile.ts reads
# `process.env.BASE_RPC_URL ?? "https://mainnet.base.org"`.
APP_INTEGRATION_VARS=(
    AGENT_ID
    AGENT_REGISTRY_CHAIN_ID
    ANTHROPIC_API_KEY
    BASE_RPC_URL
    CDP_API_KEY_ID
    CDP_API_KEY_SECRET
    CLIENT_IP_HEADERS
    CLIENT_IP_TRUSTED_PROXIES
    EMAIL_LOGO_URL
    ETHERSCAN_API_KEY
    GEOIP_ENABLED
    GITHUB_CLIENT_ID
    GITHUB_CLIENT_SECRET
    GOOGLE_CLIENT_ID
    GOOGLE_CLIENT_SECRET
    MPP_SECRET_KEY
    OPENAI_API_KEY
    PAYG_RESOURCE_URL
    SENDGRID_API_URL
    TURNKEY_API_BASE_URL
    X402_FACILITATOR_URL
    ZERION_API_KEY
)

# Sent to every geo provider by default, and none of them needs a credential, so
# configuring nothing is not the same as sending nothing. Off unless overridden.
GEOIP_ENABLED="${GEOIP_ENABLED:-false}"

# slug|what stops working without it
RUNNER_OPTIONAL_SECRETS=(
    "chain-rpc-config|web3 steps have no RPC endpoints and cannot reach any chain"
    "etherscan-api-key|contract ABI auto-fetch fails, so web3 steps needing an ABI fail"
    "metrics-ingest-token|runner metrics are not shipped, so executions are invisible"
    "openai-api-key|AI steps and AI workflow generation fail"
    "sendgrid-api-key|email steps send nothing"
    "simple-account-7702-address|EIP-7702 smart-account steps fail"
    "turnkey-api-private-key|managed wallet signing fails"
    "turnkey-api-public-key|managed wallet signing fails"
)

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

Your own SQS-compatible endpoint - set AWS_ENDPOINT_URL as well:

    AWS_ENDPOINT_URL=http://my-queue.my-namespace.svc.cluster.local:9324
EOF
        exit 1
    fi
}

# Assert that a constant hardcoded in a test-harness script still matches the
# overlay it mirrors.
#
# The harness runs before anything is deployed, so a few values - the local image
# repository, the mkcert issuer, the hostname - cannot be discovered and have to
# be written down twice: once in values.minikube.yaml, which the install reads,
# and once in the script. This makes the second copy fail loudly when the first
# one changes, instead of the script quietly building an image nothing pulls or
# applying a ClusterIssuer with a blank name.
#
# Structural on purpose. A grep for the bare value would be satisfied by a
# mention in a comment.
assert_overlay() {
    local key="$1" want="$2" overlay="${3:-$SCRIPT_DIR/../values.minikube.yaml}"
    if ! grep -qE "^[[:space:]]*${key}:[[:space:]]*\"?${want}\"?[[:space:]]*$" "$overlay"; then
        echo "Harness constant ${key}=${want} no longer matches $(basename "$overlay")." >&2
        echo "Update the script and the overlay together, or the install and the" >&2
        echo "harness will disagree about what they are building." >&2
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
