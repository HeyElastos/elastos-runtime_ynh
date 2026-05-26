#!/usr/bin/env bash
# Build hey_home.wasm targeting wasm32-wasip1 — same pattern as the hey
# capsule. The default `cargo build --release` produces a native binary,
# which is not what capsule.json's entrypoint points at.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

rustup target add wasm32-wasip1 >/dev/null 2>&1 || true

echo "[hey-home] cargo build --target wasm32-wasip1 --release"
cargo build --target wasm32-wasip1 --release

# Cargo converts package-name hyphens to underscores in artifact filenames.
ARTIFACT="target/wasm32-wasip1/release/hey_home.wasm"
if [[ ! -f "$ARTIFACT" ]]; then
    echo "[hey-home] build did not produce $ARTIFACT" >&2
    exit 1
fi
cp "$ARTIFACT" "$HERE/hey_home.wasm"

ls -lh "$HERE/hey_home.wasm"
echo "[hey-home] done"
