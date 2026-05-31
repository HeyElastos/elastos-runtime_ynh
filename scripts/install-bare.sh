#!/usr/bin/env bash
#
# Elastos Runtime + Hey capsule pack — one-shot installer for a FRESH
# Ubuntu server, with NO YunoHost and NO domain name (IP-only, HTTP).
#
# After it finishes, Home is reachable at:
#     http://<your-vps-ip>/apps/home/
#
# One-command install (run as root on a clean Ubuntu 22.04/24.04 amd64 box):
#
#     curl -fsSL https://raw.githubusercontent.com/HeyElastos/elastos-runtime_ynh/main/scripts/install-bare.sh | sudo bash
#
# What it does (identical pipeline to the YunoHost package, minus YunoHost):
#   1. installs apt deps + a build swapfile if RAM < 4 GB
#   2. clones THIS repo (carries UPSTREAM_VERSION, scripts/patches/*, conf/)
#   3. fetches upstream Elacity/elastos-runtime @ UPSTREAM_VERSION and
#      APPLIES your scripts/patches/*.patch  ← "runtime with my patches"
#   4. fetches the HeyElastos/Hey-capsule pack and lays in every Hey capsule
#   5. builds the runtime + native/WASM capsules from source (20-40 min cold)
#   6. bootstraps a temp local publisher, runs `elastos setup --with <all>`,
#      applies the Hey theme, tears the temp publisher down
#   7. installs a systemd service (kubo + `elastos serve` + room gateway) and
#      an nginx reverse proxy on port 80 (default_server, IP-only)
#
# It does this by defining the YunoHost `ynh_*` shell helpers as plain bash
# and then running the package's real `scripts/install` unchanged — so the
# patch + pack + bootstrap logic stays in ONE tested place.
#
# Overridable via env, e.g.  REPO_REF=mybranch sudo -E bash install-bare.sh
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────
APP="${APP:-elastos}"
INSTALL_DIR="${INSTALL_DIR:-/opt/$APP/runtime}"
DATA_DIR="${DATA_DIR:-/var/lib/$APP}"
PORT="${PORT:-8090}"                                   # room gateway (nginx fronts it on :80)
REPO_URL="${REPO_URL:-https://github.com/HeyElastos/elastos-runtime_ynh}"
REPO_REF="${REPO_REF:-main}"
HELPERS_FILE="/usr/share/yunohost/helpers"             # where `scripts/install` sources helpers from

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run as root:  curl -fsSL <url> | sudo bash"
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = ubuntu ] || echo "WARN: tested on Ubuntu; '${ID:-unknown}' may need tweaks." >&2
[ "$(uname -m)" = x86_64 ] || echo "WARN: kubo pin is linux-amd64; on arm64 edit download_external_binaries." >&2

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="<your-vps-ip>"

# ── 1. Dependencies ──────────────────────────────────────────────────
log "Installing apt dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 openssl jq \
    build-essential pkg-config libssl-dev libclang-dev cmake \
    qemu-system-x86 qemu-utils nodejs npm nginx sudo util-linux

# Cold `cargo --release` of the workspace peaks ~4 GB. On a small droplet,
# add a swapfile so the build doesn't get OOM-killed.
mem_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo)"
if [ "${mem_kb:-0}" -lt 4000000 ] && [ ! -e /swapfile ]; then
    log "RAM < 4 GB — creating a 4 GB build swapfile"
    fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
    chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── 2. App user + dirs + repo clone ──────────────────────────────────
log "Creating system user '$APP' and directories"
id -u "$APP" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/$APP" --shell /bin/bash "$APP"
# The packaged sudoers rule grants the `admins` group passwordless `elastos`;
# create the group so sudo doesn't choke parsing a rule for a missing group.
groupadd -f admins
mkdir -p "$INSTALL_DIR" "$DATA_DIR" "/var/log/$APP"
chown -R "$APP:$APP" "$DATA_DIR" "/var/log/$APP"

log "Cloning $REPO_URL ($REPO_REF) into $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_REF" && git -C "$INSTALL_DIR" reset --hard FETCH_HEAD
else
    rm -rf "$INSTALL_DIR"; mkdir -p "$INSTALL_DIR"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
fi
chown -R "$APP:$APP" "$INSTALL_DIR"

# ── 3. YunoHost-helper shim ──────────────────────────────────────────
# Replace every ynh_* helper the package's scripts/install + _common.sh use
# with a plain-bash equivalent, so we can run the REAL install unchanged.
log "Installing ynh_* compatibility shim → $HELPERS_FILE"
mkdir -p "$(dirname "$HELPERS_FILE")"
cat > "$HELPERS_FILE" <<'SHIM'
# ynh_* shim for a bare (non-YunoHost) install. Functions read $app,
# $install_dir, $data_dir, $port, $path from the environment at call time.

ynh_script_progression() { local m=; for a in "$@"; do case $a in --message=*) m=${a#*=};; esac; done; printf '  > %s\n' "$m"; }
ynh_print_warn()         { local m=; for a in "$@"; do case $a in --message=*) m=${a#*=};; esac; done; printf 'WARN: %s\n' "$m" >&2; }
ynh_die()                { local m=; for a in "$@"; do case $a in --message=*) m=${a#*=};; esac; done; printf 'FATAL: %s\n' "$m" >&2; exit 1; }
ynh_secure_remove()      { local f=; for a in "$@"; do case $a in --file=*) f=${a#*=};; esac; done; [ -n "$f" ] && rm -rf "$f"; }
ynh_exec_warn_less()     { "$@"; }
ynh_exec_as()            { local u=$1; shift; runuser -u "$u" -- "$@"; }
yunohost()               { :; }   # swallow `yunohost service add ...`

# Fetch a [resources.sources.<id>] tarball into --dest_dir, stripping the
# top-level dir. The "main" source is this repo, already cloned → no-op.
ynh_setup_source() {
    local dest= sid=main
    for a in "$@"; do case $a in --dest_dir=*) dest=${a#*=};; --source_id=*) sid=${a#*=};; esac; done
    [ "$sid" = main ] && { mkdir -p "$dest"; return 0; }
    local url
    url="$(awk -v s="[resources.sources.$sid]" '
        { line=$0; gsub(/^[ \t]+/,"",line) }
        line==s { inn=1; next }
        /^[ \t]*\[/ { inn=0 }
        inn && $1=="url" { for(i=1;i<=NF;i++) if($i ~ /^"/){ gsub(/"/,"",$i); print $i; exit } }' \
        "$install_dir/manifest.toml")"
    [ -n "$url" ] || ynh_die --message="shim: no url for source_id=$sid in manifest.toml"
    local tmp; tmp="$(mktemp -d)"
    curl -fsSL "$url" -o "$tmp/s.tgz" || ynh_die --message="shim: download failed: $url"
    mkdir -p "$dest"; tar -xzf "$tmp/s.tgz" -C "$tmp"
    local top; top="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)"
    cp -a "$top/." "$dest/"; rm -rf "$tmp"
}

# Render a conf/ template (substitute the __VARS__ the templates use).
_render() {
    sed -e "s|__APP__|$app|g" -e "s|__INSTALL_DIR__|$install_dir|g" \
        -e "s|__DATA_DIR__|$data_dir|g" -e "s|__PORT__|$port|g" \
        -e "s|__PATH__|$path|g" "$1"
}
ynh_add_config() {
    local tpl= dst=
    for a in "$@"; do case $a in --template=*) tpl=${a#*=};; --destination=*) dst=${a#*=};; esac; done
    mkdir -p "$(dirname "$dst")"; _render "$install_dir/conf/$tpl" > "$dst"
}
ynh_add_systemd_config() {
    _render "$install_dir/conf/systemd.service" > "/etc/systemd/system/$app.service"
    systemctl daemon-reload; systemctl enable "$app" >/dev/null 2>&1 || true
}
# IP-only: wrap the package's location blocks in a default_server on :80.
ynh_add_nginx_config() {
    local body; body="$(_render "$install_dir/conf/nginx.conf")"
    cat > "/etc/nginx/sites-available/$app" <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 200M;
$body
}
NGINX
    rm -f /etc/nginx/sites-enabled/default
    ln -sf "/etc/nginx/sites-available/$app" "/etc/nginx/sites-enabled/$app"
    nginx -t && systemctl reload nginx
}
ynh_systemd_action() {
    local svc= act= lm= lp=
    for a in "$@"; do case $a in
        --service_name=*) svc=${a#*=};; --action=*) act=${a#*=};;
        --line_match=*) lm=${a#*=};; --log_path=*) lp=${a#*=};;
    esac; done
    systemctl "$act" "$svc"
    if [ -n "$lm" ] && [ -n "$lp" ]; then
        local i; for i in $(seq 1 180); do grep -qF "$lm" "$lp" 2>/dev/null && break; sleep 1; done
    fi
}
SHIM

# ── 4. Variables the package's install/_common expect (YNH normally injects) ──
export app="$APP"
export install_dir="$INSTALL_DIR"
export data_dir="$DATA_DIR"
export port="$PORT"
export domain="$PUBLIC_IP"
export path=""                 # IP-only: nginx locations unprefixed; Home at /apps/home/
export admin="root"

# ── 5. Run the REAL package installer under the shim ──────────────────
log "Running the Elastos Runtime source install (cold build is 20-40 min)…"
( cd "$INSTALL_DIR/scripts" && bash ./install )

# ── 6. Open the firewall (if ufw is active) ──────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null 2>&1 || true
fi

cat <<DONE

✓ Elastos Runtime + Hey capsules installed.

  Home:     http://$PUBLIC_IP/apps/home/
  Service:  systemctl status $app
  Logs:     journalctl -u $app -f   (or /var/log/$app/$app.log)
  CLI:      sudo -u $app $DATA_DIR/home/.local/bin/elastos <command>

  Note: this is plain HTTP on an IP. Browser passkey/WebAuthn features
  need a secure context (HTTPS + a domain). For LAN/testing this is fine;
  put it behind a domain + TLS later for full auth.
DONE
