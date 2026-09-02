#!/usr/bin/env bash
# Build the same binary set yunohost install downloads (mirrors
# .github/workflows/prebuilt-release.yml and build_runtime_and_capsules).
#
# Puts cargo target + the tarball under $WORKDIR so a nearly-full source
# disk is not required. Default WORKDIR is /var/home/linux/.cache/elastos-ynh-prebuilt.
set -euo pipefail

YNH_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${WORKDIR:-/var/home/linux/.cache/elastos-ynh-prebuilt}"
# Ignore the agent/sandbox CARGO_TARGET_DIR; this build must land on $WORKDIR
# (the Cursor shell injects a tmp cache that can be wiped). Override with
# ELASTOS_CARGO_TARGET_DIR if you really want a custom path.
export CARGO_TARGET_DIR="${ELASTOS_CARGO_TARGET_DIR:-$WORKDIR/target}"
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.91}"

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

command -v rustup >/dev/null || die "rustup not on PATH"
rustup toolchain install 1.91 --profile minimal
rustup target add --toolchain 1.91 wasm32-wasip1
rustup run 1.91 rustc --version

mkdir -p "$WORKDIR" "$CARGO_TARGET_DIR"
cd "$WORKDIR"
rm -rf src
mkdir src
# Copy packaging (patches, manifest, Hey additions) — not cargo target.
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'elastos/' \
  --exclude 'capsules/' \
  --exclude 'target/' \
  --exclude '_dist/' \
  "$YNH_ROOT/" "$WORKDIR/src/"
cd "$WORKDIR/src"

log "Fetch upstream $(tr -d '[:space:]' < UPSTREAM_VERSION)"
VER="$(tr -d '[:space:]' < UPSTREAM_VERSION)"
curl -fsSL "https://github.com/Elacity/elastos-runtime/archive/${VER}.tar.gz" -o "$WORKDIR/up.tgz"
rm -rf "$WORKDIR/up" && mkdir "$WORKDIR/up"
tar -xzf "$WORKDIR/up.tgz" -C "$WORKDIR/up"
EX="$(find "$WORKDIR/up" -mindepth 1 -maxdepth 1 -type d -name 'elastos-runtime-*' | head -1)"
[ -n "$EX" ] || die "upstream tarball layout changed"
rm -rf elastos
mv "$EX/elastos" elastos
mkdir -p capsules
for d in "$EX"/capsules/*/; do
  cp -r "$d" "capsules/$(basename "$d")"
done
python3 - "$EX/components.json" components.additions.json components.json <<'PY'
import json, sys
up = json.load(open(sys.argv[1]))
add = json.load(open(sys.argv[2]))
up.setdefault("external", {}).update(add.get("external", {}))
json.dump(up, open(sys.argv[3], "w"), indent=2)
PY

log "Apply patches"
for p in scripts/patches/*.patch; do
  echo "  $p"
  patch -p1 --forward < "$p"
done

log "Fetch Hey capsule pack"
URL="$(python3 -c "import sys
p=open('manifest.toml').read().split('[resources.sources.hey_capsules]',1)[1]
for line in p.splitlines():
    if line.strip().startswith('url'):
        print(line.split('=',1)[1].strip().strip('\"')); break
")"
curl -fsSL "$URL" -o "$WORKDIR/hey.tgz"
rm -rf "$WORKDIR/hey" && mkdir "$WORKDIR/hey"
tar -xzf "$WORKDIR/hey.tgz" -C "$WORKDIR/hey"
HX="$(find "$WORKDIR/hey" -mindepth 1 -maxdepth 1 -type d | head -1)"
for d in "$HX"/capsules/*/; do
  n="$(basename "$d")"
  rm -rf "capsules/$n"
  cp -r "$d" "capsules/$n"
done

log "Build runtime + providers + home-cli wasm"
cargo build --manifest-path elastos/Cargo.toml -p elastos-server
for c in shell localhost-provider; do
  cargo build --release --manifest-path "elastos/capsules/$c/Cargo.toml"
done
for c in did-provider webspace-provider ipfs-provider; do
  cargo build --release --manifest-path "capsules/$c/Cargo.toml"
done
for c in blobs-provider identity-projection-provider; do
  ( cd "capsules/$c" && cargo build --release )
done
cargo build --release --target wasm32-wasip1 --manifest-path capsules/home-cli/Cargo.toml

# CARGO_TARGET_DIR is $WORKDIR/target, not elastos/target.
ELASTOS_BIN="$CARGO_TARGET_DIR"
[ -x "$ELASTOS_BIN/debug/elastos" ] || die "missing $ELASTOS_BIN/debug/elastos"

log "Pack tarball"
OUT="$WORKDIR/prebuilt-linux-amd64.tar.gz"
# pack-prebuilt.sh expects files under elastos/ — stage a fake prefix via -C target
# after rewriting members to drop the elastos/ layout: members are target/...
STAGE="$WORKDIR/stage-elastos"
rm -rf "$STAGE"
mkdir -p "$STAGE/target/debug" "$STAGE/target/release" "$STAGE/target/wasm32-wasip1/release"
cp -a "$ELASTOS_BIN/debug/elastos" "$STAGE/target/debug/elastos"
for b in shell localhost-provider did-provider webspace-provider ipfs-provider \
         blobs-provider identity-projection-provider; do
  src="$ELASTOS_BIN/release/$b"
  [ -x "$src" ] || die "missing $src"
  cp -a "$src" "$STAGE/target/release/$b"
done
WASM="$ELASTOS_BIN/wasm32-wasip1/release/home-cli.wasm"
[ -f "$WASM" ] || WASM="$ELASTOS_BIN/wasm32-wasip1/release/home_cli.wasm"
[ -f "$WASM" ] || die "missing home-cli.wasm"
cp -a "$WASM" "$STAGE/target/wasm32-wasip1/release/home-cli.wasm"

tar -C "$STAGE" -czf "$OUT" \
  target/debug/elastos \
  target/release/shell \
  target/release/localhost-provider \
  target/release/did-provider \
  target/release/webspace-provider \
  target/release/ipfs-provider \
  target/release/blobs-provider \
  target/release/identity-projection-provider \
  target/wasm32-wasip1/release/home-cli.wasm
sha256sum "$OUT" | awk '{print $1}' > "$OUT.sha256"
ls -lh "$OUT" "$OUT.sha256"
echo
echo "PACKED $OUT"
cat "$OUT.sha256"
