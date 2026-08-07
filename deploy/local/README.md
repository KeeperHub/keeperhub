# Full Kubernetes Local Deployment

All services run inside Minikube with Helm, SSL, and Ingress. This is the most production-like local setup but requires ~8GB RAM.

## Architecture

```
Minikube
  - KeeperHub app (Helm chart via techops-services/common)
  - PostgreSQL (Bitnami Helm chart)
  - LocalStack (SQS)
  - cert-manager (SSL via mkcert CA)
  - Ingress (nginx)
  - schedule-dispatcher (CronJob - polls DB, sends to SQS)
  -  (Deployment - polls SQS, executes via API)
```

## Prerequisites

- Docker
- Minikube
- kubectl
- Helm
- mkcert (for SSL certificates)

## Quick Start

```bash
# 1. Set up infrastructure (minikube, SSL, PostgreSQL, LocalStack, migrations)
make setup-local-kubernetes

# 2. Build app image and deploy with Helm
make deploy-to-local-kubernetes

# 3. Deploy scheduler components (dispatcher + executor)
make build-scheduler-images
make deploy-scheduler

# 4. Start minikube tunnel (separate terminal)
minikube tunnel

# 5. Access the app
#    https://workflow.keeperhub.local/
```

## Commands

| Command | Description |
|---------|-------------|
| `make setup-local-kubernetes` | Full infrastructure setup (one-time) |
| `make check-local-kubernetes` | Verify environment is ready |
| `make deploy-to-local-kubernetes` | Build and deploy app to Minikube |
| `make deploy-to-local-kubernetes-skip-build` | Deploy without rebuilding |
| `make build-scheduler-images` | Build dispatcher + executor images |
| `make deploy-scheduler` | Deploy scheduler components |
| `make status` | Show pods and services |
| `make logs` | Follow app logs |
| `make restart` | Restart app deployment |
| `make scheduler-status` | Show scheduler pods |
| `make scheduler-logs` | Follow executor logs |
| `make teardown` | Remove app from cluster |
| `make teardown-scheduler` | Remove scheduler components |

## Database

```bash
make db-create    # Create keeperhub database
make db-migrate   # Run migrations (via port-forward)
make db-studio    # Open Drizzle Studio
```

## Files

| File | Purpose |
|------|---------|
| `setup-local.sh` | Infrastructure setup (minikube, SSL, PostgreSQL, LocalStack) |
| `deploy.sh` | App build and Helm deployment |
| `schedule-trigger.yaml` | Scheduler K8s manifests (CronJob + Deployment) |
| `kubernetes-resources.yaml` | Namespace and Ingress definitions |
| `values-keeperhub.template.yaml` | Helm values template |
| `hybrid/` | Hybrid mode (Docker Compose + Minikube) |

## Comparison with Other Modes

| Mode | Memory | Where Services Run | Best For |
|------|--------|--------------------|----------|
| Docker Compose (`make dev-up`) | ~2-3GB | All in Docker | UI/API dev |
| Hybrid (`make hybrid-setup`) | ~4-5GB | Docker + Minikube executor | Scheduled workflow testing |
| **Full K8s (`make setup-local-kubernetes`)** | ~8GB | All in Minikube | Production-like testing |
