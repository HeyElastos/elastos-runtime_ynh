#!/bin/bash

# Shared helpers for the elastos-runtime YunoHost package.
#
# This package builds Elastos Runtime from source in this repo and runs a
# fully sovereign install: no Elacity publisher dependency. The mechanism
# mirrors what `scripts/home-frontdoor-smoke.sh` does in the runtime — a
# temporary local "publisher" runtime serves locally-built artifacts to a
# permanent client runtime over localhost-only Carrier, then shuts down.
# Post-install the client runtime serves Home from $data_dir/home.

# ────────────────────────────────────────────────────────────────────
# Layout
# ────────────────────────────────────────────────────────────────────
#
#   $install_dir/             ← fetched source (cargo-built here too)
#   $install_dir/bin/elastos-runtime-wrapper.sh
#   $data_dir/home/           ← the client HOME (persistent runtime state)
#       .local/bin/elastos    ← debug binary, copied from cargo target
#       .local/share/elastos/ ← XDG_DATA_HOME — sources.json, capsules, ...
#   $data_dir/source-bootstrap/  ← temp publisher home; wiped after install
#   /opt/$app/rust/           ← rustup home (survives upgrade-source overwrite)

# ────────────────────────────────────────────────────────────────────
# Rust toolchain
# ────────────────────────────────────────────────────────────────────

rustup_root() {
    echo "/opt/$app/rust"
}

elastos_home() {
    echo "$data_dir/home"
}

# Generate (idempotently) a 32-byte AES-256 key for the localhost-provider's
# at-rest encryption. The key file lives under the elastos_runtime user's
# XDG data home in mode 0600. The wrapper script exports its contents into
# ELASTOS_LOCALHOST_ENCRYPTION_KEY, which the localhost-provider picks up
# at Init when its ProviderConfig.encryption_key is empty. Once enabled,
# every write through the localhost-provider is AES-256-GCM encrypted; an
# attacker who acquires the YunoHost backup or steals the disk image gets
# ciphertext only. Root on the live box can still read the key file.
ensure_localhost_encryption_key() {
    local home_dir
    home_dir="$(elastos_home)"
    local key_dir="$home_dir/xdg-data/elastos"
    local key_file="$key_dir/.localhost-key"
    mkdir -p "$key_dir"
    chown -R "$app:$app" "$key_dir"
    if [ ! -s "$key_file" ]; then
        # 32 random bytes → 64-char lowercase hex, no trailing newline.
        sudo -u "$app" sh -c "head -c 32 /dev/urandom | xxd -p -c 64 | tr -d '\n' > '$key_file'"
        chmod 0600 "$key_file"
        chown "$app:$app" "$key_file"
    fi
}

install_rust_toolchain() {
    local root
    root="$(rustup_root)"

    # Clean any stale rustup state from previous failed installs — old
    # settings.toml with default-toolchain=none would block `rustup target add`.
    ynh_exec_warn_less rm -rf "$root"
    mkdir -p "$root/rustup" "$root/cargo"
    chown -R "$app:$app" "$root"

    # Install rustup with the exact version pinned by rust-toolchain.toml.
    ynh_exec_warn_less ynh_exec_as "$app" \
        env RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" \
        bash -c 'curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.89.0 --profile minimal'

    ynh_exec_warn_less ynh_exec_as "$app" \
        env RUSTUP_HOME="$root/rustup" \
            CARGO_HOME="$root/cargo" \
            PATH="$root/cargo/bin:/usr/bin:/bin" \
        bash -c "rustup target add --toolchain 1.89.0 wasm32-wasip1"
}

# Run cargo with the toolchain env baked in.
cargo_as_app() {
    local root
    root="$(rustup_root)"
    ynh_exec_as "$app" \
        env RUSTUP_HOME="$root/rustup" \
            CARGO_HOME="$root/cargo" \
            PATH="$root/cargo/bin:/usr/local/bin:/usr/bin:/bin" \
            CARGO_TARGET_DIR="$install_dir/elastos/target" \
        cargo "$@"
}

# ────────────────────────────────────────────────────────────────────
# Build phase — what home-frontdoor-smoke.sh:135-149 builds
# ────────────────────────────────────────────────────────────────────

build_runtime_and_capsules() {
    # ── runtime binary (debug build, matches smoke pattern) ──
    cargo_as_app build --manifest-path "$install_dir/elastos/Cargo.toml" -p elastos-server

    # ── native binaries needed by the home profile + room gateway + IPFS ──
    for crate in shell localhost-provider; do
        cargo_as_app build --release --manifest-path "$install_dir/elastos/capsules/$crate/Cargo.toml"
    done
    # ipfs-provider: host bridge to a local kubo daemon. Adds Hey's storage
    # foundation. Pairs with the kubo binary fetched in download_external_binaries.
    # notepad: capability-aware notes CLI; demonstrates the shell+localhost-provider
    # auto-grant path against the user's Documents/Notes tree.
    for crate in did-provider webspace-provider ipfs-provider notepad; do
        cargo_as_app build --release --manifest-path "$install_dir/capsules/$crate/Cargo.toml"
    done

    # ── WASM capsules ──
    # home-cli: copy WASM next to capsule.json so home_cli_dir can tar both.
    cargo_as_app build --release --target wasm32-wasip1 \
        --manifest-path "$install_dir/capsules/home-cli/Cargo.toml"
    install -m 0644 -o "$app" -g "$app" \
        "$install_dir/elastos/target/wasm32-wasip1/release/home-cli.wasm" \
        "$install_dir/capsules/home-cli/home-cli.wasm"

    # home, system: home-profile browser capsules. home's browser/ tree
    # carries the Hey-themed shell (frosted launcher, taskbar, welcome).
    # chat-room: only added so `elastos room open` (the /apps/<X>/ gateway)
    # can start — otherwise serve refuses with "Room browser capsule is not
    # installed". chat-room is the minimum extra beyond home profile.
    for crate in home system chat-room; do
        cargo_as_app build --release --target wasm32-wasip1 \
            --manifest-path "$install_dir/capsules/$crate/Cargo.toml"
    done
}

# ────────────────────────────────────────────────────────────────────
# Stage publisher artifacts — what home-frontdoor-smoke.sh:133-234 does
# ────────────────────────────────────────────────────────────────────

stage_publisher_artifacts() {
    local source_runtime_dir="$1"
    local data_dir_root="$source_runtime_dir/elastos"

    mkdir -p "$data_dir_root/bin" "$data_dir_root/ElastOS/SystemServices/Publisher/artifacts"
    install -m 0755 -o "$app" -g "$app" \
        "$install_dir/elastos/target/release/localhost-provider" \
        "$data_dir_root/bin/localhost-provider"

    COMPONENTS_SRC="$install_dir/components.json" \
    COMPONENTS_DEST="$data_dir_root/components.json" \
    PUBLISHER_ROOT="$data_dir_root/ElastOS/SystemServices/Publisher" \
    SETUP_PLATFORM="linux-amd64" \
    SHELL_BIN="$install_dir/elastos/target/release/shell" \
    LOCALHOST_PROVIDER_BIN="$install_dir/elastos/target/release/localhost-provider" \
    DID_PROVIDER_BIN="$install_dir/capsules/did-provider/target/release/did-provider" \
    WEBSPACE_PROVIDER_BIN="$install_dir/capsules/webspace-provider/target/release/webspace-provider" \
    HOME_CLI_DIR="$install_dir/capsules/home-cli" \
    HOME_CAPSULE_DIR="$install_dir/capsules/home" \
    SYSTEM_CAPSULE_DIR="$install_dir/capsules/system" \
    DOCUMENTS_CAPSULE_DIR="$install_dir/capsules/documents" \
    LIBRARY_CAPSULE_DIR="$install_dir/capsules/library" \
    INBOX_CAPSULE_DIR="$install_dir/capsules/inbox" \
    python3 "$install_dir/scripts/build/stage-source-publisher.py"
    # Note: stage-source-publisher.py doesn't exist upstream; we inline the
    # logic from home-frontdoor-smoke.sh:133-234 into the install script
    # below as a heredoc instead. This function is the orchestration point.
}

# ────────────────────────────────────────────────────────────────────
# Local-publisher bootstrap loop
# ────────────────────────────────────────────────────────────────────

# Pick a free port on 127.0.0.1
free_port() {
    python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"
}

# Talk to the temp publisher's API to extract the connect ticket + node ID,
# which we'll feed to scripts/install.sh as the trust anchors.
discover_local_bootstrap() {
    local coords_file="$1"
    RUNTIME_COORDS="$coords_file" python3 - <<'PY'
import json, os, urllib.request
coords = json.loads(open(os.environ["RUNTIME_COORDS"]).read())
api_url = coords["api_url"]
secret = coords["attach_secret"]
attach_req = urllib.request.Request(
    api_url + "/api/auth/attach",
    data=json.dumps({"secret": secret, "scope": "shell"}).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(attach_req, timeout=5) as resp:
    token = json.loads(resp.read().decode("utf-8"))["token"]
ticket_req = urllib.request.Request(
    api_url + "/api/provider/peer/get_ticket",
    data=b"{}",
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
)
with urllib.request.urlopen(ticket_req, timeout=5) as resp:
    body = json.loads(resp.read().decode("utf-8"))
print(body["data"]["ticket"])
print(body["data"]["node_id"])
PY
}

install_wrapper() {
    ynh_add_config \
        --template="elastos-runtime-wrapper.sh" \
        --destination="$install_dir/bin/elastos-runtime-wrapper.sh"
    chown "$app:$app" "$install_dir/bin/elastos-runtime-wrapper.sh"
    chmod 0755 "$install_dir/bin/elastos-runtime-wrapper.sh"
}

# Fetch the kubo IPFS daemon binary from dist.ipfs.tech into the publisher
# artifacts dir. Paired with the cargo-built ipfs-provider so the runtime
# has both the bridge AND the daemon it bridges to. cloudflared/site-provider
# stay deferred — Hey uses nginx via yunohost, not tunnels.
download_external_binaries() {
    local artifacts_dir="$1"
    mkdir -p "$artifacts_dir"
    chown "$app:$app" "$artifacts_dir"

    # Stage the kubo .tar.gz AS-IS. The runtime expects to extract it
    # (components.json has extract_path: kubo/ipfs). Don't pre-extract —
    # if we stage the bare binary, setup tries to `tar -xz` it and fails
    # with "gzip: stdin: not in gzip format".
    ynh_exec_warn_less ynh_exec_as "$app" \
        curl -fsSL --retry 3 -o "$artifacts_dir/kubo-linux-amd64.tar.gz" \
        "https://dist.ipfs.tech/kubo/v0.40.1/kubo_v0.40.1_linux-amd64.tar.gz"
}

# Install /usr/local/bin/elastos wrapper + sudoers rule so any yunohost
# admin can run `elastos <command>` directly.
install_cli_wrapper() {
    ynh_add_config \
        --template="elastos-cli-wrapper.sh" \
        --destination="/usr/local/bin/elastos"
    chown root:root "/usr/local/bin/elastos"
    chmod 0755 "/usr/local/bin/elastos"

    ynh_add_config \
        --template="sudoers" \
        --destination="/etc/sudoers.d/$app"
    # sudoers files MUST be owned by root:root with mode 0440, otherwise
    # sudo refuses to read them ("owned by uid X, should be 0").
    chown root:root "/etc/sudoers.d/$app"
    chmod 0440 "/etc/sudoers.d/$app"
    if ! visudo -c -f "/etc/sudoers.d/$app" >/dev/null 2>&1; then
        ynh_secure_remove --file="/etc/sudoers.d/$app"
        ynh_print_warn --message="sudoers file failed visudo check, removed."
    fi
}
