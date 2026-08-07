#!/usr/bin/env bash
# Stands up a throwaway minikube cluster to test the self-hosted install against.
#
# This is TEST SCAFFOLDING, not part of the product. A real self-hosted install
# assumes the client already has a cluster; install.sh never creates one. All
# this does is produce a cluster that is not staging or prod, plus the
# prerequisites install.sh expects a platform to provide: an ingress controller,
# a TLS issuer and a PostgreSQL to point at.
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
POSTGRES_CHART_VERSION="16.7.27"
POSTGRES_IMAGE_REPO="bitnamilegacy/postgresql"
POSTGRES_IMAGE_TAG="17.6.0-debian-12-r4"

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

setup_tls() {
    section "TLS"
    local ca_root ca_cert ca_key
    ca_root=$(mkcert -CAROOT); ca_cert="$ca_root/rootCA.pem"; ca_key="$ca_root/rootCA-key.pem"
    [ -f "$ca_cert" ] || { echo "  installing mkcert CA (may prompt)"; mkcert -install; }

    helm repo add jetstack https://charts.jetstack.io >/dev/null
    helm repo update jetstack >/dev/null
    helm upgrade --install cert-manager jetstack/cert-manager \
        --kube-context "$KUBE_CONTEXT" --namespace "$NAMESPACE" --create-namespace \
        --version "$CERT_MANAGER_VERSION" --set crds.enabled=true \
        --set "clusterResourceNamespace=$NAMESPACE" --wait

    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" create secret generic mkcert-ca \
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

setup_postgres() {
    section "PostgreSQL"
    # Bring-your-own in a real install. Provided here only so there is something
    # for DATABASE_URL_IN_CLUSTER to point at.
    helm upgrade --install postgresql \
        oci://registry-1.docker.io/bitnamicharts/postgresql \
        --kube-context "$KUBE_CONTEXT" --namespace "$NAMESPACE" --create-namespace \
        --version "$POSTGRES_CHART_VERSION" \
        --set "auth.username=$PG_USER" --set "auth.password=$PG_PASSWORD" \
        --set auth.database=local --set "auth.postgresPassword=$PG_PASSWORD" \
        --set image.registry=docker.io \
        --set "image.repository=$POSTGRES_IMAGE_REPO" \
        --set "image.tag=$POSTGRES_IMAGE_TAG" --wait
    kubectl --context "$KUBE_CONTEXT" wait --for=condition=Ready pods \
        -l app.kubernetes.io/name=postgresql -n "$NAMESPACE" --timeout=300s

    local psql_admin
    psql_admin=(kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec postgresql-0 --
        env "PGPASSWORD=$PG_PASSWORD" psql -U postgres -tAc)
    if [ "$("${psql_admin[@]}" "SELECT 1 FROM pg_database WHERE datname='$PG_DATABASE';" | tr -d '[:space:]')" != "1" ]; then
        "${psql_admin[@]}" "CREATE DATABASE $PG_DATABASE;" >/dev/null
    fi
    # drizzle-kit migrate creates its own 'drizzle' schema, so the app role needs
    # CREATE on the database as well as rights inside public.
    "${psql_admin[@]}" "GRANT ALL PRIVILEGES ON DATABASE $PG_DATABASE TO $PG_USER;" >/dev/null
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" exec postgresql-0 -- \
        env "PGPASSWORD=$PG_PASSWORD" psql -U postgres -d "$PG_DATABASE" -tAc \
        "GRANT ALL ON SCHEMA public TO $PG_USER; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $PG_USER;" >/dev/null
    ok "postgresql ready, database $PG_DATABASE"
}

main() {
    check_host
    start_cluster
    setup_tls
    setup_postgres
    cat <<EOF

== Test cluster ready

  context     $KUBE_CONTEXT
  namespace   $NAMESPACE
  database    $PG_HOST/$PG_DATABASE
  TLS issuer  $TLS_ISSUER
  CNI         $CNI (NetworkPolicy is enforced)

Next:
  ./test-harness/build-images.sh
  KUBE_CONTEXT=$KUBE_CONTEXT IMAGE_TAG=<tag> ./install.sh

Then, to reach it:
  minikube tunnel -p $MINIKUBE_PROFILE
  echo "\$(minikube -p $MINIKUBE_PROFILE ip) $APP_HOST" | sudo tee -a /etc/hosts
EOF
}

main
