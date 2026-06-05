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

# Open the UDP port carrier-gossip's iroh endpoint binds — it hardcodes
# `bind_addr 0.0.0.0:4433` (upstream elastos-server/src/carrier.rs). YunoHost's
# firewall blocks everything not explicitly allowed, so without this two
# separate runtimes can never form the iroh gossip mesh: cross-runtime DM
# invites, friend requests and message delivery silently hang ("invite
# pending") because the inbound dial is dropped. We open it directly rather
# than via [resources.ports] because that resource auto-allocates a free port,
# but carrier-gossip needs EXACTLY 4433. Idempotent; --no-upnp leaves the
# router alone (both Hey runtimes are public VPSes with routable IPs).
PEER_UDP_PORT=4433

# Is a port ACTUALLY open in the live kernel ruleset? `yunohost firewall list`
# under-reports UDP on some builds (it showed only TCP even with UDP 4433/7842
# live in nft), so we read the real source of truth: nftables, falling back to
# iptables. This is what lets ensure_firewall_port detect a silent allow failure.
_firewall_port_live() {
    local proto port
    proto=$(echo "$1" | tr 'A-Z' 'a-z'); port="$2"
    if command -v nft >/dev/null 2>&1; then
        nft list ruleset 2>/dev/null | grep -iE "${proto} dport" | grep -qw "$port" && return 0
    fi
    iptables -L INPUT -n 2>/dev/null | grep -iE "${proto}" | grep -qw "dpt:${port}" && return 0
    return 1
}

# Allow a firewall port and CONFIRM it opened. The old bare `allow … || warn`
# swallowed failures, so a box could end up silently blocked — cross-runtime
# carrier-gossip then never forms a topic neighbor (invites/DMs/feed hang). We
# allow, verify against the live ruleset, retry once (without --no-upnp in case
# a build rejects the flag), and only then warn LOUDLY with the manual command.
ensure_firewall_port() {
    local proto="$1" port="$2"
    _firewall_port_live "$proto" "$port" && return 0
    yunohost firewall allow "$proto" "$port" --no-upnp >/dev/null 2>&1 || true
    _firewall_port_live "$proto" "$port" && return 0
    yunohost firewall allow "$proto" "$port" >/dev/null 2>&1 || true
    _firewall_port_live "$proto" "$port" && return 0
    ynh_print_warn --message="FIREWALL: ${proto} ${port} is NOT open after allow — cross-runtime P2P (carrier-gossip iroh) will fail. Open it manually: yunohost firewall allow ${proto} ${port}"
    return 1
}

open_peer_firewall_port() {
    ynh_script_progression --message="Opening UDP $PEER_UDP_PORT for cross-runtime P2P (carrier-gossip iroh)..." --weight=1
    ensure_firewall_port UDP "$PEER_UDP_PORT"
}

# ────────────────────────────────────────────────────────────────────
# Self-hosted iroh-relay — n0-independent gossip federation
# ────────────────────────────────────────────────────────────────────
#
# carrier-gossip forms a topic NeighborUp over a RELAY when a direct UDP path
# isn't available (NAT, or a provider that filters 4433). Out of the box iroh
# falls back to n0's public relays, which are third-party and (observed) flaky
# for our WAN traffic — invites sit "pending" because the neighbor never forms.
# To be fully sovereign, every PUBLIC install runs its OWN iroh-relay and homes
# on it (the wrapper does this when it detects a public IP); its node ticket
# then advertises that relay so peers — including NAT'd laptops — reach it with
# zero n0 dependency. NAT'd installs can't host a reachable relay, so they home
# on a baked-in default public relay. Payloads are E2E-encrypted (sealed-sender
# v2), so the relay only ever forwards ciphertext.
#
# The relay binary MUST match the runtime's iroh client (1.0.0-rc.1) or the protocol
# won't pair. CRITICAL: the client always does QUIC Address Discovery on UDP
# 7842 (carrier.rs: quic:Some(Default::default())), so the relay MUST run a real
# config with enable_quic_addr_discovery=true binding [::]:7842 + TLS — NOT
# `iroh-relay --dev` (binds no QUIC → discovery silently degrades, which is the
# exact "neighbor never forms" failure we're fixing). nginx owns :443, so the
# relay serves HTTPS on :8443 reusing YunoHost's cert. The node's own iroh
# endpoint stays on UDP :4433 (opened by open_peer_firewall_port).
RELAY_HTTPS_PORT=8443
RELAY_QUIC_PORT=7842
# Relay that NAT'd installs home on (a public install's relay = the pool).
# Override per-deploy with $HEY_RELAY_DEFAULT_URL.
HEY_RELAY_DEFAULT_URL="${HEY_RELAY_DEFAULT_URL:-https://relay.heyelastos.com}"

# Federation relay list. EVERY node embeds this FULL list in its RelayMap
# (carrier patch 0009 parses it). Purpose: ZERO-CONFIG + home-relay REDUNDANCY —
# both known relays are present from boot (no hand-edited .relay-url), and a node
# homes on its lowest-latency reachable entry, so it survives its OWN relay going
# down. (Reaching a peer does NOT actually need the peer's relay in this list:
# iroh 0.96 dials any peer-advertised relay regardless of the local map — so this
# is resilience + convenience, not a hard requirement.) A public host prepends
# its OWN relay (homes there by latency); others use the list as-is. Comma/space
# separated; override with $HEY_RELAY_FEDERATION_URLS. HEY_RELAY_FEDERATION=0
# disables the feature.
HEY_RELAY_FEDERATION_URLS="${HEY_RELAY_FEDERATION_URLS:-https://test.elastos.app:8443,https://elastos.app:8443}"

# Public relay(s) appended AFTER the self-hosted federation as a LAST-RESORT home
# relay, so a node stays reachable even if EVERY self-hosted federation relay is
# down. The carrier (patch 0009) homes on the lowest-latency REACHABLE entry, so
# this only takes over on a full self-hosted outage — normal operation still
# prefers the closer federation relay. Default = the project's public relay; set
# to n0's hosted relays (e.g. https://use1-1.relay.iroh.network) for an always-on
# fallback, or empty to disable. Comma/space separated.
HEY_RELAY_PUBLIC_FALLBACK_URLS="${HEY_RELAY_PUBLIC_FALLBACK_URLS:-$HEY_RELAY_DEFAULT_URL}"

# IPFS content federation — the IPFS analog of the relay federation above. A
# file attachment's BYTES travel via content/IPFS by CID (not gossip), so the
# recipient's kubo must be able to FETCH the sender's blob. On the public DHT
# alone that is slow/unreliable; peering the federation's kubo nodes directly
# makes cross-runtime fetch ~1s. Each new runtime peers (kubo `Peering.Peers`,
# persisted + auto-reconnecting) with these content-hub nodes — the same hosts
# that run the relays. Comma/space separated kubo multiaddrs
# (/ip4/<ip>/tcp/4001/p2p/<peerid>); a node skips its own id. Override with
# $HEY_IPFS_FEDERATION_PEERS; HEY_IPFS_FEDERATION=0 disables.
HEY_IPFS_FEDERATION_PEERS="${HEY_IPFS_FEDERATION_PEERS:-/ip4/94.156.119.216/tcp/4001/p2p/12D3KooWSmM6N6Md7U6a2JrErgC8z1LuQ7gk2SSYo5GH7DzSjCYH,/ip4/94.156.119.217/tcp/4001/p2p/12D3KooWSCpnJLdik75T9G46BfcHCSw7rvD4mtbCGHHZJes4jbGu}"
# kubo HTTP API the runtime brings up alongside `serve` (standard local port).
HEY_IPFS_API="${HEY_IPFS_API:-http://127.0.0.1:5001}"

# A host is PUBLIC iff it has a globally-scoped IPv4 that is not RFC1918 /
# loopback / link-local. HEY_FORCE_SELF_RELAY=1 overrides for a NAT-behind-
# port-forward host; HEY_RELAY_FEDERATION=0 is the global kill switch (never run
# a relay, fall through to the default/n0 — north-star removable).
detect_public_ipv4() {
    local ip
    for ip in $(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1); do
        case "$ip" in
            10.*|127.*|169.254.*|192.168.*) continue ;;
            172.1[6-9].*|172.2[0-9].*|172.3[01].*) continue ;;
            *) echo "$ip"; return 0 ;;
        esac
    done
    return 1
}
is_public_host() {
    [ "${HEY_FORCE_SELF_RELAY:-0}" = "1" ] && return 0
    [ "${HEY_RELAY_FEDERATION:-1}" = "1" ] || return 1
    detect_public_ipv4 >/dev/null
}

# Open / close the relay listen ports. TCP 8443 = HTTPS relay transport; UDP
# 7842 = QUIC address discovery (the client probes exactly 7842 — opening it is
# mandatory or QAD silently degrades).
open_relay_firewall_ports() {
    ynh_script_progression --message="Opening relay ports TCP $RELAY_HTTPS_PORT + UDP $RELAY_QUIC_PORT (self-hosted iroh-relay)..." --weight=1
    ensure_firewall_port TCP "$RELAY_HTTPS_PORT"
    ensure_firewall_port UDP "$RELAY_QUIC_PORT"
}
close_relay_firewall_ports() {
    yunohost firewall disallow TCP "$RELAY_HTTPS_PORT" --no-upnp >/dev/null 2>&1 || true
    yunohost firewall disallow UDP "$RELAY_QUIC_PORT" --no-upnp >/dev/null 2>&1 || true
}

# Compose the COMMA-separated relay list written to .relay-url: the node's own
# relay first (arg $1, only when it runs one) followed by the federation list,
# de-duplicated, order preserved. Output is COMMA-only (no spaces) on purpose —
# the wrapper runs `tr -d '[:space:]'` over the file before exporting it, so a
# space-separated list would fuse into one garbage URL. The carrier (patch 0009)
# splits on commas. Empty result falls back to the single default relay.
compose_relay_list() {
    local own="$1"
    local out="" url
    # Order: own relay (homes by latency) → self-hosted federation → public
    # fallback. The carrier homes on the lowest-latency REACHABLE entry, so the
    # public fallback only takes over when every self-hosted relay is down.
    for url in "$own" \
        $(printf '%s' "$HEY_RELAY_FEDERATION_URLS" | tr ',' ' ') \
        $(printf '%s' "$HEY_RELAY_PUBLIC_FALLBACK_URLS" | tr ',' ' '); do
        [ -n "$url" ] || continue
        case ",$out," in *",$url,"*) continue ;; esac   # already present — skip
        out="${out:+$out,}$url"
    done
    [ -n "$out" ] || out="$HEY_RELAY_DEFAULT_URL"
    printf '%s' "$out"
}

# Write (or clear) the relay URL(s) the wrapper injects into `serve` as
# ELASTOS_RELAY_URL. Accepts a single URL or a comma-separated federation list
# (see compose_relay_list). Empty => remove the file => carrier
# RelayMode::Default (n0) — the vanilla, north-star-removable fallback.
write_relay_env() {
    local url="$1"
    local f
    f="$(elastos_home)/xdg-data/elastos/.relay-url"
    mkdir -p "$(dirname "$f")"
    if [ -n "$url" ]; then
        printf '%s' "$url" > "$f"
        chown "$app:$app" "$f"
        chmod 0644 "$f"
        echo "relay env: ELASTOS_RELAY_URL=$url"
    else
        rm -f "$f"
    fi
}

# Build + install the iroh-relay 1.0.0-rc.1 server binary into the client bin/.
# Pinned to 1.0.0-rc.1 to match the runtime's iroh client. Built with the already-
# installed Rust toolchain. Idempotent. NON-FATAL: a build failure leaves the
# runtime on the default/n0 relay.
install_iroh_relay() {
    local client_bin
    client_bin="$(elastos_home)/xdg-data/elastos/bin"
    mkdir -p "$client_bin"
    chown -R "$app:$app" "$client_bin"
    if [ -x "$client_bin/iroh-relay" ]; then
        echo "iroh-relay already installed"
        return 0
    fi
    if [ ! -x "$(rustup_root)/cargo/bin/cargo" ]; then
        ynh_print_warn --message="No Rust toolchain — skipping iroh-relay build (relay federation disabled)."
        return 1
    fi
    ynh_script_progression --message="Building iroh-relay 1.0.0-rc.1 (n0-independent relay)..." --weight=40
    local relay_root="$install_dir/.iroh-relay-build"
    rm -rf "$relay_root"
    mkdir -p "$relay_root"
    chown -R "$app:$app" "$relay_root"
    if cargo_as_app install --root "$relay_root" --version 1.0.0-rc.1 --features server iroh-relay; then
        install -m 0755 -o "$app" -g "$app" "$relay_root/bin/iroh-relay" "$client_bin/iroh-relay"
        echo "  installed bin/iroh-relay (1.0.0-rc.1)"
        rm -rf "$relay_root"
        return 0
    fi
    ynh_print_warn --message="iroh-relay 1.0.0-rc.1 build failed — relay federation disabled; runtime uses the default/n0 relay. (Re-run the upgrade to retry.)"
    rm -rf "$relay_root"
    return 1
}

# Stand up the relay sidecar on a public host: build the binary, template the
# config + systemd unit, grant cert read (YunoHost key.pem is root:ssl-cert
# 0640), register + (re)start the ${app}-relay service. Returns 0 ONLY if the
# service ends up active — the caller then homes on it; otherwise it falls back
# to the default pool so a node never homes on a relay that isn't running.
# Idempotent — safe on every upgrade (re-copies the binary + re-templates so an
# iroh-relay version bump propagates).
install_relay_sidecar() {
    install_iroh_relay || return 1

    # Manual-TLS relay runs as $app and must read YunoHost's cert. key.pem is
    # typically root:ssl-cert 0640; add $app to ssl-cert (crt.pem is world-
    # readable). The (re)started unit picks up the new supplementary group.
    if getent group ssl-cert >/dev/null 2>&1; then
        usermod -aG ssl-cert "$app" >/dev/null 2>&1 || true
    fi

    ynh_add_config --template="iroh-relay.toml" \
        --destination="$install_dir/conf/iroh-relay.toml"
    chown "$app:$app" "$install_dir/conf/iroh-relay.toml"

    ynh_add_systemd_config --service="${app}-relay" --template="iroh-relay.service"
    yunohost service add "${app}-relay" \
        --description="Hey iroh-relay (federated P2P relay)" \
        --log="/var/log/$app/iroh-relay.log" >/dev/null 2>&1 || true

    ynh_systemd_action --service_name="${app}-relay" --action="restart" >/dev/null 2>&1 || true
    sleep 2
    if systemctl is-active --quiet "${app}-relay"; then
        return 0
    fi
    ynh_print_warn --message="${app}-relay failed to start (check /var/log/$app/iroh-relay.log — likely TLS cert read perms or a port clash). Homing on the default relay pool instead."
    return 1
}

# Tear the relay sidecar down (scripts/remove).
remove_relay_sidecar() {
    ynh_systemd_action --service_name="${app}-relay" --action="stop" >/dev/null 2>&1 || true
    yunohost service remove "${app}-relay" >/dev/null 2>&1 || true
    ynh_remove_systemd_config --service="${app}-relay" >/dev/null 2>&1 || true
    close_relay_firewall_ports
}

# Configure kubo Peering.Peers from $HEY_IPFS_FEDERATION_PEERS so file
# attachments fetch across runtimes (the IPFS analog of the relay federation).
# Runs AFTER `serve` starts (kubo's API must be up). Persists to kubo config
# (survives restart, verified) AND does a live `swarm peering add` for immediate
# effect. Idempotent. NON-FATAL: a failure just leaves cross-runtime file fetch
# reliant on the slow public DHT — install/upgrade still succeeds. A node skips
# its own peer id. Re-runnable any time via scripts/configure-ipfs-peering.sh.
configure_ipfs_peering() {
    [ "${HEY_IPFS_FEDERATION:-1}" = "1" ] || { echo "ipfs federation disabled"; return 0; }
    local peers="$HEY_IPFS_FEDERATION_PEERS" api="$HEY_IPFS_API"
    [ -n "$peers" ] || return 0

    # Wait for the kubo API (the runtime brings it up shortly after serve).
    local up="" i
    for i in $(seq 1 30); do
        curl -fsS -m 3 -X POST "$api/api/v0/id" >/dev/null 2>&1 && { up=1; break; }
        sleep 2
    done
    [ -n "$up" ] || {
        ynh_print_warn --message="kubo API ($api) not reachable — skipping IPFS peering. File attachments may not fetch across runtimes until you run: bash scripts/configure-ipfs-peering.sh"
        return 0
    }

    local self addr id ipaddr json="[" first=1
    self="$(curl -fsS -m 4 -X POST "$api/api/v0/id" 2>/dev/null | sed -n 's/.*"ID":"\([^"]*\)".*/\1/p')"
    for addr in $(printf '%s' "$peers" | tr ',' ' '); do
        [ -n "$addr" ] || continue
        id="${addr##*/p2p/}"
        [ -n "$id" ] && [ "$id" = "$self" ] && continue          # never peer with self
        ipaddr="${addr%/p2p/*}"
        [ "$first" = 1 ] || json="$json,"
        json="$json{\"ID\":\"$id\",\"Addrs\":[\"$ipaddr\"]}"
        first=0
        # Live peering (immediate; the config below makes it survive restart).
        curl -fsS -m 8 -X POST "$api/api/v0/swarm/peering/add?arg=$addr" >/dev/null 2>&1 || true
    done
    json="$json]"

    if [ "$first" = 1 ]; then
        echo "ipfs peering: only self in the federation list — nothing to peer"
        return 0
    fi
    if curl -fsS -G -m 8 -X POST "$api/api/v0/config" \
        --data-urlencode "arg=Peering.Peers" \
        --data-urlencode "arg=$json" \
        --data "json=true" >/dev/null 2>&1; then
        echo "ipfs peering: configured Peering.Peers = $peers"
    else
        ynh_print_warn --message="ipfs config Peering.Peers failed — run: bash scripts/configure-ipfs-peering.sh"
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
        bash -c 'curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.91 --profile minimal'

    ynh_exec_warn_less ynh_exec_as "$app" \
        env RUSTUP_HOME="$root/rustup" \
            CARGO_HOME="$root/cargo" \
            PATH="$root/cargo/bin:/usr/bin:/bin" \
        bash -c "rustup target add --toolchain 1.91 wasm32-wasip1"
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
# Prebuilt binaries — download instead of the 20-40 min cargo/wasm build
# ────────────────────────────────────────────────────────────────────
#
# If a prebuilt release exists for this arch, fetch + extract it into
# $install_dir/elastos/target/ and SKIP build_runtime_and_capsules. The
# tarball is produced by .github/workflows/prebuilt-release.yml and contains
# exactly the target/ subset build_runtime_and_capsules produces (debug/elastos
# + release/<providers> + wasm32-wasip1/release/<capsules>.wasm).
#
# Returns 0 = prebuilt in place (caller skips the build); 1 = build from source.
# Override URL with $ELASTOS_PREBUILT_URL; force a source build with
# ELASTOS_FORCE_BUILD=1.
#
# The prebuilt is PINNED to an explicit release tag ($PREBUILT_TAG), never
# 'latest'. EMPTY (the default) means "no prebuilt published for the current
# patch set" → always source-build, so new carrier patches in scripts/patches/
# actually get compiled. This is deliberate: a stale 'latest' prebuilt MUST NOT
# be able to shadow newer patches (that bug shipped an unpatched carrier and
# silently dropped patches 0007/0008/0009). After cutting a prebuilt that
# INCLUDES the current patches, set PREBUILT_TAG to its release tag (here, or via
# $ELASTOS_PREBUILT_TAG) and installs are fast again — until the next patch bump.
PREBUILT_TAG="${ELASTOS_PREBUILT_TAG:-}"
maybe_download_prebuilt() {
    local target_dir="$1"
    if [ "${ELASTOS_FORCE_BUILD:-0}" = "1" ]; then
        return 1
    fi
    if [ -z "$PREBUILT_TAG" ]; then
        ynh_script_progression --message="No prebuilt pinned for this version (PREBUILT_TAG empty) — building from source so patches apply." --weight=1
        return 1
    fi
    local arch
    case "$(uname -m)" in
        x86_64|amd64)  arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) ynh_print_warn --message="prebuilt: unsupported arch $(uname -m); building from source"; return 1 ;;
    esac
    local url="${ELASTOS_PREBUILT_URL:-https://github.com/HeyElastos/elastos-runtime_ynh/releases/download/$PREBUILT_TAG/prebuilt-linux-$arch.tar.gz}"
    local tmp; tmp="$(mktemp -d)"
    ynh_script_progression --message="Fetching prebuilt binaries ($arch)..." --weight=10
    if ! curl -fsSL "$url" -o "$tmp/p.tar.gz"; then
        ynh_print_warn --message="prebuilt: not available ($url); building from source"
        rm -rf "$tmp"; return 1
    fi
    # Integrity: verify against the sibling .sha256 if the release ships one.
    if curl -fsSL "$url.sha256" -o "$tmp/p.sha256" 2>/dev/null && [ -s "$tmp/p.sha256" ]; then
        local want got
        want="$(awk '{print $1}' "$tmp/p.sha256")"
        got="$(sha256sum "$tmp/p.tar.gz" | awk '{print $1}')"
        if [ -n "$want" ] && [ "$want" != "$got" ]; then
            ynh_print_warn --message="prebuilt: sha256 mismatch (want $want, got $got); building from source"
            rm -rf "$tmp"; return 1
        fi
    fi
    mkdir -p "$target_dir/elastos"
    if ! tar -xzf "$tmp/p.tar.gz" -C "$target_dir/elastos"; then
        ynh_print_warn --message="prebuilt: extract failed; building from source"
        rm -rf "$tmp"; return 1
    fi
    rm -rf "$tmp"
    if [ ! -x "$target_dir/elastos/target/debug/elastos" ]; then
        ynh_print_warn --message="prebuilt: archive missing target/debug/elastos; building from source"
        return 1
    fi
    chown -R "$app:$app" "$target_dir/elastos/target" 2>/dev/null || true
    ynh_script_progression --message="Prebuilt binaries installed — skipping the source build." --weight=1
    return 0
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

    # peer-provider: decentralized iroh-gossip node backing elastos://peer/* (DM
    # invites, follow requests, cross-runtime message delivery). Uses iroh-gossip
    # 0.100 / iroh 1.0.0-rc.1, so it needs rustc 1.91 like blobs-provider — `cd`
    # into the crate dir for its rust-toolchain.toml pin. CARGO_TARGET_DIR lands
    # the binary in the shared target/release tree. No new runtime patch — patch
    # 0003 already authorizes the peer scheme; zero operator config (auto P2P).
    ynh_exec_as "$app" \
        env RUSTUP_HOME="$(rustup_root)/rustup" \
            CARGO_HOME="$(rustup_root)/cargo" \
            PATH="$(rustup_root)/cargo/bin:/usr/local/bin:/usr/bin:/bin" \
            CARGO_TARGET_DIR="$install_dir/elastos/target" \
        sh -c "cd '$install_dir/capsules/peer-provider' && cargo build --release"

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
