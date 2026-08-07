# Local overlay for docker-bake.hcl. Invoked by deploy/local/deploy.sh as:
#
#   IMAGE_TAG=<tag> docker buildx bake \
#     -f docker-bake.hcl -f deploy/local/docker-bake.local.hcl \
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

# Only the components deploy/keeperhub-stack/self-hosted/values.yaml enables.
# block-dispatcher and metricsCollector are off there, so building them would be
# wasted time; 'local-block' exists for when the block dispatcher is turned on.
group "local" {
  targets = ["app", "migrator", "workflow-runner", "executor", "schedule-dispatcher"]
}

group "local-block" {
  targets = ["block-dispatcher"]
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
