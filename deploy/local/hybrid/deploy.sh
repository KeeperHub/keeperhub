#!/bin/bash
# =============================================================================
# Hybrid Mode Deployment Script
#
# Deploys only the scheduler components (executor) to Minikube,
# connecting to Docker Compose services running on the host.
#
# Prerequisites:
#   - Docker Compose services running: docker compose --profile minikube up -d
#   - Minikube running: minikube start --memory=4096 --cpus=2
#
# Usage:
#   ./deploy/local/hybrid/deploy.sh [OPTIONS]
#
# Options:
#   --build       Build and load images before deploying
#   --teardown    Remove the deployment
#   --status      Show deployment status
#   --help        Show this help message
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NAMESPACE="local"

log_info() { echo "[INFO] $1"; }
log_warn() { echo "[WARN] $1"; }
log_error() { echo "[ERROR] $1"; }

show_help() {
    head -25 "$0" | tail -20
    exit 0
}

check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check Minikube
    if ! minikube status &>/dev/null; then
        log_error "Minikube is not running. Start it with: minikube start --memory=4096 --cpus=2"
        exit 1
    fi

    # Check Docker Compose services
    if ! docker compose --profile minikube ps --quiet 2>/dev/null | grep -q .; then
        log_warn "Docker Compose services may not be running."
        log_warn "Start them with: docker compose --profile minikube up -d"
        if [ -t 0 ]; then
            read -p "Continue anyway? [y/N] " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                exit 1
            fi
        fi
    fi

    # Check /etc/hosts entry (required for minikube to reach Docker Compose services)
    if ! grep -q "host.minikube.internal" /etc/hosts 2>/dev/null; then
        log_error "host.minikube.internal not found in /etc/hosts"
        log_error "Run: echo '127.0.0.1 host.minikube.internal' | sudo tee -a /etc/hosts"
        exit 1
    fi

    # Check kubectl context
    CURRENT_CONTEXT=$(kubectl config current-context 2>/dev/null || echo "none")
    if [[ "$CURRENT_CONTEXT" != "minikube" ]]; then
        log_warn "kubectl context is '$CURRENT_CONTEXT', switching to minikube..."
        kubectl config use-context minikube
    fi

    log_info "Prerequisites OK"
}

create_namespace() {
    if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
        log_info "Creating namespace '$NAMESPACE'..."
        kubectl create namespace "$NAMESPACE"
    fi
}

build_and_load_images() {
    log_info "Building images on host Docker and loading into minikube..."

    cd "$PROJECT_ROOT"

    log_info "Building keeperhub-executor:latest..."
    docker build --target executor -t keeperhub-executor:latest .

    log_info "Building keeperhub-runner:latest..."
    docker build --target workflow-runner -t keeperhub-runner:latest .

    log_info "Loading images into minikube..."
    minikube image load keeperhub-executor:latest
    minikube image load keeperhub-runner:latest

    log_info "Images built and loaded into minikube"
}

generate_manifest() {
    local ENCRYPTION_KEY="${INTEGRATION_ENCRYPTION_KEY:-$(openssl rand -hex 32 2>/dev/null || echo '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')}"
    local ENCRYPTION_KEY_BASE64
    ENCRYPTION_KEY_BASE64=$(echo -n "$ENCRYPTION_KEY" | base64 -w0)

    if [ -f "$PROJECT_ROOT/.env" ]; then
        INTEGRATION_ENCRYPTION_KEY=$(grep -E '^INTEGRATION_ENCRYPTION_KEY=' "$PROJECT_ROOT/.env" | head -1 | cut -d= -f2-)
        POSTGRES_DB=$(grep -E '^POSTGRES_DB=' "$PROJECT_ROOT/.env" | head -1 | cut -d= -f2-)
    fi

    local DB_NAME="${POSTGRES_DB:-keeperhub}"

    log_info "Using encryption key (first 8 chars): ${ENCRYPTION_KEY:0:8}..."
    log_info "Using database: $DB_NAME"

    cat > "$SCRIPT_DIR/schedule-trigger-hybrid.yaml" << EOF
# Executor Components for KeeperHub (Hybrid Mode)
# Connects to Docker Compose services via host.minikube.internal
---
apiVersion: v1
kind: Secret
metadata:
  name: keeperhub-secrets
  namespace: local
type: Opaque
data:
  integration-encryption-key: $ENCRYPTION_KEY_BASE64
EOF

    cat >> "$SCRIPT_DIR/schedule-trigger-hybrid.yaml" << 'EOF'
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: executor-env
  namespace: local
data:
  AWS_ENDPOINT_URL: "http://host.minikube.internal:4566"
  AWS_REGION: "us-east-1"
  AWS_ACCESS_KEY_ID: "test"
  AWS_SECRET_ACCESS_KEY: "test"
  SQS_QUEUE_URL: "http://host.minikube.internal:4566/000000000000/keeperhub-workflow-queue"
  DATABASE_URL: "postgresql://postgres:postgres@host.minikube.internal:5433/__DB_NAME__"
  KEEPERHUB_API_URL: "http://host.minikube.internal:3000"
  INTERNAL_SERVICE_HMAC_SECRET: "bG9jYWwtZGV2LWludGVybmFsLXNlcnZpY2UtaG1hYzA="
  RUNNER_IMAGE: "keeperhub-runner:latest"
  IMAGE_PULL_POLICY: "Never"
  K8S_NAMESPACE: "local"
  HEALTH_PORT: "3080"
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: executor
  namespace: local
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: executor-role
  namespace: local
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "watch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: executor-binding
  namespace: local
subjects:
  - kind: ServiceAccount
    name: executor
    namespace: local
roleRef:
  kind: Role
  name: executor-role
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: executor
  namespace: local
  labels:
    app: executor
spec:
  replicas: 1
  selector:
    matchLabels:
      app: executor
  template:
    metadata:
      labels:
        app: executor
    spec:
      serviceAccountName: executor
      containers:
        - name: executor
          image: keeperhub-executor:latest
          imagePullPolicy: Never
          envFrom:
            - configMapRef:
                name: executor-env
          env:
            - name: INTEGRATION_ENCRYPTION_KEY
              valueFrom:
                secretKeyRef:
                  name: keeperhub-secrets
                  key: integration-encryption-key
          ports:
            - containerPort: 3080
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "1Gi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /health
              port: 3080
            initialDelaySeconds: 30
            periodSeconds: 30
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health
              port: 3080
            initialDelaySeconds: 10
            periodSeconds: 10
EOF

    sed -i "s/__DB_NAME__/$DB_NAME/g" "$SCRIPT_DIR/schedule-trigger-hybrid.yaml"

    log_info "Generated hybrid manifest: $SCRIPT_DIR/schedule-trigger-hybrid.yaml"
}

deploy_executor() {
    log_info "Deploying executor to Minikube..."

    generate_manifest
    kubectl apply -f "$SCRIPT_DIR/schedule-trigger-hybrid.yaml"

    log_info "Executor deployed successfully"

    log_info "Waiting for executor to be ready..."
    kubectl rollout status deployment/executor -n "$NAMESPACE" --timeout=120s || {
        log_warn "Executor may not be fully ready yet. Check logs with: kubectl logs -n local -l app=executor"
    }
}

teardown() {
    log_info "Removing hybrid deployment..."

    if [ -f "$SCRIPT_DIR/schedule-trigger-hybrid.yaml" ]; then
        kubectl delete -f "$SCRIPT_DIR/schedule-trigger-hybrid.yaml" --ignore-not-found=true
        rm -f "$SCRIPT_DIR/schedule-trigger-hybrid.yaml"
        log_info "Scheduler components removed"
    else
        # Try to delete by name
        kubectl delete deployment -n "$NAMESPACE" executor --ignore-not-found=true
        kubectl delete configmap -n "$NAMESPACE" executor-env --ignore-not-found=true
        kubectl delete secret -n "$NAMESPACE" keeperhub-secrets --ignore-not-found=true
        kubectl delete serviceaccount -n "$NAMESPACE" executor --ignore-not-found=true
        kubectl delete role -n "$NAMESPACE" executor-role --ignore-not-found=true
        kubectl delete rolebinding -n "$NAMESPACE" executor-binding --ignore-not-found=true
        log_info "Executor components removed (by name)"
    fi
}

show_status() {
    echo ""
    log_info "=== Hybrid Mode Status ==="
    echo ""

    echo "Minikube:"
    minikube status 2>/dev/null || echo "  Not running"
    echo ""

    echo "Docker Compose (minikube profile):"
    docker compose --profile minikube ps 2>/dev/null || echo "  Not running"
    echo ""

    echo "Executor (Deployment):"
    kubectl get pods -n "$NAMESPACE" -l app=executor 2>/dev/null || echo "  Not found"
    echo ""
    echo "Workflow Runner Jobs:"
    kubectl get jobs -n "$NAMESPACE" -l app=workflow-runner --sort-by=.metadata.creationTimestamp 2>/dev/null | tail -5 || echo "  No jobs"
    echo ""
}

# =============================================================================
# Main
# =============================================================================

case "${1:-}" in
    --help|-h)
        show_help
        ;;
    --build)
        check_prerequisites
        create_namespace
        build_and_load_images
        deploy_executor
        show_status
        ;;
    --teardown)
        teardown
        ;;
    --status)
        show_status
        ;;
    *)
        check_prerequisites
        create_namespace
        deploy_executor
        show_status
        ;;
esac

echo ""
log_info "=== Hybrid Mode Usage ==="
echo ""
echo "  App:          http://localhost:3000"
echo ""
echo "  Dispatchers (Docker Compose) send triggers to SQS."
echo "  Executor (Minikube) polls SQS and runs workflows (in-process or K8s Job)."
echo ""
echo "  View executor logs:"
echo "    kubectl logs -n $NAMESPACE -l app=executor -f"
echo "  View workflow runner job logs:"
echo "    kubectl logs -n $NAMESPACE -l app=workflow-runner --tail=50"
echo ""
