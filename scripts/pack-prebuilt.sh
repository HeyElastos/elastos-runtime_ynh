#!/usr/bin/env bash
#
# Pack a compiled elastos/target tree into the tarball yunohost install
# extracts (see maybe_download_prebuilt in _common.sh).
#
# Run this ONCE after a source install (or a local cargo build that matches
# build_runtime_and_capsules). Later `yunohost app install/upgrade` will
# pick the cache up automatically if the fingerprint still matches.
#
# Usage:
#   ./scripts/pack-prebuilt.sh
#   ./scripts/pack-prebuilt.sh /var/www/elastos_runtime /var/cache/elastos_runtime-prebuilt
#   ELASTOS_PREBUILT_URL=/path/to/prebuilt-linux-amd64.tar.gz yunohost app upgrade elastos_runtime
#
# Archive members are relative to elastos/ (target/debug/elastos, …).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/elastos}"
case "$(uname -m)" in
    x86_64|amd64)  ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
OUT_DIR="${2:-$ROOT}"
DEST="$OUT_DIR/prebuilt-linux-$ARCH.tar.gz"

MEMBERS=(
    target/debug/elastos
    target/release/shell
    target/release/localhost-provider
    target/release/did-provider
    target/release/webspace-provider
    target/release/ipfs-provider
    target/wasm32-wasip1/release/home-cli.wasm
)

missing=0
for f in "${MEMBERS[@]}"; do
    if [ ! -e "$SRC/$f" ]; then
        echo "missing $SRC/$f" >&2
        missing=1
    fi
done
[ "$missing" = 0 ] || {
    echo "Build the runtime first (yunohost install, or cargo as in .github/workflows/prebuilt-release.yml)." >&2
    exit 1
}

mkdir -p "$OUT_DIR"
tar -C "$SRC" -czf "$DEST" "${MEMBERS[@]}"
sha256sum "$DEST" | awk '{print $1}' > "$DEST.sha256"
ls -lh "$DEST" "$DEST.sha256"
echo
echo "Install will use this if you:"
echo "  1. copy it to /var/cache/<app>-prebuilt/  (automatic after a source install), or"
echo "  2. ELASTOS_PREBUILT_URL=$DEST"
echo "  3. tag prebuilt-* and attach this file to a GitHub release, then set PREBUILT_TAG"
