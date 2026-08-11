# Docker Buildx Bake definition for parallel image builds.
# Used by deploy-keeperhub.yaml via docker/bake-action to build the "app" and
# "migrator" targets from our Dockerfile concurrently in a single BuildKit
# session. Shared Dockerfile stages (deps, source) are built once and reused
# across both targets, saving ~47s vs sequential build-push-action steps.
# Variables are passed as env vars from the GHA workflow.
# Docs: https://docs.docker.com/build/bake/reference/

variable "ECR_REGISTRY" { default = "" }
variable "ECR_REPO" { default = "" }
variable "IMAGE_TAG" { default = "latest" }
variable "NEXT_PUBLIC_AUTH_PROVIDERS" { default = "" }
variable "NEXT_PUBLIC_GITHUB_CLIENT_ID" { default = "" }
variable "NEXT_PUBLIC_GOOGLE_CLIENT_ID" { default = "" }
variable "NEXT_PUBLIC_BILLING_ENABLED" { default = "" }
variable "NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED" { default = "" }
variable "NEXT_PUBLIC_SCAN_ENABLED" { default = "" }
variable "NEXT_PUBLIC_TURNSTILE_SITE_KEY" { default = "" }
variable "ENVIRONMENT_TAG" { default = "" }
variable "NEXT_PUBLIC_SENTRY_DSN" { default = "" }
variable "SENTRY_ORG" { default = "" }
variable "SENTRY_PROJECT" { default = "" }
variable "SENTRY_AUTH_TOKEN" { default = "" }
variable "SENTRY_RELEASE" { default = "" }
variable "INCLUDE_TEST_ENDPOINTS" { default = "" }
variable "EVENTS_ECR_TRACKER_REPO" { default = "" }
variable "SCHEDULER_ECR_REPO" { default = "" }
variable "EXECUTOR_ECR_REPO" { default = "" }
variable "SANDBOX_ECR_REPO" { default = "" }
variable "METRICS_COLLECTOR_ECR_REPO" { default = "" }

group "default" {
  targets = ["app", "migrator", "workflow-runner"]
}

group "events" {
  targets = ["event-tracker", "solana-tracker"]
}

group "scheduler" {
  targets = ["schedule-dispatcher", "block-dispatcher"]
}

group "sandbox" {
  targets = ["sandbox"]
}

group "metrics-collector" {
  targets = ["metrics-collector"]
}

# The execution pipeline deployed as one atomic keeperhub-stack release. Building
# these together in a single bake session shares the deps/source/builder stages
# (one pnpm build) instead of each deploy workflow rebuilding them independently.
group "pipeline" {
  targets = ["app", "migrator", "workflow-runner", "executor", "schedule-dispatcher", "block-dispatcher", "metrics-collector"]
}

group "all" {
  targets = ["app", "migrator", "workflow-runner", "event-tracker", "solana-tracker", "schedule-dispatcher", "block-dispatcher", "executor", "sandbox", "metrics-collector"]
}

target "app" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "runner"
  args = {
    NEXT_PUBLIC_AUTH_PROVIDERS    = NEXT_PUBLIC_AUTH_PROVIDERS
    NEXT_PUBLIC_GITHUB_CLIENT_ID = NEXT_PUBLIC_GITHUB_CLIENT_ID
    NEXT_PUBLIC_GOOGLE_CLIENT_ID = NEXT_PUBLIC_GOOGLE_CLIENT_ID
    NEXT_PUBLIC_BILLING_ENABLED  = NEXT_PUBLIC_BILLING_ENABLED
    NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED = NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED
    NEXT_PUBLIC_SCAN_ENABLED = NEXT_PUBLIC_SCAN_ENABLED
    NEXT_PUBLIC_TURNSTILE_SITE_KEY = NEXT_PUBLIC_TURNSTILE_SITE_KEY
    NEXT_PUBLIC_SENTRY_DSN       = NEXT_PUBLIC_SENTRY_DSN
    INCLUDE_TEST_ENDPOINTS       = INCLUDE_TEST_ENDPOINTS
  }
  tags = ECR_REGISTRY != "" ? compact([
    "${ECR_REGISTRY}/${ECR_REPO}:app-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${ECR_REPO}:app-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${ECR_REPO}:${ENVIRONMENT_TAG}" : "",
  ]) : []
  cache-from = ECR_REGISTRY != "" ? ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app"] : []
  cache-to   = ECR_REGISTRY != "" ? ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app,mode=max"] : []
}

target "sentry-upload" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "sentry-upload"
  args = {
    # NEXT_PUBLIC_* args must match the app target so BuildKit reuses
    # the cached builder layer instead of rebuilding with empty defaults
    NEXT_PUBLIC_AUTH_PROVIDERS    = NEXT_PUBLIC_AUTH_PROVIDERS
    NEXT_PUBLIC_GITHUB_CLIENT_ID = NEXT_PUBLIC_GITHUB_CLIENT_ID
    NEXT_PUBLIC_GOOGLE_CLIENT_ID = NEXT_PUBLIC_GOOGLE_CLIENT_ID
    NEXT_PUBLIC_BILLING_ENABLED  = NEXT_PUBLIC_BILLING_ENABLED
    NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED = NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED
    NEXT_PUBLIC_SCAN_ENABLED = NEXT_PUBLIC_SCAN_ENABLED
    NEXT_PUBLIC_TURNSTILE_SITE_KEY = NEXT_PUBLIC_TURNSTILE_SITE_KEY
    NEXT_PUBLIC_SENTRY_DSN       = NEXT_PUBLIC_SENTRY_DSN
    INCLUDE_TEST_ENDPOINTS       = INCLUDE_TEST_ENDPOINTS
    SENTRY_ORG                   = SENTRY_ORG
    SENTRY_PROJECT               = SENTRY_PROJECT
    SENTRY_AUTH_TOKEN            = SENTRY_AUTH_TOKEN
    SENTRY_RELEASE               = SENTRY_RELEASE
  }
  tags       = []
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app"]
}

target "migrator" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "migrator"
  tags = [
    "${ECR_REGISTRY}/${ECR_REPO}:migrator-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${ECR_REPO}:migrator-latest",
  ]
  cache-from = [
    "type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app",
    "type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-migrator",
  ]
  cache-to = ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-migrator,mode=max"]
}

target "workflow-runner" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "workflow-runner"
  # Args mirror "app" so BuildKit deduplicates the shared "builder" stage
  # across targets and runs `pnpm build` once. Divergent args here cause
  # parallel builder invocations that race on the .next/cache mount.
  args = {
    NEXT_PUBLIC_AUTH_PROVIDERS    = NEXT_PUBLIC_AUTH_PROVIDERS
    NEXT_PUBLIC_GITHUB_CLIENT_ID = NEXT_PUBLIC_GITHUB_CLIENT_ID
    NEXT_PUBLIC_GOOGLE_CLIENT_ID = NEXT_PUBLIC_GOOGLE_CLIENT_ID
    NEXT_PUBLIC_BILLING_ENABLED  = NEXT_PUBLIC_BILLING_ENABLED
    NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED = NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED
    NEXT_PUBLIC_SCAN_ENABLED = NEXT_PUBLIC_SCAN_ENABLED
    NEXT_PUBLIC_TURNSTILE_SITE_KEY = NEXT_PUBLIC_TURNSTILE_SITE_KEY
    NEXT_PUBLIC_SENTRY_DSN       = NEXT_PUBLIC_SENTRY_DSN
    INCLUDE_TEST_ENDPOINTS       = INCLUDE_TEST_ENDPOINTS
  }
  tags = compact([
    "${ECR_REGISTRY}/${ECR_REPO}:workflow-runner-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${ECR_REPO}:workflow-runner-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${ECR_REPO}:workflow-runner-${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = [
    "type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app",
    "type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-workflow-runner",
  ]
  cache-to = ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-workflow-runner,mode=max"]
  attest   = []
}

target "event-tracker" {
  context    = "./keeperhub-events"
  dockerfile = "event-tracker/Dockerfile"
  tags = compact([
    "${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:event-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:event-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:cache"]
  cache-to   = ["type=registry,ref=${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:cache,mode=max"]
  attest     = []
}

# Solana ingestion (event + block triggers). Shares the events ECR repo, so all
# tags/cache are "solana-" prefixed to avoid colliding with the event-tracker
# images. Final Dockerfile stage is "runtime", so no explicit target is needed.
target "solana-tracker" {
  context    = "./keeperhub-events"
  dockerfile = "solana-tracker/Dockerfile"
  tags = compact([
    "${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:solana-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:solana-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:solana-${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:cache-solana"]
  cache-to   = ["type=registry,ref=${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:cache-solana,mode=max"]
  attest     = []
}

target "schedule-dispatcher" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "schedule-dispatcher"
  tags = compact([
    "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:schedule-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:schedule-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:schedule-${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = [
    "type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-deps",
    "type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-dispatcher",
  ]
  cache-to = ["type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-dispatcher,mode=max"]
  attest   = []
}

target "block-dispatcher" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "block-dispatcher"
  tags = compact([
    "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:block-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:block-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:block-${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = [
    "type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-deps",
    "type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-block-dispatcher",
  ]
  cache-to = ["type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-block-dispatcher,mode=max"]
  attest   = []
}

target "executor" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "executor"
  # Args mirror "app" so BuildKit deduplicates the shared "builder" stage and
  # runs `pnpm build` once. Divergent args here fork the builder stage into a
  # second invocation that recompiles from scratch.
  args = {
    NEXT_PUBLIC_AUTH_PROVIDERS    = NEXT_PUBLIC_AUTH_PROVIDERS
    NEXT_PUBLIC_GITHUB_CLIENT_ID = NEXT_PUBLIC_GITHUB_CLIENT_ID
    NEXT_PUBLIC_GOOGLE_CLIENT_ID = NEXT_PUBLIC_GOOGLE_CLIENT_ID
    NEXT_PUBLIC_BILLING_ENABLED  = NEXT_PUBLIC_BILLING_ENABLED
    NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED = NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED
    NEXT_PUBLIC_SCAN_ENABLED = NEXT_PUBLIC_SCAN_ENABLED
    NEXT_PUBLIC_TURNSTILE_SITE_KEY = NEXT_PUBLIC_TURNSTILE_SITE_KEY
    NEXT_PUBLIC_SENTRY_DSN       = NEXT_PUBLIC_SENTRY_DSN
    INCLUDE_TEST_ENDPOINTS       = INCLUDE_TEST_ENDPOINTS
  }
  tags = compact([
    "${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:executor-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:executor-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:cache"]
  cache-to   = ["type=registry,ref=${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:cache,mode=max"]
  attest     = []
}

# v1.9 Code Sandbox standalone HTTP service. Runs user-supplied JS in a
# scrubbed child_process inside a dedicated Pod so main-pod secrets stay
# unreachable even on sandbox escape. Context is repo root because the
# Dockerfile needs pnpm-workspace.yaml and pnpm-lock.yaml from root.
target "sandbox" {
  context    = "."
  dockerfile = "sandbox/Dockerfile"
  tags = compact([
    "${ECR_REGISTRY}/${SANDBOX_ECR_REPO}:sandbox-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${SANDBOX_ECR_REPO}:sandbox-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${SANDBOX_ECR_REPO}:${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${SANDBOX_ECR_REPO}:cache"]
  cache-to   = ["type=registry,ref=${ECR_REGISTRY}/${SANDBOX_ECR_REPO}:cache,mode=max"]
  attest     = []
}

# Metrics collector (TECH-6484). Context is repo root because the stage reuses
# lib/ and the root node_modules. Tag prefix `collector-`.
target "metrics-collector" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "metrics-collector"
  tags = compact([
    "${ECR_REGISTRY}/${METRICS_COLLECTOR_ECR_REPO}:collector-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${METRICS_COLLECTOR_ECR_REPO}:collector-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${METRICS_COLLECTOR_ECR_REPO}:${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${METRICS_COLLECTOR_ECR_REPO}:cache"]
  cache-to   = ["type=registry,ref=${ECR_REGISTRY}/${METRICS_COLLECTOR_ECR_REPO}:cache,mode=max"]
  attest     = []
}
