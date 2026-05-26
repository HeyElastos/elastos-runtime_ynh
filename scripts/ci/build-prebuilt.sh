#!/usr/bin/env bash
# Build + stage publisher artifacts for the yunohost prebuilt release.
#
# This is the CI-side equivalent of what the yunohost install script does
# on-box: cargo build the runtime + capsules, run the Python staging
# heredoc, produce a single `prebuilt-artifacts.tar.gz` plus a checksum
# file. The yunohost install script downloads + extracts these instead of
# rebuilding from source.
#
# Required env:
#   PLATFORM       e.g. linux-amd64
#   REPO_ROOT      absolute path to the repo (default: $(pwd))
#
# Outputs (in REPO_ROOT/_dist/):
#   prebuilt-artifacts-${PLATFORM}.tar.gz
#   prebuilt-artifacts-${PLATFORM}.sha256

set -euo pipefail

PLATFORM="${PLATFORM:-linux-amd64}"
REPO_ROOT="${REPO_ROOT:-$(pwd)}"
DIST="${REPO_ROOT}/_dist"
STAGING="${DIST}/staging"
ARTIFACTS_DIR="${STAGING}/artifacts"

rm -rf "${DIST}"
mkdir -p "${ARTIFACTS_DIR}"

# ── 1) Build the runtime + capsules ─────────────────────────────────
echo "[ci] cargo build elastos-server (debug)"
cargo build --manifest-path "${REPO_ROOT}/elastos/Cargo.toml" -p elastos-server

for crate in shell localhost-provider; do
    echo "[ci] cargo build ${crate} (release)"
    cargo build --release --manifest-path "${REPO_ROOT}/elastos/capsules/${crate}/Cargo.toml"
done

for crate in did-provider webspace-provider; do
    echo "[ci] cargo build ${crate} (release)"
    cargo build --release --manifest-path "${REPO_ROOT}/capsules/${crate}/Cargo.toml"
done

# home-cli WASM gets copied next to capsule.json
echo "[ci] cargo build home-cli (wasm32-wasip1)"
cargo build --release --target wasm32-wasip1 \
    --manifest-path "${REPO_ROOT}/capsules/home-cli/Cargo.toml"
cp "${REPO_ROOT}/elastos/target/wasm32-wasip1/release/home-cli.wasm" \
   "${REPO_ROOT}/capsules/home-cli/home-cli.wasm"

for crate in home system chat-room; do
    echo "[ci] cargo build ${crate} (wasm32-wasip1)"
    cargo build --release --target wasm32-wasip1 \
        --manifest-path "${REPO_ROOT}/capsules/${crate}/Cargo.toml"
done

# ── 2) Stage publisher artifacts ────────────────────────────────────
echo "[ci] staging artifacts via Python heredoc"

COMPONENTS_SRC="${REPO_ROOT}/components.json" \
COMPONENTS_DEST="${STAGING}/components.json" \
ARTIFACTS_DIR="${ARTIFACTS_DIR}" \
SETUP_PLATFORM="${PLATFORM}" \
NATIVE_BIN_DIR="${REPO_ROOT}/elastos/target/release" \
CAPSULES_SRC="${REPO_ROOT}/capsules" \
WASM_TARGET_DIR="${REPO_ROOT}/elastos/target/wasm32-wasip1/release" \
python3 - <<'PY'
import hashlib, json, os, pathlib, shutil, tarfile

components_src = pathlib.Path(os.environ["COMPONENTS_SRC"])
components_dest = pathlib.Path(os.environ["COMPONENTS_DEST"])
artifacts_dir = pathlib.Path(os.environ["ARTIFACTS_DIR"])
platform = os.environ["SETUP_PLATFORM"]
native_bin = pathlib.Path(os.environ["NATIVE_BIN_DIR"])
capsules = pathlib.Path(os.environ["CAPSULES_SRC"])
wasm_target = pathlib.Path(os.environ["WASM_TARGET_DIR"])

manifest = json.loads(components_src.read_text())

def platform_info(name):
    platforms = manifest["external"][name].get("platforms") or {}
    info = platforms.get(platform) or platforms.get("*")
    if not info:
        raise SystemExit(f"{name} missing release metadata for {platform}")
    return info

def stamp(info, data):
    info["checksum"] = "sha256:" + hashlib.sha256(data).hexdigest()
    info["size"] = len(data)

for name in ("shell", "localhost-provider", "did-provider", "webspace-provider"):
    src = native_bin / name
    if not src.is_file():
        raise SystemExit(f"missing built artifact for {name}: {src}")
    info = platform_info(name)
    dest = artifacts_dir / info["release_path"]
    shutil.copy2(src, dest)
    dest.chmod(0o755)
    stamp(info, dest.read_bytes())

info = platform_info("home-cli")
archive = artifacts_dir / info["release_path"]
home_cli_dir = capsules / "home-cli"
with tarfile.open(archive, "w:gz") as tar:
    tar.add(home_cli_dir / "capsule.json", arcname="home-cli/capsule.json")
    tar.add(home_cli_dir / "home-cli.wasm", arcname="home-cli/home-cli.wasm")
stamp(info, archive.read_bytes())

for name in ("home", "system", "chat-room"):
    info = platform_info(name)
    capsule_dir = capsules / name
    capsule_meta = json.loads((capsule_dir / "capsule.json").read_text())
    entrypoint = capsule_meta["entrypoint"]
    candidates = [
        wasm_target / entrypoint,
        wasm_target / f"{name}.wasm",
        wasm_target / f"{name.replace('-', '_')}.wasm",
    ]
    wasm_src = next((c for c in candidates if c.is_file()), None)
    if wasm_src is None:
        raise SystemExit(f"no wasm for {name}: tried {[str(c) for c in candidates]}")
    archive = artifacts_dir / info["release_path"]
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(capsule_dir / "capsule.json", arcname=f"{name}/capsule.json")
        tar.add(wasm_src, arcname=f"{name}/{entrypoint}")
        browser = capsule_dir / "browser"
        if browser.is_dir():
            tar.add(browser, arcname=f"{name}/browser")
    stamp(info, archive.read_bytes())

for name in ("documents", "library", "inbox"):
    info = platform_info(name)
    capsule_dir = capsules / name
    archive = artifacts_dir / info["release_path"]
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(capsule_dir / "capsule.json", arcname=f"{name}/capsule.json")
        tar.add(capsule_dir / "index.html", arcname=f"{name}/index.html")
    stamp(info, archive.read_bytes())

components_dest.parent.mkdir(parents=True, exist_ok=True)
components_dest.write_text(json.dumps(manifest, indent=2) + "\n")
PY

# ── 3) Also pack the elastos debug binary (the install script needs it
#       to spin up the temp publisher) ────────────────────────────────
mkdir -p "${STAGING}/bin"
cp "${REPO_ROOT}/elastos/target/debug/elastos" "${STAGING}/bin/elastos"
cp "${REPO_ROOT}/elastos/target/release/localhost-provider" "${STAGING}/bin/localhost-provider"

# ── 4) Tar + sha256 ─────────────────────────────────────────────────
OUT="${DIST}/prebuilt-artifacts-${PLATFORM}.tar.gz"
SHA="${DIST}/prebuilt-artifacts-${PLATFORM}.sha256"

echo "[ci] packaging ${OUT}"
tar -czf "${OUT}" -C "${STAGING}" .
sha256sum "${OUT}" | awk '{print $1}' > "${SHA}"

ls -lh "${OUT}" "${SHA}"
echo "[ci] sha256: $(cat ${SHA})"
echo "[ci] done"
