#!/usr/bin/env bash
# Provisions the local minikube cluster and everything the KeeperHub Helm
# release expects to already exist: the namespace, TLS issuer, PostgreSQL and
# the queue.
#
# This script owns what staging gets from Terraform and EKS. The application
# itself is deployed separately by deploy/local/deploy.sh from the same umbrella
# chart staging and prod use.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=deploy/local/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

CHECK_ONLY=false
RECREATE=false
RESET_DB=false

usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

  --check      Report whether the environment is ready to deploy, then exit
  --recreate   Delete and recreate the minikube cluster. Required when the
               existing cluster was built without the ${CNI} CNI, because a
               cluster's CNI cannot be changed in place. DESTROYS all cluster
               data, including the local PostgreSQL volume.
  --reset-db   Drop and recreate the ${PG_DATABASE} database before setup. Use
               when an older database was bootstrapped with 'db:push' and so
               cannot accept file-based migrations.
  --help       Show this message
EOF
}

for arg in "$@"; do
    case $arg in
        --check) CHECK_ONLY=true ;;
        --recreate) RECREATE=true ;;
        --reset-db) RESET_DB=true ;;
        --help) usage; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
    esac
done

ok()   { echo "  ok    $1"; }
warn() { echo "  warn  $1"; }
bad()  { echo "  FAIL  $1"; }
section() { echo; echo "== $1"; }

quick_check() {
    local errors=0
    section "Checking local environment"

    for tool in minikube kubectl helm docker; do
        command -v "$tool" >/dev/null 2>&1 || { bad "$tool not installed"; errors=$((errors + 1)); }
    done

    if ! docker info >/dev/null 2>&1; then
        bad "docker daemon not running"; errors=$((errors + 1))
    else
        ok "docker daemon"
    fi

    if ! minikube -p "$MINIKUBE_PROFILE" status 2>/dev/null | grep -q "Running"; then
        bad "minikube profile '$MINIKUBE_PROFILE' not running"; errors=$((errors + 1))
    else
        ok "minikube running"
    fi

    # A cluster without a NetworkPolicy-enforcing CNI silently accepts policies
    # and enforces none, so this is an error rather than a warning.
    if ! kube get daemonset -n kube-system calico-node >/dev/null 2>&1; then
        bad "calico not installed - NetworkPolicy would not be enforced (re-run with --recreate)"
        errors=$((errors + 1))
    else
        ok "calico CNI"
    fi

    kube get namespace "$NAMESPACE" >/dev/null 2>&1 \
        && ok "namespace $NAMESPACE" \
        || { bad "namespace $NAMESPACE missing"; errors=$((errors + 1)); }

    kube get pods -n ingress-nginx -l app.kubernetes.io/component=controller 2>/dev/null | grep -q "Running" \
        && ok "ingress controller" \
        || { bad "ingress controller not ready"; errors=$((errors + 1)); }

    kube_ns get pods -l app.kubernetes.io/name=postgresql 2>/dev/null | grep -q "Running" \
        && ok "postgresql" \
        || { bad "postgresql not running"; errors=$((errors + 1)); }

    kube_ns get pods -l app=elasticmq 2>/dev/null | grep -q "Running" \
        && ok "elasticmq (queue)" \
        || { bad "elasticmq not running - no workflow trigger can be delivered"; errors=$((errors + 1)); }

    kube_ns get pods -l app.kubernetes.io/instance=cert-manager 2>/dev/null | grep -q "Running" \
        && ok "cert-manager" \
        || warn "cert-manager not running (HTTPS will not work)"

    echo
    if [ "$errors" -gt 0 ]; then
        echo "Environment not ready ($errors issue(s)). Run: make setup-local-kubernetes"
        exit 1
    fi
    echo "Environment ready to deploy."
    exit 0
}

[ "$CHECK_ONLY" = true ] && quick_check

check_prerequisites() {
    section "Checking prerequisites"
    require_tools minikube kubectl helm docker mkcert
    ok "all present"
}

check_resources() {
    section "Checking host resources"
    check_host_resources
}

# Must run only once the CNI is Ready. The ingress addon's admission Jobs make
# API calls as soon as they start; on a cluster whose CNI is still initialising
# they fail, never create the 'ingress-nginx-admission' Secret, and the
# controller then hangs forever on MountVolume.SetUp for that Secret. This is
# why the cluster is created without --addons=ingress and the addon is enabled
# separately below.
ensure_ingress_addon() {
    if ! minikube -p "$MINIKUBE_PROFILE" addons list | grep -q "ingress.*enabled"; then
        minikube -p "$MINIKUBE_PROFILE" addons enable ingress
    fi

    # Recover a cluster where those Jobs already failed for the reason above.
    # They are one-shot, so a failed Job stays failed until it is recreated.
    if kube get jobs -n ingress-nginx -o name 2>/dev/null | grep -q admission; then
        local failed
        failed=$(kube get jobs -n ingress-nginx \
            -o jsonpath='{range .items[?(@.status.failed)]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
        if [ -n "$failed" ]; then
            echo "  ingress admission jobs failed (CNI was not ready), re-running them"
            kube delete jobs -n ingress-nginx --all --ignore-not-found >/dev/null
            minikube -p "$MINIKUBE_PROFILE" addons disable ingress >/dev/null
            minikube -p "$MINIKUBE_PROFILE" addons enable ingress
        fi
    fi

    kube wait --for=condition=Ready pods \
        -l app.kubernetes.io/component=controller -n ingress-nginx --timeout=300s
}

# A cluster's CNI is chosen at creation and cannot be changed in place, so an
# existing non-calico cluster must be recreated or the whole NetworkPolicy story
# is a lie. Detect via the daemonset rather than 'minikube profile list', which
# does not reliably report the CNI.
#
# The check has to run against a RUNNING cluster, which means a stopped profile
# must be started before it can be judged. Do not collapse this into the start
# paths: a stopped non-calico cluster that is merely started would otherwise
# pass through unverified.
cni_present() {
    kube get daemonset -n kube-system calico-node >/dev/null 2>&1
}

refuse_or_recreate() {
    cat >&2 <<EOF

The minikube profile "$MINIKUBE_PROFILE" was created without the $CNI CNI.

A NetworkPolicy on this cluster is accepted by the API server and enforced by
nothing, so any egress restriction would appear to work while blocking nothing.
The CNI is fixed at creation time and cannot be changed in place.

Recreate the cluster:

    minikube delete -p $MINIKUBE_PROFILE
    ./deploy/local/setup-local.sh

or re-run with --recreate to do it automatically. Either way this DESTROYS the
cluster, including the local PostgreSQL volume. 'pnpm dev:bootstrap' regenerates
the seeded users and workflow fixtures afterwards.
EOF
    if [ "$RECREATE" != true ]; then
        exit 1
    fi
    echo "  --recreate given, deleting profile $MINIKUBE_PROFILE"
    minikube delete -p "$MINIKUBE_PROFILE"
    create_cluster
}

create_cluster() {
    echo "  creating cluster: ${MIN_MEMORY_GB}GB / ${MIN_CPU_CORES} CPU / ${MIN_DISK_GB}GB disk / $CNI"
    # Deliberately no --addons=ingress here. See ensure_ingress_addon: the
    # addon's admission Jobs race the CNI and fail if they start first, which
    # leaves the ingress controller wedged. The addon is enabled after calico
    # reports Ready instead.
    minikube -p "$MINIKUBE_PROFILE" start \
        --driver=docker \
        --cni="$CNI" \
        --memory="${MIN_MEMORY_GB}g" \
        --cpus="$MIN_CPU_CORES" \
        --disk-size="${MIN_DISK_GB}g" \
        --kubernetes-version=stable

    kube wait --for=condition=Ready nodes --all --timeout=300s
    kube wait --for=condition=Ready pods -l k8s-app=calico-node -n kube-system --timeout=300s
}

start_minikube() {
    section "Starting minikube"

    local state="absent"
    if minikube -p "$MINIKUBE_PROFILE" status 2>/dev/null | grep -q "Running"; then
        state="running"
    elif minikube -p "$MINIKUBE_PROFILE" status 2>/dev/null | grep -q "Stopped"; then
        state="stopped"
    fi

    case "$state" in
        running)
            echo "  cluster already running"
            ;;
        stopped)
            # Reuses the profile's stored configuration, which is what we want.
            echo "  cluster stopped, starting it"
            if ! minikube -p "$MINIKUBE_PROFILE" start; then
                echo "Failed to restart the stopped cluster." >&2
                exit 1
            fi
            kube wait --for=condition=Ready nodes --all --timeout=300s
            ;;
        *)
            create_cluster
            ;;
    esac

    # Applies to every path above, including a cluster that was merely restarted.
    if ! cni_present; then
        refuse_or_recreate
    fi

    ensure_ingress_addon
    ok "cluster ready with $CNI"
}

apply_namespace() {
    section "Applying namespace"
    kube apply -f "$REPO_ROOT/$PROFILE_DIR/namespace.yaml"
}

# cert-manager issues the app's certificate from the mkcert CA the developer's
# browser already trusts. A ClusterIssuer rather than a namespaced Issuer,
# because the common chart's certificate template emits issuerRef.kind:
# ClusterIssuer unconditionally. clusterResourceNamespace points cert-manager at
# the namespace holding the CA secret.
setup_ssl() {
    section "Setting up TLS"

    local ca_root ca_cert ca_key
    ca_root=$(mkcert -CAROOT)
    ca_cert="$ca_root/rootCA.pem"
    ca_key="$ca_root/rootCA-key.pem"

    if [ ! -f "$ca_cert" ]; then
        echo "  installing mkcert local CA (may prompt for your password)"
        mkcert -install
    fi
    if [ ! -f "$ca_cert" ] || [ ! -f "$ca_key" ]; then
        echo "mkcert CA files not found at $ca_root" >&2
        exit 1
    fi

    helm repo add jetstack https://charts.jetstack.io >/dev/null
    helm repo update jetstack >/dev/null

    helm upgrade --install cert-manager jetstack/cert-manager \
        --kube-context "$MINIKUBE_PROFILE" \
        --namespace "$NAMESPACE" \
        --version "$CERT_MANAGER_VERSION" \
        --set crds.enabled=true \
        --set "clusterResourceNamespace=$NAMESPACE" \
        --wait

    kube_ns create secret generic mkcert-ca \
        --from-file=tls.crt="$ca_cert" \
        --from-file=tls.key="$ca_key" \
        --dry-run=client -o yaml | kube apply -f -

    kube apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: mkcert-ca-issuer
spec:
  ca:
    secretName: mkcert-ca
EOF

    kube wait --for=condition=Ready clusterissuer/mkcert-ca-issuer --timeout=60s
    ok "mkcert-ca-issuer ready"
}

setup_database() {
    section "Setting up PostgreSQL"
    helm upgrade --install "$PG_RELEASE" \
        oci://registry-1.docker.io/bitnamicharts/postgresql \
        --kube-context "$MINIKUBE_PROFILE" \
        --namespace "$NAMESPACE" \
        --version "$POSTGRES_CHART_VERSION" \
        --set "auth.username=$PG_USER" \
        --set "auth.password=$PG_PASSWORD" \
        --set auth.database=local \
        --set "auth.postgresPassword=$PG_PASSWORD" \
        --set image.registry=docker.io \
        --set "image.repository=$POSTGRES_IMAGE_REPO" \
        --set "image.tag=$POSTGRES_IMAGE_TAG" \
        --wait

    kube wait --for=condition=Ready pods \
        -l app.kubernetes.io/name=postgresql -n "$NAMESPACE" --timeout=300s
    ok "postgresql ready"
}

psql_admin() {
    kube_ns exec "${PG_RELEASE}-0" -- \
        env "PGPASSWORD=$PG_PASSWORD" psql -U postgres -tAc "$1"
}

psql_admin_db() {
    kube_ns exec "${PG_RELEASE}-0" -- \
        env "PGPASSWORD=$PG_PASSWORD" psql -U postgres -d "$PG_DATABASE" -tAc "$1"
}

# A database bootstrapped with 'db:push' has the full schema but an empty
# drizzle journal, so 'db:migrate' replays migration 0000 and dies on "relation
# already exists". Detect it and stop, rather than silently mutating a database
# the developer may care about. Same signal queryJournalDriftState uses.
check_migration_drift() {
    local users_exists journal_count
    users_exists=$(psql_admin_db "SELECT to_regclass('public.users') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')
    if [ "$users_exists" != "t" ]; then
        return 0
    fi
    journal_count=$(psql_admin_db \
        "SELECT COALESCE((SELECT count(*) FROM drizzle.__drizzle_migrations), 0);" 2>/dev/null | tr -d '[:space:]')
    if [ "${journal_count:-0}" != "0" ]; then
        return 0
    fi

    cat >&2 <<EOF

The '$PG_DATABASE' database has application tables but an empty drizzle journal.
That is the signature of a database bootstrapped with 'pnpm db:push'. The local
stack now applies file-based migrations, matching staging and prod, and
'db:migrate' would fail on this database with "relation already exists".

Pick one:

  1. Start clean (recommended). A fresh database is the correct starting state,
     and 'pnpm dev:bootstrap' regenerates the seeded users and fixtures:

         ./deploy/local/setup-local.sh --reset-db

  2. Keep the data and mark the existing migrations as applied:

         make local-db-recover

EOF
    exit 1
}

create_keeperhub_db() {
    section "Preparing the $PG_DATABASE database"

    if [ "$RESET_DB" = true ]; then
        echo "  --reset-db given, dropping $PG_DATABASE"
        psql_admin "DROP DATABASE IF EXISTS $PG_DATABASE;" >/dev/null
    fi

    if [ "$(psql_admin "SELECT 1 FROM pg_database WHERE datname='$PG_DATABASE';" | tr -d '[:space:]')" != "1" ]; then
        psql_admin "CREATE DATABASE $PG_DATABASE;" >/dev/null
        ok "created database $PG_DATABASE"
    else
        ok "database $PG_DATABASE exists"
    fi

    # drizzle-kit migrate creates its own 'drizzle' schema, so the app role needs
    # CREATE on the database as well as rights inside public.
    psql_admin "GRANT ALL PRIVILEGES ON DATABASE $PG_DATABASE TO $PG_USER;" >/dev/null
    psql_admin_db "GRANT ALL ON SCHEMA public TO $PG_USER;" >/dev/null
    psql_admin_db "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $PG_USER;" >/dev/null

    check_migration_drift
}

# Migrations are NOT run here. They run in the app's db-migration initContainer
# from the migrator image, which is the same thing staging and prod do, so the
# local stack exercises the real migration path rather than a host-side shortcut.
setup_queue() {
    section "Setting up the queue (ElasticMQ)"
    kube apply -f "$REPO_ROOT/$PROFILE_DIR/elasticmq.yaml"
    kube wait --for=condition=Available deployment/elasticmq \
        -n "$NAMESPACE" --timeout=180s
    ok "elasticmq ready at $AWS_ENDPOINT_URL"
    echo "  queue: $SQS_QUEUE_URL"
}

main() {
    check_prerequisites
    check_resources
    start_minikube
    apply_namespace
    setup_ssl
    setup_database
    setup_queue
    create_keeperhub_db

    cat <<EOF

== Local infrastructure ready

  PostgreSQL   $PG_HOST (database: $PG_DATABASE)
  Queue        $SQS_QUEUE_URL
  TLS          ClusterIssuer mkcert-ca-issuer (browser-trusted)
  CNI          $CNI (NetworkPolicy is enforced)

Next:
  1. minikube tunnel            # in another terminal
  2. echo "\$(minikube -p $MINIKUBE_PROFILE ip) $APP_HOST" | sudo tee -a /etc/hosts
  3. make deploy-to-local-kubernetes

KeeperHub will be at https://$APP_HOST/
EOF
}

main
