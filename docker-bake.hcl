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
# The /llms.txt redirect destination, baked by next.config.ts at build time.
# Defaults to today's value so a build that says nothing keeps production
# behaviour; an empty value drops the redirect. See the ARG in Dockerfile.
# Deliberately NOT plumbed through build-images.yml: a workflow passing an unset
# repository variable would send "" and quietly remove the redirect from prod.
variable "DOCS_BASE_URL" { default = "https://docs.keeperhub.com" }
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

# The per-commit sandbox tag, for example "sandbox-1a2b3c4". Empty by default, so
# only a caller that really needs the tag creates it. deploy-sandbox.yaml sets it,
# because its Helm values reference the image by that tag. The pipeline bake in
# build-images.yml leaves it empty and resolves the image by digest instead.
#
# Do not set this from a workflow that runs on every push. The sandbox Dockerfile
# copies a small, stable set of inputs, so the image digest does not change between
# commits, and since KEEP-1257 removed the attestation wrapper every push lands on
# the SAME image object. A per-commit tag there adds one more tag to that one image
# on every push. ECR allows 1000 tags per image and does not adjust that limit, so
# the push starts to fail once the count is reached. KEEP-1259.
variable "SANDBOX_COMMIT_TAG" { default = "" }

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

# Every target below sets `attest` explicitly, and a new target must set it too.
# docker/bake-action reads the resolved bake definition. For each target that
# declares no provenance entry, the action appends
# `--set <target>.attest=type=provenance,mode=max`. ECR indexes the pushed
# attestation as a referrer of the image, and it allows only 100 referrers per
# subject. The sandbox image digest does not change between commits, so its
# referrers reached 100 and every staging deploy failed for about 14 hours on
# 2026-08-29.
#
# Two forms look correct and do nothing. Do not use either one:
#   * `attest = []` is omitempty, so the key disappears from `docker buildx bake
#     --print`. The action then treats the target as undeclared and injects
#     provenance for it.
#   * `provenance = false` is not a bake attribute. Bake drops an unknown target
#     field without an error, so the line parses and has no effect.
# Only `attest = ["type=provenance,disabled=true"]` survives `--print`, which is
# what the "Bake Provenance Disabled" check in maintainability.yml asserts.

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
    DOCS_BASE_URL                = DOCS_BASE_URL
    INCLUDE_TEST_ENDPOINTS       = INCLUDE_TEST_ENDPOINTS
  }
  tags = ECR_REGISTRY != "" ? compact([
    "${ECR_REGISTRY}/${ECR_REPO}:app-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${ECR_REPO}:app-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${ECR_REPO}:${ENVIRONMENT_TAG}" : "",
  ]) : []
  cache-from = ECR_REGISTRY != "" ? ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app"] : []
  cache-to   = ECR_REGISTRY != "" ? ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app,mode=max"] : []
  attest     = ["type=provenance,disabled=true"]
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
    DOCS_BASE_URL                = DOCS_BASE_URL
    INCLUDE_TEST_ENDPOINTS       = INCLUDE_TEST_ENDPOINTS
    SENTRY_ORG                   = SENTRY_ORG
    SENTRY_PROJECT               = SENTRY_PROJECT
    SENTRY_AUTH_TOKEN            = SENTRY_AUTH_TOKEN
    SENTRY_RELEASE               = SENTRY_RELEASE
  }
  tags       = []
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app"]
  attest     = ["type=provenance,disabled=true"]
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
  attest   = ["type=provenance,disabled=true"]
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
    DOCS_BASE_URL                = DOCS_BASE_URL
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
  attest   = ["type=provenance,disabled=true"]
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
  attest     = ["type=provenance,disabled=true"]
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
  attest     = ["type=provenance,disabled=true"]
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
  attest   = ["type=provenance,disabled=true"]
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
  attest   = ["type=provenance,disabled=true"]
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
    DOCS_BASE_URL                = DOCS_BASE_URL
    INCLUDE_TEST_ENDPOINTS       = INCLUDE_TEST_ENDPOINTS
  }
  tags = compact([
    "${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:executor-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:executor-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:cache"]
  cache-to   = ["type=registry,ref=${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:cache,mode=max"]
  attest     = ["type=provenance,disabled=true"]
}

# v1.9 Code Sandbox standalone HTTP service. Runs user-supplied JS in a
# scrubbed child_process inside a dedicated Pod so main-pod secrets stay
# unreachable even on sandbox escape. Context is repo root because the
# Dockerfile needs pnpm-workspace.yaml and pnpm-lock.yaml from root.
target "sandbox" {
  context    = "."
  dockerfile = "sandbox/Dockerfile"
  tags = compact([
    SANDBOX_COMMIT_TAG != "" ? "${ECR_REGISTRY}/${SANDBOX_ECR_REPO}:${SANDBOX_COMMIT_TAG}" : "",
    "${ECR_REGISTRY}/${SANDBOX_ECR_REPO}:sandbox-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${SANDBOX_ECR_REPO}:${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${SANDBOX_ECR_REPO}:cache"]
  cache-to   = ["type=registry,ref=${ECR_REGISTRY}/${SANDBOX_ECR_REPO}:cache,mode=max"]
  attest     = ["type=provenance,disabled=true"]
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
  attest     = ["type=provenance,disabled=true"]
}
