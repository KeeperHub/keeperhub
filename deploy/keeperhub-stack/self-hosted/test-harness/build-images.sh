#!/usr/bin/env bash
# Builds the KeeperHub images and side-loads them into the test minikube cluster.
#
# TEST SCAFFOLDING. A real self-hosted install pulls signed images from a
# registry; nothing here ships to a client. This exists so the install can be
# exercised without publishing anything.
#
# Prints the tag it produced, which is what install.sh needs:
#   IMAGE_TAG=$(./test-harness/build-images.sh --print-tag)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck source=deploy/keeperhub-stack/self-hosted/config.sh
source "$SCRIPT_DIR/../config.sh"

MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-keeperhub}"

# Read from the settings file, like everything else.
#
# On this cluster it is a bare repository name with no registry host, which
# resolves only because the images are side-loaded into the node below. A real
# install names a registry the cluster can pull from instead.
if [ -z "$IMAGE_REPO" ]; then
    echo "IMAGE_REPO is not set. Put it in the file ENV_FILE names:" >&2
    echo "    IMAGE_REPO=keeperhub-local" >&2
    exit 1
fi

SKIP_BUILD=false
PRINT_TAG=false
for arg in "$@"; do
    case $arg in
        --skip-build) SKIP_BUILD=true ;;
        --print-tag) PRINT_TAG=true ;;
        --help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

cd "$REPO_ROOT"

# Content-addressed on a clean tree so a rebuild re-uses what is already loaded,
# unique on a dirty tree so an edited build is never mistaken for an older one.
# Never ":latest": the common chart does not render imagePullPolicy on
# initContainers, so kubelet would default to Always and fail on a side-loaded
# image that exists only inside the node.
resolve_tag() {
    local sha dirty=""
    sha=$(git rev-parse --short HEAD)
    [ -z "$(git status --porcelain)" ] || dirty="-dirty-$(date +%s)"
    printf '%s%s' "$sha" "$dirty"
}
IMAGE_TAG="${IMAGE_TAG:-$(resolve_tag)}"

if [ "$PRINT_TAG" = true ]; then printf '%s\n' "$IMAGE_TAG"; exit 0; fi

echo "== Building images ($IMAGE_TAG)"
if [ "$SKIP_BUILD" = false ]; then
    # NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so
    # the Turnstile site key has to be present HERE - supplying it through the
    # values file does nothing, and the symptom is a signup form that renders and
    # then fails with "Missing CAPTCHA response".
    #
    # Cache refs are cleared on the command line rather than in the overlay:
    # buildx merges list fields across -f files and an empty-list assignment does
    # not clear an inherited value. The root file's cache refs point at
    # ${ECR_REGISTRY}, which resolves to "/:cache" here and is not a valid ref.
    # These three are a command prefix: they enter docker's environment, where
    # bake reads them as HCL variables. shellcheck loses track of that across
    # the line continuations and reports them unused, which fails the
    # --severity=warning gate in maintainability.yml.
    # NOTHING MAY GO BETWEEN THE ASSIGNMENTS AND `docker` BELOW, not even a
    # comment. An assignment prefix has to touch the command it applies to. A
    # comment after a trailing backslash ends the prefix, so the assignments
    # become ordinary shell variables - set, unexported, invisible to the child
    # process - and bake silently falls back to every default.
    #
    # That is not hypothetical. It is what this script did until now, and both
    # consequences are the ones the comments here warn about: the tag resolved
    # to "app-latest", the ":latest" this file forbids because kubelet then
    # defaults initContainers to imagePullPolicy Always and cannot pull a
    # side-loaded image, and NEXT_PUBLIC_TURNSTILE_SITE_KEY resolved to empty,
    # so the captcha never rendered and signup failed with "Missing CAPTCHA
    # response". Keep the block contiguous. Put explanations above it.
    #
    # DOCS_BASE_URL is emptied so the image does not redirect /llms.txt to
    # docs.keeperhub.com. next.config.ts bakes redirects into the build, so this
    # cannot be a Helm value - it has to be decided here. Set on every target
    # rather than just app: the four that run `next build` share one builder
    # stage and BuildKit only deduplicates it while their args match.
    #
    # Every NEXT_PUBLIC_* below is compiled into the browser bundle and cannot be
    # changed by any Helm value afterwards. An unset one is not neutral: it
    # becomes the empty string in the bundle, which is how a missing site key
    # turns into a signup form that renders and then refuses to submit.
    #
    # shellcheck disable=SC2034
    NEXT_PUBLIC_TURNSTILE_SITE_KEY="$TURNSTILE_SITE_KEY" \
    NEXT_PUBLIC_GITHUB_CLIENT_ID="${NEXT_PUBLIC_GITHUB_CLIENT_ID:-}" \
    NEXT_PUBLIC_GOOGLE_CLIENT_ID="${NEXT_PUBLIC_GOOGLE_CLIENT_ID:-}" \
    NEXT_PUBLIC_AUTH_PROVIDERS="${NEXT_PUBLIC_AUTH_PROVIDERS:-}" \
    NEXT_PUBLIC_BILLING_ENABLED="${NEXT_PUBLIC_BILLING_ENABLED:-false}" \
    NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED="${NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED:-false}" \
    NEXT_PUBLIC_SENTRY_DSN="" \
    IMAGE_TAG="$IMAGE_TAG" \
    LOCAL_IMAGE_REPO="$IMAGE_REPO" \
    docker buildx bake \
        -f docker-bake.hcl \
        -f "$SCRIPT_DIR/docker-bake.hcl" \
        --set "*.cache-from=" --set "*.cache-to=" \
        --set "*.args.DOCS_BASE_URL=" \
        local
fi

echo "== Loading into minikube ($MINIKUBE_PROFILE)"
present=$(minikube -p "$MINIKUBE_PROFILE" image ls 2>/dev/null || true)
# Tag prefixes, not bake target names. The metrics collector is tagged
# "collector-" and the block dispatcher "block-", matching the root bake file.
for component in app migrator workflow-runner executor schedule block sandbox collector; do
    image="${IMAGE_REPO}:${component}-${IMAGE_TAG}"
    # Anchored: a bare substring match lets ":app-<tag>" match
    # "keeperhub-local:app-<tag>" and report a skip for an image never checked.
    if printf '%s' "$present" | grep -qE "(^|/)${image}$"; then
        echo "  skip  $image"
    else
        # A docker save | docker load round-trip, and the dominant cost of a warm
        # rebuild, so anything already in the node is skipped.
        echo "  load  $image"
        minikube -p "$MINIKUBE_PROFILE" image load "$image"
    fi
done

cat <<EOF

Images ready. Install with:

  KUBE_CONTEXT=$MINIKUBE_PROFILE PROFILE=minikube IMAGE_TAG=$IMAGE_TAG ./install.sh
EOF
