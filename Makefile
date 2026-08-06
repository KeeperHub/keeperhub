.DEFAULT_GOAL := help
.PHONY: help install dev build type-check lint fix deploy-to-local-kubernetes setup-local-kubernetes check-local-kubernetes status logs restart teardown db-create local-db-migrate local-db-recover db-studio executor-status executor-logs schedule-logs runner-logs queue-status test test-unit test-integration test-e2e test-e2e-hybrid test-playwright test-playwright-report hybrid-setup hybrid-up hybrid-deploy hybrid-deploy-only hybrid-status hybrid-down hybrid-reset hybrid-logs dev-setup dev-up dev-down dev-logs dev-migrate

# Development
install:
	pnpm install

dev:
	pnpm dev

build:
	pnpm build

type-check:
	pnpm type-check

lint:
	pnpm lint

fix:
	pnpm fix

# Local Kubernetes Deployment
setup-local-kubernetes:
	chmod +x ./deploy/local/setup-local.sh
	./deploy/local/setup-local.sh

check-local-kubernetes:
	@chmod +x ./deploy/local/setup-local.sh
	@./deploy/local/setup-local.sh --check

deploy-to-local-kubernetes: check-local-kubernetes
	chmod +x ./deploy/local/deploy.sh
	./deploy/local/deploy.sh

deploy-to-local-kubernetes-skip-build: check-local-kubernetes
	chmod +x ./deploy/local/deploy.sh
	./deploy/local/deploy.sh --skip-build

# Every target below pins --context. The local cluster runs in its own minikube
# profile, and a bare kubectl would target whatever context happens to be
# current, which on a machine with real cluster access is not the local one.
KUBE_CONTEXT ?= keeperhub
KUBECTL := kubectl --context $(KUBE_CONTEXT) -n local
# Not 5433: docker-compose publishes its own postgres there, and a port-forward
# that loses the bind race fails silently while anything connecting to
# localhost:5433 quietly reaches the compose database instead of the cluster one.
# Keep in sync with PG_LOCAL_PORT in deploy/local/lib/common.sh.
PG_LOCAL_PORT ?= 5434
LOCAL_DB_URL := postgresql://local:local@localhost:$(PG_LOCAL_PORT)/keeperhub

status:
	@echo "=== Pods ==="
	@$(KUBECTL) get pods -l app.kubernetes.io/instance=keeperhub
	@echo ""
	@echo "=== Queue ==="
	@$(KUBECTL) get pods -l app=elasticmq
	@echo ""
	@echo "=== Services ==="
	@$(KUBECTL) get svc -l app.kubernetes.io/instance=keeperhub
	@echo ""
	@echo "=== Ingress ==="
	@$(KUBECTL) get ingress

logs:
	$(KUBECTL) logs -l app.kubernetes.io/instance=keeperhub -f

restart:
	$(KUBECTL) rollout restart deployment/keeperhub-app

teardown:
	helm uninstall keeperhub --kube-context $(KUBE_CONTEXT) -n local || true

# Database Operations
db-create:
	@echo "Creating keeperhub database..."
	$(KUBECTL) exec postgresql-0 -- bash -c 'PGPASSWORD=local psql -U postgres -c "CREATE DATABASE keeperhub;"' 2>/dev/null || echo "Database keeperhub already exists"
	$(KUBECTL) exec postgresql-0 -- bash -c 'PGPASSWORD=local psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE keeperhub TO local;"'

# Migrations normally run in the app's db-migration initContainer on deploy, the
# same way staging and prod apply them. This target is for applying them by hand
# against the local database without a full redeploy.
local-db-migrate:
	@echo "Applying migrations over a port-forward..."
	@$(KUBECTL) port-forward svc/postgresql $(PG_LOCAL_PORT):5432 & \
	PF_PID=$$!; \
	sleep 3; \
	DATABASE_URL="$(LOCAL_DB_URL)" pnpm db:migrate; \
	kill $$PF_PID 2>/dev/null || true
	@echo "Migrations complete."

# For a database originally bootstrapped with 'db:push', which has the schema but
# an empty drizzle journal. Marks the existing migrations as applied without
# re-running their SQL, so subsequent 'db:migrate' calls apply only new files.
# Over the port-forward the host is localhost, so the script's own safety guard
# passes without ALLOW_REMOTE.
local-db-recover:
	@echo "Backfilling the drizzle journal for an existing local database..."
	@$(KUBECTL) port-forward svc/postgresql $(PG_LOCAL_PORT):5432 & \
	PF_PID=$$!; \
	sleep 3; \
	DATABASE_URL="$(LOCAL_DB_URL)" pnpm tsx scripts/backfill-drizzle-migrations.ts; \
	kill $$PF_PID 2>/dev/null || true
	@echo "Journal backfilled. Re-run 'make deploy-to-local-kubernetes'."

db-studio:
	@echo "Starting Drizzle Studio..."
	pnpm db:studio

executor-status:
	@echo "=== Executor ==="
	@$(KUBECTL) get pods -l app.kubernetes.io/name=executor
	@echo ""
	@echo "=== Workflow Runner Jobs ==="
	@$(KUBECTL) get jobs -l app=workflow-runner --sort-by=.metadata.creationTimestamp | tail -10 || echo "No workflow jobs"

executor-logs:
	@echo "=== Executor Logs ==="
	@$(KUBECTL) logs -l app.kubernetes.io/name=executor --tail=100 -f

schedule-logs:
	@echo "=== Schedule Dispatcher Logs ==="
	@$(KUBECTL) logs -l app.kubernetes.io/name=schedule --tail=100 -f

runner-logs:
	@echo "=== Recent Workflow Runner Job Logs ==="
	@$(KUBECTL) logs -l app=workflow-runner --tail=100 2>/dev/null || echo "No runner logs available"

# Queue inspection. The queue URL is bound into the message signature, so if the
# executor is rejecting messages as bad_signature, compare what this prints
# against SQS_QUEUE_URL in deploy/local/lib/common.sh.
queue-status:
	@$(KUBECTL) exec deploy/elasticmq -- wget -q -O- http://localhost:9325/statistics/queues

# Testing
test:
	pnpm test

test-unit:
	pnpm test -- --run tests/unit/

test-integration:
	pnpm test -- --run tests/integration/

test-e2e:
	@echo "Running E2E tests against local kubernetes..."
	@$(KUBECTL) port-forward svc/postgresql $(PG_LOCAL_PORT):5432 & PF_PID_DB=$$!; \
	$(KUBECTL) port-forward svc/elasticmq 9324:9324 & PF_PID_SQS=$$!; \
	sleep 3; \
	DATABASE_URL="$(LOCAL_DB_URL)" \
	AWS_ENDPOINT_URL="http://localhost:9324" \
	SQS_QUEUE_URL="http://localhost:9324/000000000000/keeperhub-workflow-queue" \
	KEEPERHUB_API_URL="https://workflow.keeperhub.local" \
	pnpm test -- --run tests/e2e/; \
	kill $$PF_PID_DB 2>/dev/null || true; \
	kill $$PF_PID_SQS 2>/dev/null || true

test-playwright:
	@echo "Building and testing with Playwright (mirrors CI)..."
	@echo "Checking database is running..."
	@docker compose exec -T db pg_isready -U postgres > /dev/null 2>&1 || (echo "Error: Database not running. Run 'make dev-up' first." && exit 1)
	pnpm discover-plugins
	pnpm build
	@echo "Starting production server..."
	@pnpm start & APP_PID=$$!; \
	for i in $$(seq 1 30); do \
		if curl -sf http://localhost:3000 > /dev/null 2>&1; then \
			echo "App is ready"; \
			break; \
		fi; \
		if [ $$i -eq 30 ]; then \
			echo "App did not start in 60s"; \
			kill $$APP_PID 2>/dev/null || true; \
			exit 1; \
		fi; \
		sleep 2; \
	done; \
	pnpm test:e2e; \
	TEST_EXIT=$$?; \
	kill $$APP_PID 2>/dev/null || true; \
	if [ $$TEST_EXIT -ne 0 ]; then \
		echo ""; \
		echo "Tests failed. View report: pnpm exec playwright show-report"; \
	else \
		echo ""; \
		echo "All tests passed. View report: pnpm exec playwright show-report"; \
	fi; \
	exit $$TEST_EXIT

test-playwright-report:
	pnpm exec playwright show-report

test-e2e-hybrid:
	@echo "Running E2E tests against hybrid deployment (Docker Compose + Minikube)..."
	@echo "Checking services are running..."
	@docker compose ps --format '{{.Service}} {{.State}}' | grep -q "db running" || (echo "Error: Database not running. Run 'make hybrid-up' first." && exit 1)
	@docker compose ps --format '{{.Service}} {{.State}}' | grep -q "localstack running" || (echo "Error: LocalStack not running. Run 'make hybrid-up' first." && exit 1)
	@echo "Services OK. Running tests..."
	DATABASE_URL="postgresql://postgres:postgres@localhost:5433/keeperhub" \
	AWS_ENDPOINT_URL="http://localhost:4566" \
	SQS_QUEUE_URL="http://localhost:4566/000000000000/keeperhub-workflow-queue" \
	pnpm test -- --run tests/e2e/

# =============================================================================
# Docker Compose - Dev Profile (No K8s Jobs)
# =============================================================================

dev-up:
	@echo "Starting dev profile..."
	docker compose --profile dev up -d
	@echo ""
	@echo "Services started:"
	@echo "  - db (PostgreSQL)"
	@echo "  - localstack (SQS)"
	@echo "  - redis (caching + event sync)"
	@echo "  - app-dev (KeeperHub)"
	@echo "  - dispatcher (schedule polling)"
	@echo "  - executor (unified SQS consumer)"
	@echo "  - block-dispatcher (blockchain block monitoring)"
	@echo "  - event-tracker (blockchain event monitoring)"
	@echo ""
	@echo "App: http://localhost:3000"

dev-down:
	docker compose --profile dev down

dev-logs:
	docker compose --profile dev logs -f

dev-migrate:
	docker compose --profile dev --profile migrator run --rm migrator

dev-setup:
	@echo "Setting up dev environment (first time)..."
	docker compose --profile dev up -d
	@echo "Waiting for services to be healthy..."
	@sleep 5
	@echo "Running database migrations..."
	docker compose --profile dev --profile migrator run --rm migrator
	@echo ""
	@echo "Dev environment ready!"
	@echo "  App: http://localhost:3000"
	@echo ""
	@echo "For subsequent starts, use: make dev-up"

# =============================================================================
# Hybrid Mode (Docker Compose + Minikube for isolated workflow execution)
# =============================================================================

hybrid-setup:
	# Full setup: prerequisites, /etc/hosts, Docker Compose, Minikube, executor
	chmod +x ./deploy/local/hybrid/setup.sh
	./deploy/local/hybrid/setup.sh

hybrid-up:
	# Start Docker Compose services (executor runs in Minikube)
	docker compose --profile minikube up -d
	@echo "Docker Compose services started. Now deploy executor to Minikube:"
	@echo "  make hybrid-deploy"

hybrid-deploy:
	# Start Docker Compose services and deploy executor to Minikube
	@echo "Starting Docker Compose services..."
	docker compose --profile minikube up -d
	# Wait for database to be ready
	@echo "Waiting for database to be ready..."
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if docker compose exec -T db pg_isready -U postgres > /dev/null 2>&1; then \
			echo "Database is ready!"; \
			break; \
		fi; \
		if [ $$i -eq 10 ]; then \
			echo "Error: Database not ready after 10 attempts."; \
			exit 1; \
		fi; \
		echo "Waiting for database... (attempt $$i/10)"; \
		sleep 2; \
	done
	# Run database migrations and seed chains
	@echo "Setting up database schema and seeding chains..."
	@DATABASE_URL="postgresql://postgres:postgres@localhost:5433/$${POSTGRES_DB:-keeperhub}" pnpm db:push || echo "Schema push completed (or already up to date)"
	@DATABASE_URL="postgresql://postgres:postgres@localhost:5433/$${POSTGRES_DB:-keeperhub}" npx tsx scripts/seed/seed-chains.ts || echo "Chains seeded (or already exist)"
	# Deploy executor to Minikube (builds images on host, loads into minikube)
	chmod +x ./deploy/local/hybrid/deploy.sh
	./deploy/local/hybrid/deploy.sh --build

hybrid-deploy-only:
	# Deploy executor to Minikube (skip image build, skip db setup)
	chmod +x ./deploy/local/hybrid/deploy.sh
	./deploy/local/hybrid/deploy.sh

hybrid-status:
	# Show status of hybrid deployment
	chmod +x ./deploy/local/hybrid/deploy.sh
	./deploy/local/hybrid/deploy.sh --status

hybrid-down:
	# Teardown hybrid deployment
	chmod +x ./deploy/local/hybrid/deploy.sh
	./deploy/local/hybrid/deploy.sh --teardown
	docker compose --profile minikube down

hybrid-reset:
	# Full reset: teardown, remove volumes, rebuild, and restart
	@echo "Tearing down hybrid deployment..."
	-./deploy/local/hybrid/deploy.sh --teardown 2>/dev/null || true
	docker compose --profile minikube down -v
	@echo "Rebuilding and starting fresh..."
	docker compose --profile minikube up -d
	@echo "Waiting for services to be ready..."
	@sleep 10
	@echo "Running database migrations..."
	@DATABASE_URL="postgresql://postgres:postgres@localhost:5433/$${POSTGRES_DB:-keeperhub}" pnpm db:push || true
	@echo "Deploying executor to Minikube..."
	./deploy/local/hybrid/deploy.sh --build
	@echo ""
	@echo "Hybrid reset complete!"
	@echo "  App: http://localhost:3000"

hybrid-logs:
	# Follow executor logs in Minikube
	kubectl logs -n local -l app=executor -f

# Help
help:
	@echo "KeeperHub Development Commands"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@echo ""
	@echo "  Development:"
	@echo "    install                    - Install dependencies"
	@echo "    dev                        - Start development server (local)"
	@echo "    build                      - Build for production"
	@echo "    type-check                 - Run TypeScript type checking"
	@echo "    lint                       - Run linter"
	@echo "    fix                        - Fix linting issues"
	@echo ""
	@echo "  Docker Compose - Dev Profile (no K8s Jobs, ~2-3GB RAM):"
	@echo "    dev-setup                  - First time setup (services + migrations)"
	@echo "    dev-up                     - Start dev profile (fast, no migrations)"
	@echo "    dev-down                   - Stop dev profile"
	@echo "    dev-logs                   - Follow dev profile logs"
	@echo "    dev-migrate                - Run database migrations manually"
	@echo ""
	@echo "  Hybrid Mode (Docker Compose + Minikube, ~4-5GB RAM):"
	@echo "    hybrid-setup               - Full setup (compose, minikube, executor)"
	@echo "    hybrid-up                  - Start Docker Compose services"
	@echo "    hybrid-deploy              - Build and deploy executor to Minikube"
	@echo "    hybrid-deploy-only         - Deploy executor (skip build)"
	@echo "    hybrid-status              - Show hybrid deployment status"
	@echo "    hybrid-down                - Teardown hybrid deployment"
	@echo "    hybrid-reset               - Full reset and restart"
	@echo "    hybrid-logs                - Follow executor logs in Minikube"
	@echo ""
	@echo "  Full Kubernetes (all in Minikube, ~8GB RAM):"
	@echo "    setup-local-kubernetes     - Setup minikube with all infrastructure"
	@echo "    check-local-kubernetes     - Quick check if environment is ready"
	@echo "    deploy-to-local-kubernetes - Build and deploy to minikube"
	@echo "    deploy-to-local-kubernetes-skip-build - Deploy without rebuilding"
	@echo "    status                     - Show pods and services status"
	@echo "    logs                       - Follow keeperhub pod logs"
	@echo "    restart                    - Restart keeperhub deployment"
	@echo "    teardown                   - Delete keeperhub resources from cluster"
	@echo ""
	@echo "  Database (Full K8s mode):"
	@echo "    db-create                  - Create keeperhub database in PostgreSQL"
	@echo "    local-db-migrate           - Apply migrations by hand (deploy does this too)"
	@echo "    local-db-recover           - Backfill the drizzle journal on a db:push database"
	@echo "    db-studio                  - Open Drizzle Studio"
	@echo ""
	@echo "  Pipeline (Full K8s mode):"
	@echo "    executor-status            - Show executor pods and workflow runner jobs"
	@echo "    executor-logs              - Follow executor logs"
	@echo "    schedule-logs              - Follow schedule dispatcher logs"
	@echo "    runner-logs                - Show workflow runner job logs"
	@echo "    queue-status               - Show ElasticMQ queue depths"
	@echo ""
	@echo "  Testing:"
	@echo "    test                       - Run all tests"
	@echo "    test-unit                  - Run unit tests"
	@echo "    test-integration           - Run integration tests"
	@echo "    test-playwright            - Build app, run Playwright E2E tests (mirrors CI)"
	@echo "    test-playwright-report     - Open last Playwright HTML report"
	@echo "    test-e2e                   - Run E2E tests against local kubernetes"
	@echo "    test-e2e-hybrid            - Run E2E tests against hybrid deployment"
	@echo ""
	@echo "Recommended workflow:"
	@echo "  1. For UI/API dev (no workflow testing): make dev-up"
	@echo "  2. For workflow testing with isolation:   make hybrid-setup"
	@echo "  3. For production-like testing:          make setup-local-kubernetes"
