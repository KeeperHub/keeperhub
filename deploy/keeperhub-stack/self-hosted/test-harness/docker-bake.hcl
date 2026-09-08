# Local overlay for docker-bake.hcl. Invoked by deploy/local/deploy.sh as:
#
#   IMAGE_TAG=<tag> docker buildx bake \
#     -f docker-bake.hcl -f deploy/keeperhub-stack/self-hosted/test-harness/docker-bake.hcl \
#     --set "*.cache-from=" --set "*.cache-to=" local
#
# The root file is untouched, so nothing here can affect CI.
#
# Why bake rather than five 'docker build' calls: app, migrator, workflow-runner
# and executor all descend from the shared deps -> source -> builder chain and
# the root file deliberately keeps their args identical so BuildKit deduplicates
# it. One bake session therefore runs 'pnpm install' once and 'pnpm build' once
# for all of them; five separate builds would repeat that work each time.
#
# Two things about the invocation are not obvious and are easy to get wrong:
#
#   IMAGE_TAG is an HCL variable, not a build arg. It has to be passed in the
#   environment. '--set "*.args.IMAGE_TAG=..."' sets a build arg of that name
#   and leaves the tags on the "latest" default, which then silently breaks
#   image pulls (see the note on ":latest" below).
#
#   Cache refs are cleared with '--set' on the command line rather than by
#   assigning an empty list here. buildx merges list fields across -f files and
#   an empty-list assignment does not clear an inherited value. The root file's
#   cache refs point at ${ECR_REGISTRY}, which resolves to "/:cache" locally and
#   is not a valid registry reference. BuildKit's local layer cache and the
#   id=pnpm / id=nextjs-build-cache mounts in the Dockerfile still apply and do
#   the real work.

variable "LOCAL_IMAGE_REPO" { default = "keeperhub-local" }

# Every component the M0 acceptance run installs.
#
# The first five share the deps -> source -> builder chain, so one bake session
# runs 'pnpm install' and 'pnpm build' once for all of them. The last three are
# additions for the gate run:
#
#   block-dispatcher   the Block trigger needs it, and the gate covers every
#                      trigger type
#   sandbox            the Code step calls SANDBOX_URL, which the profile points
#                      at keeperhub-sandbox:8787. Without this image that
#                      hostname resolves to nothing and the step fails with a
#                      connection error
#   metrics-collector  cheap, because it reuses the same builder stage
#
# 'local-core' keeps the original five available for a run that does not need
# the extra three.
group "local" {
  targets = [
    "app",
    "migrator",
    "workflow-runner",
    "executor",
    "schedule-dispatcher",
    "block-dispatcher",
    "sandbox",
    "metrics-collector",
  ]
}

group "local-core" {
  targets = ["app", "migrator", "workflow-runner", "executor", "schedule-dispatcher"]
}

# Tags deliberately never use ":latest". The common chart does not render
# imagePullPolicy on initContainers, so kubelet applies its own default, which
# is Always for a ":latest" tag and IfNotPresent for anything else. A ":latest"
# tag would therefore make the migrator initContainer try to pull an image that
# only exists inside the node because it was side-loaded.
target "app" {
  tags   = ["${LOCAL_IMAGE_REPO}:app-${IMAGE_TAG}"]
  output = ["type=docker"]
}

target "migrator" {
  tags   = ["${LOCAL_IMAGE_REPO}:migrator-${IMAGE_TAG}"]
  output = ["type=docker"]
}

target "workflow-runner" {
  tags   = ["${LOCAL_IMAGE_REPO}:workflow-runner-${IMAGE_TAG}"]
  output = ["type=docker"]
}

target "executor" {
  tags   = ["${LOCAL_IMAGE_REPO}:executor-${IMAGE_TAG}"]
  output = ["type=docker"]
}

target "schedule-dispatcher" {
  tags   = ["${LOCAL_IMAGE_REPO}:schedule-${IMAGE_TAG}"]
  output = ["type=docker"]
}

target "block-dispatcher" {
  tags   = ["${LOCAL_IMAGE_REPO}:block-${IMAGE_TAG}"]
  output = ["type=docker"]
}

# Tag prefixes match the root file's own, so a reader comparing the two sees the
# same component under the same name: the root tags sandbox as "sandbox-" and
# the metrics collector as "collector-", not "metrics-collector-".
target "sandbox" {
  tags   = ["${LOCAL_IMAGE_REPO}:sandbox-${IMAGE_TAG}"]
  output = ["type=docker"]
}

target "metrics-collector" {
  tags   = ["${LOCAL_IMAGE_REPO}:collector-${IMAGE_TAG}"]
  output = ["type=docker"]
}
