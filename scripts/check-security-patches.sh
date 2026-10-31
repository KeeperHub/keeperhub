#!/usr/bin/env bash
# Asserts that every declared pnpm patch is actually applied in the lockfile.
#
# A workspace that sets allowUnusedPatches (needed when an image installs only
# a subset of the tree) downgrades a patch that stopped matching from an error
# to a warning, so a dependency bump that moves the package off the patched
# version would silently drop the fix. This check is what turns that back into
# a failure. No patches are declared today; the check passes trivially until
# one is added.
set -euo pipefail

status=0

check() {
  local manifest="$1" lockfile="$2"
  [ -f "$manifest" ] || return 0

  local patches
  patches=$(node -e '
    const m = require(process.argv[1]);
    const p = (m.pnpm && m.pnpm.patchedDependencies) || {};
    console.log(Object.keys(p).join("\n"));
  ' "$PWD/$manifest")

  [ -z "$patches" ] && return 0

  while IFS= read -r patch; do
    [ -z "$patch" ] && continue
    local name="${patch%@*}"
    if grep -q "^  ${name}@.*patch_hash=" "$lockfile"; then
      echo "ok      $patch applied in $lockfile"
    else
      echo "FAILED  $patch is declared in $manifest but not applied in $lockfile"
      status=1
    fi
  done <<< "$patches"
}

check "package.json" "pnpm-lock.yaml"
check "keeperhub-events/package.json" "keeperhub-events/pnpm-lock.yaml"
check "keeperhub-scheduler/package.json" "keeperhub-scheduler/pnpm-lock.yaml"

if [ "$status" -ne 0 ]; then
  echo
  echo "A declared security patch is no longer reaching the dependency tree."
  echo "Re-point pnpm.patchedDependencies at the resolved version and refresh the patch."
fi

exit "$status"
