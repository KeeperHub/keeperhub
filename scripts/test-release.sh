#!/usr/bin/env bash
#
# test-release.sh
# ---------------
# Simulate the GHA release workflow locally to validate PR discovery
# and release note generation without creating tags or releases.
#
# Usage:
#   ./keeperhub/scripts/test-release.sh
#   ./keeperhub/scripts/test-release.sh --prev-tag v1.2.0
#   ./keeperhub/scripts/test-release.sh --base-branch main
#   ./keeperhub/scripts/test-release.sh --help

set -euo pipefail

# ------------------------------------------------------------------
# Defaults
# ------------------------------------------------------------------
PREV_TAG=""
BASE_BRANCH="staging"
REPO_URL=""

# ------------------------------------------------------------------
# Usage
# ------------------------------------------------------------------
usage() {
  cat <<'USAGE'
test-release.sh -- simulate the release workflow locally

OPTIONS
  --prev-tag <tag>        Previous release tag (default: auto-detect via git describe)
  --base-branch <branch>  Base branch for PR discovery (default: staging)
  --help                  Show this help message

EXAMPLES
  # Auto-detect previous tag, discover PRs merged to staging
  ./keeperhub/scripts/test-release.sh

  # Simulate from a specific tag
  ./keeperhub/scripts/test-release.sh --prev-tag v0.3.0

  # Use a different base branch
  ./keeperhub/scripts/test-release.sh --base-branch main

WHAT THIS DOES
  1. Discovers merged PRs since the previous tag (or all PRs if first release)
  2. Classifies PRs by conventional commit prefix
  3. Determines semver bump (breaking > feat > patch)
  4. Generates formatted release notes

WHAT THIS DOES NOT DO
  - Create git tags
  - Create GitHub Releases
  - Send Discord notifications
USAGE
}

# ------------------------------------------------------------------
# Argument parsing
# ------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --prev-tag)
      PREV_TAG="$2"
      shift 2
      ;;
    --base-branch)
      BASE_BRANCH="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

# ------------------------------------------------------------------
# Preflight checks
# ------------------------------------------------------------------
if ! command -v gh &>/dev/null; then
  echo "ERROR: gh CLI is not installed. Install it from https://cli.github.com/"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "ERROR: gh CLI is not authenticated. Run 'gh auth login' first."
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is not installed. Install it with 'brew install jq'."
  exit 1
fi

# Detect repo URL from git remote
REPO_URL=$(gh repo view --json url --jq '.url' 2>/dev/null || echo "")
if [ -z "$REPO_URL" ]; then
  echo "ERROR: Could not determine repository URL. Run from inside a git repo with a GitHub remote."
  exit 1
fi

echo "============================================================"
echo "  KeeperHub Release Test"
echo "============================================================"
echo ""
echo "Repository:   $REPO_URL"
echo "Base branch:  $BASE_BRANCH"

# ------------------------------------------------------------------
# Step 1: Determine previous tag
# ------------------------------------------------------------------
FIRST_RELEASE=false

if [ -n "$PREV_TAG" ]; then
  echo "Previous tag: $PREV_TAG (user-provided)"
else
  PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  if [ -z "$PREV_TAG" ]; then
    echo "Previous tag: (none -- first release)"
    FIRST_RELEASE=true
  else
    echo "Previous tag: $PREV_TAG (auto-detected)"
  fi
fi

# ------------------------------------------------------------------
# Step 2: Discover merged PRs
# ------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Discovered PRs"
echo "============================================================"
echo ""

# Upper bound: the author date of HEAD
UNTIL=$(git log -1 --format=%aI HEAD)
echo "Upper bound (HEAD author date): $UNTIL"

if [ "$FIRST_RELEASE" = "true" ]; then
  echo "First release -- discovering all PRs merged to $BASE_BRANCH before $UNTIL"
  PR_JSON=$(gh pr list \
    --state merged \
    --base "$BASE_BRANCH" \
    --json number,title,author,url,body,mergedAt \
    --limit 200 \
    --jq "[.[] | select(.mergedAt <= \"$UNTIL\")]")
else
  SINCE=$(git log -1 --format=%aI "$PREV_TAG")
  echo "Finding PRs merged after: $SINCE and before: $UNTIL"

  PR_JSON=$(gh pr list \
    --state merged \
    --base "$BASE_BRANCH" \
    --json number,title,author,url,mergedAt,body \
    --limit 200 \
    --jq "[.[] | select(.mergedAt > \"$SINCE\" and .mergedAt <= \"$UNTIL\")]")
fi

PR_COUNT=$(echo "$PR_JSON" | jq 'length')
echo ""
echo "Found $PR_COUNT merged PR(s)."

if [ "$PR_COUNT" -eq 0 ]; then
  echo ""
  echo "No PRs found. Nothing to release."
  exit 0
fi

# Print discovered PRs
echo ""
echo "$PR_JSON" | jq -r '.[] | "  #\(.number) \(.title) (@\(.author.login)) merged \(.mergedAt)"'

# ------------------------------------------------------------------
# Step 3: Classify PRs and determine version bump
# ------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Classification"
echo "============================================================"
echo ""

HAS_BREAKING=false
HAS_FEAT=false

BREAKING_PRS=""
FEAT_PRS=""
FIX_PRS=""
OTHER_PRS=""

while IFS= read -r pr_line; do
  NUMBER=$(echo "$pr_line" | jq -r '.number')
  TITLE=$(echo "$pr_line" | jq -r '.title')
  AUTHOR=$(echo "$pr_line" | jq -r '.author.login')
  URL=$(echo "$pr_line" | jq -r '.url')
  BODY=$(echo "$pr_line" | jq -r '.body // ""')

  # Clean the title: remove leading/trailing whitespace
  TITLE=$(printf '%s' "$TITLE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

  # Strip the prefix from the title for display
  DISPLAY_TITLE=$(printf '%s' "$TITLE" | sed -E 's/^(feat|fix|bug|hotfix|breaking|chore|docs|refactor|test|ci|build|perf|style)(\([^)]*\))?[!]?:[[:space:]]*//')

  # If stripping produced empty string, use original title
  if [ -z "$DISPLAY_TITLE" ]; then
    DISPLAY_TITLE="$TITLE"
  fi

  # Build the entry line
  ENTRY="- ${DISPLAY_TITLE} ([#${NUMBER}](${URL})) @${AUTHOR}"

  # Classify by prefix
  CATEGORY=""
  if printf '%s' "$TITLE" | grep -qiE "^breaking(\([^)]*\))?:"; then
    HAS_BREAKING=true
    BREAKING_PRS="${BREAKING_PRS}${ENTRY}"$'\n'
    CATEGORY="BREAKING"
  elif printf '%s' "$TITLE" | grep -qiE "^[a-z]+(\([^)]*\))?!:"; then
    HAS_BREAKING=true
    BREAKING_PRS="${BREAKING_PRS}${ENTRY}"$'\n'
    CATEGORY="BREAKING (!)"
  elif printf '%s' "$BODY" | grep -q "BREAKING CHANGE"; then
    HAS_BREAKING=true
    BREAKING_PRS="${BREAKING_PRS}${ENTRY}"$'\n'
    CATEGORY="BREAKING (body)"
  elif printf '%s' "$TITLE" | grep -qiE "^feat(\([^)]*\))?:"; then
    HAS_FEAT=true
    FEAT_PRS="${FEAT_PRS}${ENTRY}"$'\n'
    CATEGORY="FEATURE"
  elif printf '%s' "$TITLE" | grep -qiE "^(fix|bug|hotfix)(\([^)]*\))?:"; then
    FIX_PRS="${FIX_PRS}${ENTRY}"$'\n'
    CATEGORY="FIX"
  else
    OTHER_PRS="${OTHER_PRS}${ENTRY}"$'\n'
    CATEGORY="OTHER"
  fi

  printf '  %-16s #%s %s\n' "[$CATEGORY]" "$NUMBER" "$TITLE"
done < <(echo "$PR_JSON" | jq -c '.[]')

# ------------------------------------------------------------------
# Step 4: Version bump
# ------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Version Bump"
echo "============================================================"
echo ""

if [ "$HAS_BREAKING" = true ]; then
  BUMP="major"
elif [ "$HAS_FEAT" = true ]; then
  BUMP="minor"
else
  BUMP="patch"
fi

echo "Bump type: $BUMP"

if [ "$FIRST_RELEASE" = "true" ]; then
  NEW_TAG="v0.1.0"
else
  VERSION="${PREV_TAG#v}"
  MAJOR=$(echo "$VERSION" | cut -d. -f1)
  MINOR=$(echo "$VERSION" | cut -d. -f2)
  PATCH=$(echo "$VERSION" | cut -d. -f3)

  case "$BUMP" in
    major)
      MAJOR=$((MAJOR + 1))
      MINOR=0
      PATCH=0
      ;;
    minor)
      MINOR=$((MINOR + 1))
      PATCH=0
      ;;
    patch)
      PATCH=$((PATCH + 1))
      ;;
  esac

  NEW_TAG="v${MAJOR}.${MINOR}.${PATCH}"
fi

echo "New tag:   $NEW_TAG"

# Check if tag already exists
if git tag -l "$NEW_TAG" | grep -q "$NEW_TAG"; then
  echo ""
  echo "WARNING: Tag $NEW_TAG already exists locally."
fi

# ------------------------------------------------------------------
# Step 5: Formatted release notes
# ------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Formatted Release Notes"
echo "============================================================"
echo ""

NOTES="## What's Changed"$'\n'

if [ -n "$BREAKING_PRS" ]; then
  NOTES="${NOTES}"$'\n'"### Breaking Changes"$'\n'
  NOTES="${NOTES}${BREAKING_PRS}"
fi

if [ -n "$FEAT_PRS" ]; then
  NOTES="${NOTES}"$'\n'"### Features"$'\n'
  NOTES="${NOTES}${FEAT_PRS}"
fi

if [ -n "$FIX_PRS" ]; then
  NOTES="${NOTES}"$'\n'"### Bug Fixes"$'\n'
  NOTES="${NOTES}${FIX_PRS}"
fi

if [ -n "$OTHER_PRS" ]; then
  NOTES="${NOTES}"$'\n'"### Other Changes"$'\n'
  NOTES="${NOTES}${OTHER_PRS}"
fi

if [ "$FIRST_RELEASE" = "true" ]; then
  NOTES="${NOTES}"$'\n'"**Full Changelog**: ${REPO_URL}/commits/${NEW_TAG}"
else
  NOTES="${NOTES}"$'\n'"**Full Changelog**: ${REPO_URL}/compare/${PREV_TAG}...${NEW_TAG}"
fi

echo "$NOTES"

echo ""
echo "============================================================"
echo "  Done (dry run -- no tags or releases created)"
echo "============================================================"
