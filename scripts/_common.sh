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

# ────────────────────────────────────────────────────────────────────
# Upstream Elastos Runtime fetch
# ────────────────────────────────────────────────────────────────────
#
# Per docs/HEY_MODULAR_ARCHITECTURE.md, we do NOT vendor upstream
# source in git. The version is pinned by ./UPSTREAM_VERSION (a single
# line — tag or sha) and the install/upgrade scripts fetch the tarball
# fresh. Our Hey-additive capsules sit alongside.

fetch_upstream_source() {
    local target_dir="$1"
    local version
    version="$(cat "$target_dir/UPSTREAM_VERSION" 2>/dev/null | tr -d '[:space:]')"
    if [ -z "$version" ]; then
        ynh_die --message="UPSTREAM_VERSION not found in $target_dir — refusing to fetch upstream."
    fi

    local tarball_url="https://github.com/Elacity/elastos-runtime/archive/${version}.tar.gz"
    local tmp_dir="$target_dir/.upstream-fetch"

    rm -rf "$tmp_dir"
    mkdir -p "$tmp_dir"

    ynh_script_progression --message="Fetching upstream Elastos Runtime $version..." --weight=3
    curl -fsSL "$tarball_url" -o "$tmp_dir/upstream.tar.gz" \
        || ynh_die --message="Failed to download upstream tarball: $tarball_url"
    tar -xzf "$tmp_dir/upstream.tar.gz" -C "$tmp_dir" \
        || ynh_die --message="Failed to extract upstream tarball."

    # The tarball extracts to elastos-runtime-<something>/ — pick that
    # up dynamically so we work for both tag names and bare commit shas.
    local extracted
    extracted="$(find "$tmp_dir" -maxdepth 1 -mindepth 1 -type d -name 'elastos-runtime-*' | head -n 1)"
    if [ -z "$extracted" ]; then
        ynh_die --message="Upstream tarball didn't extract to elastos-runtime-* — layout changed?"
    fi

    # Move upstream's elastos/ crate workspace into place. Force-replace
    # because re-fetches must always reflect the pinned version exactly.
    rm -rf "$target_dir/elastos"
    mv "$extracted/elastos" "$target_dir/elastos"

    # Lay out upstream capsules under $target_dir/capsules/. Hey
    # capsules don't live here anymore — they're fetched separately by
    # fetch_hey_capsules() from HeyElastos/Hey-capsule and dropped in
    # alongside afterward. If upstream and the Hey pack ever ship the
    # same capsule name, the Hey pack wins (it's applied last).
    mkdir -p "$target_dir/capsules"
    for upstream_capsule in "$extracted/capsules"/*/; do
        local name
        name="$(basename "$upstream_capsule")"
        cp -r "$upstream_capsule" "$target_dir/capsules/$name"
    done

    # Merge upstream's components.json with our additions. Upstream is
    # the base; our entries layer on top. Result lands at the canonical
    # path scripts/install reads from.
    python3 - <<PY
import json
upstream = json.load(open("$extracted/components.json"))
add = json.load(open("$target_dir/components.additions.json"))
upstream["external"].update(add["external"])
json.dump(upstream, open("$target_dir/components.json", "w"), indent=2)
PY

    # Apply targeted patches in scripts/patches/*.patch — these are
    # surgical additions on top of upstream that aren't yet in any
    # upstream release. Each patch should also be filed as an
    # upstream PR; the moment upstream merges, delete the file here.
    # Failing-to-apply is fatal — silently skipping would let a
    # patch rot against an upstream API change without anyone noticing.
    if [ -d "$target_dir/scripts/patches" ]; then
        local p
        for p in "$target_dir/scripts/patches"/*.patch; do
            [ -f "$p" ] || continue
            ynh_script_progression --message="Applying upstream patch $(basename "$p")..." --weight=1
            ( cd "$target_dir" && patch -p1 --forward < "$p" ) \
                || ynh_die --message="Upstream patch $(basename "$p") failed to apply. The upstream version pin may have moved past what the patch targets — review scripts/patches/ and either rebase the patch or drop it if upstream now ships the equivalent."
        done
    fi

    rm -rf "$tmp_dir"
    chown -R "$app:$app" "$target_dir/elastos" "$target_dir/capsules" "$target_dir/components.json"
}

# ────────────────────────────────────────────────────────────────────
# Hey capsule pack fetch
# ────────────────────────────────────────────────────────────────────
#
# Pull the Hey-specific capsules (hey-social, hey-chat, and the
# blobs/docs/webrtc-signal Rust providers) from HeyElastos/Hey-capsule.
# That repo is the canonical home for the pack; it stays YunoHost-
# agnostic and works against any Elastos Runtime. Pin is in
# manifest.toml's [resources.sources.hey_capsules]; ynh_setup_source
# fetches + verifies sha256 from there.
#
# Layout in the tarball:
#   capsules/{hey-social,hey-chat,blobs-provider,docs-provider,
#             webrtc-signal-provider}/
#   Cargo.toml (workspace, dev convenience only — not needed at runtime)
#   README.md  (pack docs)
#
# We extract to a staging dir, then move the pack's capsules/* into
# $target_dir/capsules/ alongside upstream stock capsules. Hey wins
# on name collision. Pack-level Cargo.toml is left at the staging
# extraction site (each provider is self-contained — no workspace
# inheritance — so building them in-place works without it).

fetch_hey_capsules() {
    local target_dir="$1"
    local stage_dir="$target_dir/.hey-capsules-fetch"

    rm -rf "$stage_dir"
    mkdir -p "$stage_dir"

    ynh_script_progression --message="Fetching Hey capsule pack..." --weight=3
    ynh_setup_source --dest_dir="$stage_dir" --source_id="hey_capsules" \
        || ynh_die --message="Failed to fetch the Hey capsule pack (resources.sources.hey_capsules)."

    if [ ! -d "$stage_dir/capsules" ]; then
        ynh_die --message="Hey capsule pack tarball missing capsules/ — layout changed?"
    fi

    mkdir -p "$target_dir/capsules"
    for pack_capsule in "$stage_dir/capsules"/*/; do
        local name
        name="$(basename "$pack_capsule")"
        # Hey wins on name collision with upstream.
        rm -rf "$target_dir/capsules/$name"
        cp -r "$pack_capsule" "$target_dir/capsules/$name"
    done

    rm -rf "$stage_dir"
    chown -R "$app:$app" "$target_dir/capsules"
}

# ────────────────────────────────────────────────────────────────────
# Hey app-capsule build (React / Vite)
# ────────────────────────────────────────────────────────────────────
#
# The Hey-capsule pack ships React SOURCE for app capsules (hey-social,
# hey-chat). The runtime install pipeline expects each app capsule
# to expose its built static bundle at the capsule root (index.html +
# assets/) so stage_publisher_artifacts can tar it up directly. This
# function walks every capsule under $install_dir/capsules/ that has a
# client/package.json, runs npm install + npm run build, then moves
# the dist/ output up to the capsule root. Run AFTER fetch_hey_capsules
# and BEFORE the publisher stage.
#
# Idempotent across upgrades: npm reuses its cache, and existing
# index.html/assets/ at the capsule root are overwritten with the
# freshly-built artifacts.

build_hey_app_capsules() {
    local target_dir="$1"
    local capsule_dir
    for capsule_dir in "$target_dir/capsules"/*/; do
        local name
        name="$(basename "$capsule_dir")"
        local client_dir="$capsule_dir/client"
        if [ -f "$client_dir/package.json" ]; then
            ynh_script_progression --message="Building $name (npm install + vite build)..." --weight=10

            # Run npm as $app so node_modules permissions match. ynh_exec_as
            # inherits PATH; the apt nodejs/npm binaries land in /usr/bin
            # which is already on the default app PATH.
            ynh_exec_as "$app" \
                sh -c "cd '$client_dir' && npm install --no-audit --no-fund --loglevel=error && npm run build" \
                || ynh_die --message="Failed to build $name capsule (npm install/build). Check that nodejs + npm are installed (apt resources)."

            local dist_dir="$client_dir/dist"
            if [ ! -f "$dist_dir/index.html" ]; then
                ynh_die --message="Build of $name finished but no $dist_dir/index.html — vite config issue?"
            fi

            # Move dist/ output up to the capsule root, replacing any
            # previous build artifacts (an upgrade picks up the new bundle).
            rm -rf "$capsule_dir/index.html" "$capsule_dir/assets"
            mv "$dist_dir/index.html" "$capsule_dir/index.html"
            if [ -d "$dist_dir/assets" ]; then
                mv "$dist_dir/assets" "$capsule_dir/assets"
            fi

            # Brand icons live under client/public/*.svg in the pack; the
            # publisher Python looks for *.svg at the capsule root. Copy
            # them up if present.
            if [ -d "$client_dir/public" ]; then
                local svg
                for svg in "$client_dir/public"/*.svg; do
                    [ -f "$svg" ] || continue
                    cp -f "$svg" "$capsule_dir/$(basename "$svg")"
                done
            fi
        elif [ -f "$capsule_dir/Trunk.toml" ]; then
            # Rust+Leptos+WASM app capsule (hey-social, and hey-chat once
            # it flips off React). CI / the dev machine builds it into dist/ and
            # commits that to the pack, so there is NO on-server trunk build —
            # we just relocate the pre-built bundle. The runtime serves capsule
            # files from the capsule ROOT (the entrypoint mounts at /apps/<app>/
            # and its relative ./xxx.js / ./xxx_bg.wasm URLs resolve there), so
            # the dist/* must be flattened up to the root exactly like the React
            # client/dist/* above — otherwise the WASM/JS 404 and the app boots
            # to a blank screen. capsule.json entrypoint must be "index.html".
            local dist_dir="$capsule_dir/dist"
            if [ ! -f "$dist_dir/index.html" ]; then
                ynh_die --message="$name has Trunk.toml but no $dist_dir/index.html in the pack — did CI fail to build it, or was dist/ left gitignored (it must be force-added)?"
            fi
            ynh_script_progression --message="Deploying $name (pre-built WASM, flattening dist/)..." --weight=1
            rm -f "$capsule_dir/index.html"        # drop the Trunk source template
            cp -af "$dist_dir/." "$capsule_dir/"   # overlay built index.html + hashed assets
            rm -rf "$dist_dir"
        else
            continue   # not an app capsule (Rust providers, static data, etc.)
        fi
    done

    chown -R "$app:$app" "$target_dir/capsules"
}

# Append the YunoHost-package frosted-glass theme overlay to
# upstream's home capsule style.css. The overlay lives at
# conf/home-overlay.css — a YunoHost-package-level concern, NOT
# part of the Hey capsule pack. This keeps the Hey capsules 100%
# portable: they install on any Elastos Runtime without the theme.
# The theme is purely a visual decision of THIS YunoHost package.
# Anyone forking the package can ship a different overlay file.
apply_hey_theme_overlay() {
    local data_root="$1"
    local target_style="$data_root/capsules/home/browser/style.css"
    local overlay="$install_dir/conf/home-overlay.css"

    if [ ! -f "$target_style" ]; then
        ynh_print_warn --message="hey-theme: $target_style missing — skipping overlay."
        return 0
    fi
    if [ ! -f "$overlay" ]; then
        ynh_print_warn --message="hey-theme: $overlay missing — skipping overlay."
        return 0
    fi

    # Idempotent: strip any prior overlay first, then append. The
    # marker comment makes the boundary deterministic so re-running
    # this on an upgrade replaces the previous overlay cleanly
    # instead of stacking copies.
    local marker="/* === HEY_THEME_OVERLAY_BEGIN === */"
    if grep -qF "$marker" "$target_style"; then
        sed -i "/$(echo "$marker" | sed 's/[][\.*^$(){}?+|/]/\\&/g')/,\$d" "$target_style"
    fi
    {
        printf '\n%s\n' "$marker"
        cat "$overlay"
        printf '%s\n' "/* === HEY_THEME_OVERLAY_END === */"
    } >> "$target_style"
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
        # Use openssl (already in apt deps) instead of xxd which isn't
        # installed on a stock Debian YunoHost — without it the prior
        # pipeline failed silently and the redirect left the key file
        # 0 bytes, which the wrapper then refused to export, which
        # made localhost-provider store every Users/* file in
        # plaintext. ynh_die if the key write fails so we never end
        # up with an empty key file masquerading as a valid one.
        sudo -u "$app" sh -c "openssl rand -hex 32 | tr -d '\n' > '$key_file'" \
            || ynh_die --message="Failed to generate localhost encryption key at $key_file"
        # Defense in depth: confirm the file actually has 64 hex chars
        # before declaring success. Catches the case where openssl was
        # in PATH but the redirect was blocked by permissions.
        local key_len
        key_len="$(wc -c <"$key_file" 2>/dev/null || echo 0)"
        if [ "$key_len" -lt 64 ]; then
            ynh_die --message="Localhost encryption key write produced $key_len bytes (expected 64). Aborting before plaintext-at-rest regression."
        fi
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
    # Note: notepad was removed in upstream v0.3.0; if it returns in a
    # later release add it back here.
    for crate in did-provider webspace-provider ipfs-provider; do
        cargo_as_app build --release --manifest-path "$install_dir/capsules/$crate/Cargo.toml"
    done

    # blobs-provider: iroh-blobs direct P2P file transfer for hey-chat.
    # Pinned to its own [workspace] + rust-toolchain.toml (rustc 1.91) because
    # iroh 1.0.0-rc.1 / iroh-blobs 0.102 need a newer toolchain than the rest
    # of the runtime. rustup discovers rust-toolchain.toml by walking up from
    # cargo's CWD, NOT from --manifest-path — so we must `cd` into the crate
    # dir for the toolchain pin to take effect. CARGO_TARGET_DIR is exported
    # by cargo_as_app, so the output still lands in the shared target/release
    # tree alongside the other capsule binaries.
    ynh_exec_as "$app" \
        env RUSTUP_HOME="$(rustup_root)/rustup" \
            CARGO_HOME="$(rustup_root)/cargo" \
            PATH="$(rustup_root)/cargo/bin:/usr/local/bin:/usr/bin:/bin" \
            CARGO_TARGET_DIR="$install_dir/elastos/target" \
        sh -c "cd '$install_dir/capsules/blobs-provider' && cargo build --release"

    # identity-projection-provider: runtime-held did:key signing (whoami/sign/
    # verify) so capsules don't keep Ed25519 seeds in localStorage. Its
    # rust-toolchain.toml pins rustc 1.91, discovered by walking up from cargo's
    # CWD — so `cd` into the crate dir (same reason as blobs-provider above).
    # CARGO_TARGET_DIR lands the binary in the shared target/release tree.
    ynh_exec_as "$app" \
        env RUSTUP_HOME="$(rustup_root)/rustup" \
            CARGO_HOME="$(rustup_root)/cargo" \
            PATH="$(rustup_root)/cargo/bin:/usr/local/bin:/usr/bin:/bin" \
            CARGO_TARGET_DIR="$install_dir/elastos/target" \
        sh -c "cd '$install_dir/capsules/identity-projection-provider' && cargo build --release"

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
