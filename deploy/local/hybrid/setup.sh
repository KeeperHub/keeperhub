#!/bin/bash
# =============================================================================
# Hybrid Mode Setup Script
#
# One-command setup for hybrid development mode (Docker Compose + Minikube).
# This script handles prerequisites, /etc/hosts entry, and starts all services.
#
# Usage:
#   ./deploy/local/hybrid/setup.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

log_info() { echo "[INFO] $1"; }
log_warn() { echo "[WARN] $1"; }
log_error() { echo "[ERROR] $1"; }

check_prerequisites() {
    log_info "Checking prerequisites..."
    local missing=0

    command -v docker >/dev/null 2>&1 || { log_error "docker is required but not installed"; missing=1; }
    command -v minikube >/dev/null 2>&1 || { log_error "minikube is required but not installed"; missing=1; }
    command -v kubectl >/dev/null 2>&1 || { log_error "kubectl is required but not installed"; missing=1; }

    if [ $missing -eq 1 ]; then
        log_error "Please install missing dependencies and try again"
        exit 1
    fi

    log_info "All prerequisites installed"
}

setup_hosts_entry() {
    log_info "Checking /etc/hosts entry..."

    if grep -q "host.minikube.internal" /etc/hosts 2>/dev/null; then
        log_info "host.minikube.internal already in /etc/hosts"
    else
        log_warn "host.minikube.internal not found in /etc/hosts"
        echo ""
        echo "For LocalStack SQS to work correctly, you need to add:"
        echo "  127.0.0.1 host.minikube.internal"
        echo ""
        echo "Run this command:"
        echo "  echo '127.0.0.1 host.minikube.internal' | sudo tee -a /etc/hosts"
        echo ""
        # Check if we're in an interactive terminal
        if [ -t 0 ]; then
            read -p "Would you like to add it now? (requires sudo) [y/N] " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                echo "127.0.0.1 host.minikube.internal" | sudo tee -a /etc/hosts
                log_info "Added host.minikube.internal to /etc/hosts"
            else
                log_warn "Skipping hosts entry - SQS may not work from host machine"
            fi
        else
            log_warn "Non-interactive mode - skipping hosts entry prompt"
            log_warn "Please add the hosts entry manually for full functionality"
        fi
    fi
}

start_docker_compose() {
    log_info "Starting Docker Compose services (minikube profile)..."
    cd "$PROJECT_ROOT"
    docker compose --profile minikube up -d
    log_info "Docker Compose services started"

    # Wait for services to be ready
    log_info "Waiting for services to be healthy..."
    sleep 5

    # Check if localstack is ready
    local retries=0
    while ! docker compose exec localstack awslocal sqs list-queues >/dev/null 2>&1; do
        retries=$((retries + 1))
        if [ $retries -gt 30 ]; then
            log_error "LocalStack failed to start"
            exit 1
        fi
        echo -n "."
        sleep 2
    done
    echo ""
    log_info "LocalStack is ready"
}

run_migrations() {
    log_info "Running database migrations..."
    cd "$PROJECT_ROOT"
    docker compose run --rm migrator || {
        log_warn "Migrations may have already been run or failed"
    }
}

start_minikube() {
    log_info "Starting Minikube..."

    if minikube status 2>/dev/null | grep -q "Running"; then
        log_info "Minikube is already running"
    else
        log_info "Starting new Minikube cluster..."
        minikube start --memory=4096 --cpus=2
    fi

    # Ensure kubectl context is set
    kubectl config use-context minikube >/dev/null 2>&1

    log_info "Minikube is ready"
}

deploy_executor() {
    log_info "Building images and deploying executor to Minikube..."
    "$SCRIPT_DIR/deploy.sh" --build
}

show_status() {
    echo ""
    log_info "=== Hybrid Mode Ready ==="
    echo ""
    echo "Services running in Docker Compose:"
    echo "  - db (PostgreSQL)"
    echo "  - localstack (SQS)"
    echo "  - redis (caching + event sync)"
    echo "  - app-dev (KeeperHub Next.js)"
    echo "  - dispatcher (schedule polling)"
    echo "  - event-tracker (blockchain event monitoring)"
    echo ""
    echo "Services running in Minikube:"
    echo ""
    echo "Access points:"
    echo "  App:  http://localhost:3000"
    echo ""
    echo "Commands:"
    echo "  make hybrid-status    - Show status"
    echo "  make hybrid-down      - Teardown everything"
    echo "  make hybrid-logs      - Follow executor logs"
    echo ""
}

main() {
    echo ""
    log_info "=== KeeperHub Hybrid Mode Setup ==="
    echo ""

    check_prerequisites
    setup_hosts_entry
    start_docker_compose
    run_migrations
    start_minikube
    deploy_executor
    show_status
}

main
