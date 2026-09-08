#!/usr/bin/env bash
# Stands up a throwaway minikube cluster to test the self-hosted install against.
#
# This is TEST SCAFFOLDING, not part of the product. A real self-hosted install
# assumes the client already has a cluster; install.sh never creates one. All
# this does is produce a cluster that is not staging or prod, plus the
# prerequisites install.sh expects a platform to provide: an ingress controller,
# a TLS issuer and, for DB_MODE=bundled, the CloudNativePG operator.
#
# Postgres itself is no longer installed here. The chart brings it under
# DB_MODE=bundled, and under DB_MODE=byo it is by definition the operator's to
# provide.
#
# Usage:
#   ./bootstrap-cluster.sh              # create or reuse
#   ./bootstrap-cluster.sh --recreate   # destroy and rebuild (DESTROYS DATA)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/keeperhub-stack/self-hosted/config.sh
source "$SCRIPT_DIR/../config.sh"

MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-keeperhub}"
KUBE_CONTEXT="${KUBE_CONTEXT:-$MINIKUBE_PROFILE}"

# Harness constants, not install settings.
#
# config.sh carries what an install needs, and a real install supplies both of
# these itself. This cluster is the one values.minikube.yaml describes, and it has
# to be built before anything is deployed, so there is nothing to read them from
# yet. assert_overlay keeps the two copies honest.
TLS_ISSUER="mkcert-ca-issuer"   # values.minikube.yaml: global.tlsIssuer
assert_overlay tlsIssuer "$TLS_ISSUER"

# APP_HOST is NOT a harness constant. It comes from the settings file that
# config.sh loaded, which is the only place a hostname is written down. This
# script needs it only to print the /etc/hosts line at the end, so an unset one
# is not an error here - it just makes that line generic.
APP_HOST="${APP_HOST:-<your-app-host>}"

# Measured pod requests for the full stack come to roughly 3.3Gi, with
# steady-state RSS around 4.5-5.5Gi under real use. 4GB cannot schedule it.
MIN_MEMORY_GB=8
MIN_CPU_CORES=4
MIN_DISK_GB=40
FLOOR_MEMORY_GB=6

# NetworkPolicy is only enforced by a CNI that implements it. minikube's default
# accepts a NetworkPolicy object and enforces nothing, which would make an egress
# check pass while blocking nothing at all. Since the reason to run per-execution
# Jobs is to be able to test the isolation model, a silently no-op CNI would make
# the whole exercise misleading. The CNI is fixed at creation, so changing it
# means recreating the cluster.
CNI="calico"

CERT_MANAGER_VERSION="v1.21.1"

# CloudNativePG ships one cluster-scoped YAML rather than a chart. Its CRDs are
# cluster-scoped, which is exactly why the operator is a documented prerequisite
# of the install rather than a subchart of it.
CNPG_VERSION="1.24.1"
CNPG_MANIFEST="https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-${CNPG_VERSION}.yaml"

RECREATE=false
for arg in "$@"; do
    case $arg in
        --recreate) RECREATE=true ;;
        --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

section() { echo; echo "== $1"; }
ok() { echo "  ok    $1"; }

check_host() {
    section "Checking host"
    require_tools minikube kubectl helm docker mkcert
    docker info >/dev/null 2>&1 || { echo "Docker daemon is not running." >&2; exit 1; }

    local avail_gb free_disk_gb
    avail_gb=$(($(awk '/MemAvailable/ {print $2}' /proc/meminfo) / 1024 / 1024))
    echo "  memory available: ${avail_gb}GB"
    if [ "$avail_gb" -lt "$FLOOR_MEMORY_GB" ]; then
        echo "Need at least ${FLOOR_MEMORY_GB}GB free (${MIN_MEMORY_GB}GB recommended)." >&2
        echo "Refusing to continue: an under-resourced cluster fails later as pods that" >&2
        echo "never schedule and a helm --atomic rollback, which is far harder to read." >&2
        exit 1
    fi
    free_disk_gb=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')
    echo "  disk free: ${free_disk_gb}GB"
    [ "$free_disk_gb" -ge "$MIN_DISK_GB" ] || echo "  warning: under ${MIN_DISK_GB}GB free; the images are large" >&2
}

cni_present() { kubectl --context "$KUBE_CONTEXT" get daemonset -n kube-system calico-node >/dev/null 2>&1; }

create_cluster() {
    echo "  creating: ${MIN_MEMORY_GB}GB / ${MIN_CPU_CORES} CPU / ${MIN_DISK_GB}GB / $CNI"
    # Deliberately no --addons=ingress here: the addon's admission Jobs race the
    # CNI and fail if they start first, leaving the ingress controller wedged on
    # a Secret that is never created. Enabled after calico reports Ready.
    minikube -p "$MINIKUBE_PROFILE" start \
        --driver=docker --cni="$CNI" \
        --memory="${MIN_MEMORY_GB}g" --cpus="$MIN_CPU_CORES" \
        --disk-size="${MIN_DISK_GB}g" --kubernetes-version=stable
    kubectl --context "$KUBE_CONTEXT" wait --for=condition=Ready nodes --all --timeout=300s
    # `kubectl wait` on a label selector exits immediately with "no matching
    # resources found" when nothing matches yet, rather than waiting for the
    # pods to appear. On a fresh cluster the node goes Ready a moment before the
    # calico DaemonSet has produced any, so wait for the DaemonSet to exist and
    # roll out first, then wait on readiness.
    local waited=0
    until cni_present; do
        [ "$waited" -ge 120 ] && { echo "  calico DaemonSet never appeared" >&2; return 1; }
        sleep 3
        waited=$((waited + 3))
    done
    kubectl --context "$KUBE_CONTEXT" rollout status daemonset/calico-node -n kube-system --timeout=300s
    kubectl --context "$KUBE_CONTEXT" wait --for=condition=Ready pods -l k8s-app=calico-node -n kube-system --timeout=300s
}

ensure_ingress() {
    if ! minikube -p "$MINIKUBE_PROFILE" addons list | grep -q "ingress.*enabled"; then
        minikube -p "$MINIKUBE_PROFILE" addons enable ingress
    fi
    # Recover a cluster where those Jobs already failed. They are one-shot, so a
    # failed Job stays failed until it is recreated.
    local failed
    failed=$(kubectl --context "$KUBE_CONTEXT" get jobs -n ingress-nginx \
        -o jsonpath='{range .items[?(@.status.failed)]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
    if [ -n "$failed" ]; then
        echo "  ingress admission jobs failed (CNI was not ready), re-running"
        kubectl --context "$KUBE_CONTEXT" delete jobs -n ingress-nginx --all --ignore-not-found >/dev/null
        minikube -p "$MINIKUBE_PROFILE" addons disable ingress >/dev/null
        minikube -p "$MINIKUBE_PROFILE" addons enable ingress
    fi
    kubectl --context "$KUBE_CONTEXT" wait --for=condition=Ready pods \
        -l app.kubernetes.io/component=controller -n ingress-nginx --timeout=300s
}

start_cluster() {
    section "Cluster"
    local state=absent
    minikube -p "$MINIKUBE_PROFILE" status 2>/dev/null | grep -q Running && state=running
    [ "$state" = running ] || { minikube -p "$MINIKUBE_PROFILE" status 2>/dev/null | grep -q Stopped && state=stopped; } || true

    if [ "$RECREATE" = true ] && [ "$state" != absent ]; then
        echo "  --recreate: deleting profile $MINIKUBE_PROFILE"
        minikube delete -p "$MINIKUBE_PROFILE"
        state=absent
    fi

    case "$state" in
        running) echo "  already running" ;;
        stopped) minikube -p "$MINIKUBE_PROFILE" start
                 kubectl --context "$KUBE_CONTEXT" wait --for=condition=Ready nodes --all --timeout=300s ;;
        *) create_cluster ;;
    esac

    # Applies to every path above, including a cluster that was merely restarted,
    # because the CNI cannot be judged until the cluster is up.
    if ! cni_present; then
        cat >&2 <<EOF

Profile "$MINIKUBE_PROFILE" was created without the $CNI CNI. A NetworkPolicy
here is accepted by the API server and enforced by nothing, so an egress
restriction would appear to work while blocking nothing. The CNI is fixed at
creation and cannot be changed in place.

Re-run with --recreate to rebuild it. That DESTROYS the cluster and its data.
EOF
        exit 1
    fi
    ensure_ingress
    ok "cluster ready with $CNI"
}

# The namespace a ClusterIssuer resolves its secretName in. cert-manager takes it
# from --cluster-resource-namespace and defaults to its own namespace, so it is
# read off the running controller rather than assumed - putting the CA Secret in
# the wrong place leaves the issuer permanently NotReady with "secret not found".
cert_manager_resource_namespace() {
    local ns args
    ns=$(kubectl --context "$KUBE_CONTEXT" get deploy -A \
        -l app.kubernetes.io/name=cert-manager,app.kubernetes.io/component=controller \
        -o jsonpath='{.items[0].metadata.namespace}' 2>/dev/null || true)
    [ -n "$ns" ] || return 1
    args=$(kubectl --context "$KUBE_CONTEXT" -n "$ns" get deploy -l app.kubernetes.io/component=controller \
        -o jsonpath='{.items[0].spec.template.spec.containers[0].args}' 2>/dev/null || true)
    case "$args" in
        *--cluster-resource-namespace=*)
            printf '%s' "${args#*--cluster-resource-namespace=}" | cut -d'"' -f1 ;;
        *) printf '%s' "$ns" ;;
    esac
}

setup_tls() {
    section "TLS"
    # A working issuer is the prerequisite, not a cert-manager release owned by
    # this script. Reused when it is already there, which also keeps this off
    # any cert-manager another profile on the same cluster installed.
    if [ "$(kubectl --context "$KUBE_CONTEXT" get clusterissuer "$TLS_ISSUER" \
        -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "True" ]; then
        ok "$TLS_ISSUER already ready"
        return 0
    fi

    local ca_root ca_cert ca_key issuer_ns
    ca_root=$(mkcert -CAROOT); ca_cert="$ca_root/rootCA.pem"; ca_key="$ca_root/rootCA-key.pem"
    [ -f "$ca_cert" ] || { echo "  installing mkcert CA (may prompt)"; mkcert -install; }

    # cert-manager's CRDs are cluster-scoped and carry helm ownership metadata,
    # so a second release fails outright on "cannot be imported into the current
    # release" rather than merging.
    if kubectl --context "$KUBE_CONTEXT" get crd certificates.cert-manager.io >/dev/null 2>&1; then
        issuer_ns=$(cert_manager_resource_namespace)
        echo "  cert-manager already installed, adding only $TLS_ISSUER (CA in $issuer_ns)"
    else
        helm repo add jetstack https://charts.jetstack.io >/dev/null
        helm repo update jetstack >/dev/null
        helm upgrade --install cert-manager jetstack/cert-manager \
            --kube-context "$KUBE_CONTEXT" --namespace "$NAMESPACE" --create-namespace \
            --version "$CERT_MANAGER_VERSION" --set crds.enabled=true \
            --set "clusterResourceNamespace=$NAMESPACE" --wait
        issuer_ns="$NAMESPACE"
    fi

    kubectl --context "$KUBE_CONTEXT" create namespace "$issuer_ns" \
        --dry-run=client -o yaml | kubectl --context "$KUBE_CONTEXT" apply -f - >/dev/null
    kubectl --context "$KUBE_CONTEXT" -n "$issuer_ns" create secret generic mkcert-ca \
        --from-file=tls.crt="$ca_cert" --from-file=tls.key="$ca_key" \
        --dry-run=client -o yaml | kubectl --context "$KUBE_CONTEXT" apply -f -

    # A ClusterIssuer, not a namespaced Issuer: the common chart's certificate
    # template emits issuerRef.kind: ClusterIssuer unconditionally.
    kubectl --context "$KUBE_CONTEXT" apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: $TLS_ISSUER
spec:
  ca:
    secretName: mkcert-ca
EOF
    kubectl --context "$KUBE_CONTEXT" wait --for=condition=Ready "clusterissuer/$TLS_ISSUER" --timeout=60s
    ok "$TLS_ISSUER ready"
}

setup_cnpg() {
    section "CloudNativePG"
    if [ "$DB_MODE" != bundled ]; then
        echo "  skipped (DB_MODE=$DB_MODE - you supply the database)"
        return 0
    fi
    # --server-side because the CRDs carry annotations past the 262144-byte limit
    # that client-side apply stores in last-applied-configuration.
    kubectl --context "$KUBE_CONTEXT" apply --server-side -f "$CNPG_MANIFEST"
    kubectl --context "$KUBE_CONTEXT" wait --for=condition=Available \
        deployment/cnpg-controller-manager -n cnpg-system --timeout=300s
    ok "cloudnative-pg $CNPG_VERSION ready"
}

main() {
    check_host
    start_cluster
    setup_tls
    setup_cnpg
    cat <<EOF

== Test cluster ready

  context     $KUBE_CONTEXT
  namespace   $NAMESPACE
  database    DB_MODE=$DB_MODE
  queue       QUEUE_MODE=$QUEUE_MODE
  TLS issuer  $TLS_ISSUER
  CNI         $CNI (NetworkPolicy is enforced)

Next:
  ./test-harness/build-images.sh
  KUBE_CONTEXT=$KUBE_CONTEXT PROFILE=minikube IMAGE_TAG=<tag> ./install.sh

Then, to reach it:
  minikube tunnel -p $MINIKUBE_PROFILE
  echo "\$(minikube -p $MINIKUBE_PROFILE ip) $APP_HOST" | sudo tee -a /etc/hosts
EOF
}

main
