#!/usr/bin/env bash
# Update the pinned upstream Elacity/elastos-runtime version.
#
# Usage:
#   ./scripts/sync-upstream.sh v0.4.0
#   ./scripts/sync-upstream.sh 8acb72d        # commit sha also works
#
# What it does:
#   1. Confirms the upstream tarball is reachable + valid.
#   2. Writes the new version into ./UPSTREAM_VERSION.
#   3. Prints a one-liner you can paste into your next commit.
#
# What it deliberately does NOT do:
#   - It does NOT vendor any upstream files into this repo. The
#     install script fetches them at install time. This is the whole
#     point of the modular architecture (see docs/HEY_MODULAR_
#     ARCHITECTURE.md): we hold a version pin, not a fork.
#   - It does NOT touch capsules/hey-* or the theme overlay. Those
#     are independent of upstream version.

set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: $0 <upstream-version-or-sha>" >&2
    echo "  examples:  $0 v0.4.0    /    $0 8acb72d" >&2
    exit 2
fi

VERSION="$1"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIN_FILE="$REPO_ROOT/UPSTREAM_VERSION"

# GitHub serves both refs/tags/<tag> and the raw <commit-sha> under
# /archive/<thing>.tar.gz. Probe with HEAD to confirm before touching the pin.
TARBALL_URL="https://github.com/Elacity/elastos-runtime/archive/${VERSION}.tar.gz"
echo "Probing $TARBALL_URL ..."
http_status="$(curl -sIL -o /dev/null -w '%{http_code}' "$TARBALL_URL")"
if [ "$http_status" != "200" ]; then
    echo "ERROR: upstream tarball not reachable (HTTP $http_status)" >&2
    echo "  URL: $TARBALL_URL" >&2
    exit 1
fi

PREV="$(cat "$PIN_FILE" 2>/dev/null | tr -d '[:space:]' || echo '(unpinned)')"
echo "$VERSION" > "$PIN_FILE"

echo "Updated UPSTREAM_VERSION: $PREV → $VERSION"
echo
echo "Next steps:"
echo "  git add UPSTREAM_VERSION"
echo "  git commit -m 'Bump runtime to $VERSION'"
echo "  git push"
echo
echo "Then \`yunohost app upgrade elastos_runtime\` on any install will"
echo "fetch the new upstream tarball + rebuild against it. Our Hey"
echo "capsules and theme overlay are layered on top unchanged."
