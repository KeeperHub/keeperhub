# Build overlay for a self-hosted install.
#
#   set -a; . .env; set +a
#   docker buildx bake \
#     -f docker-bake.hcl \
#     -f deploy/keeperhub-stack/self-hosted/docker-bake.hcl \
#     --set "*.cache-from=" --set "*.cache-to=" \
#     --push keeperhub
#
# It exists so the settings file has one image setting rather than six. The root
# build file gives each component its own registry variable - ECR_REPO,
# SCHEDULER_ECR_REPO, EXECUTOR_ECR_REPO, SANDBOX_ECR_REPO,
# METRICS_COLLECTOR_ECR_REPO - which suits a deployment that keeps them in
# separate repositories. The chart does not: global.image.repository is a single
# value, and every component is found under it by tag prefix. This overlay maps
# the one IMAGE_REPO from .env onto all of them.
#
# Naming both -f files is required rather than tidy. A bare `docker buildx bake`
# also discovers docker-compose.yml, which declares env_file: .env and fails on
# a fresh clone with "env file .env not found".

variable "IMAGE_REPO" { default = "" }

# Every component the chart runs, plus the sandbox the Code step needs.
#
# The root file's own groups do not match an install: `default` is three of
# these, and `pipeline` omits the sandbox. Building them in one session shares
# the deps, source and builder stages, so this is also the fast way.
group "keeperhub" {
  targets = [
    "app",
    "migrator",
    "workflow-runner",
    "executor",
    "schedule-dispatcher",
    "block-dispatcher",
    "metrics-collector",
    "sandbox",
  ]
}

# One tag per component, which is what the chart looks for.
#
# The two --set flags in the invocation above are not optional. The root file
# exports its build cache to ${ECR_REGISTRY}/...:cache, and Docker's default
# builder cannot do that at all: the build stops with "Cache export is not
# supported for the docker driver". They cannot be cleared from this file
# either - buildx merges list fields across -f files, and an empty list here
# does not override an inherited one. The command line is the only place that
# works.
#
# Never ":latest": the common chart does not render imagePullPolicy on
# initContainers, so kubelet defaults to Always for a ":latest" tag and re-pulls
# on every start.

target "app" {
  tags       = ["${IMAGE_REPO}:app-${IMAGE_TAG}"]
}

target "migrator" {
  tags       = ["${IMAGE_REPO}:migrator-${IMAGE_TAG}"]
}

target "workflow-runner" {
  tags       = ["${IMAGE_REPO}:workflow-runner-${IMAGE_TAG}"]
}

target "executor" {
  tags       = ["${IMAGE_REPO}:executor-${IMAGE_TAG}"]
}

target "schedule-dispatcher" {
  tags       = ["${IMAGE_REPO}:schedule-${IMAGE_TAG}"]
}

target "block-dispatcher" {
  tags       = ["${IMAGE_REPO}:block-${IMAGE_TAG}"]
}

target "metrics-collector" {
  tags       = ["${IMAGE_REPO}:collector-${IMAGE_TAG}"]
}

target "sandbox" {
  tags       = ["${IMAGE_REPO}:sandbox-${IMAGE_TAG}"]
}
