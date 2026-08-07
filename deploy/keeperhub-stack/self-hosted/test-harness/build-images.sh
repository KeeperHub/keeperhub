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
    NEXT_PUBLIC_TURNSTILE_SITE_KEY="$TURNSTILE_SITE_KEY" \
    IMAGE_TAG="$IMAGE_TAG" \
    LOCAL_IMAGE_REPO="$IMAGE_REPO" \
    docker buildx bake \
        -f docker-bake.hcl \
        -f "$SCRIPT_DIR/docker-bake.hcl" \
        --set "*.cache-from=" --set "*.cache-to=" \
        local
fi

echo "== Loading into minikube ($MINIKUBE_PROFILE)"
present=$(minikube -p "$MINIKUBE_PROFILE" image ls 2>/dev/null || true)
for component in app migrator workflow-runner executor schedule; do
    image="${IMAGE_REPO}:${component}-${IMAGE_TAG}"
    if printf '%s' "$present" | grep -q "$image"; then
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

  KUBE_CONTEXT=$MINIKUBE_PROFILE IMAGE_TAG=$IMAGE_TAG ./install.sh
EOF
