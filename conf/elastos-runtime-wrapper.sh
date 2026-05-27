#!/bin/bash
# systemd entrypoint:
#   1. start `elastos serve` (long-running operator runtime, default port 3000)
#   2. wait for BOTH runtime-coords.json to exist AND /api/health to respond
#      — `room open` validates coords against /proc/<pid> + attach-secret, so
#      both must be in place before we call it. The cords file is what
#      `room open` reads to find the runtime; just hitting /api/health is
#      not enough.
#   3. call `elastos room open` ONCE — it's one-shot: it POSTs to
#      /api/supervisor/start-gateway in `serve`, which spawns the actual
#      gateway process internally. `room open` then exits with 0. We must
#      NOT background it or treat its exit as a service failure.
#   4. wait on `serve` for the rest of the service lifetime.
#
# Templated by ynh: __INSTALL_DIR__, __DATA_DIR__, __PORT__, __APP__.

set -euo pipefail

export HOME="__DATA_DIR__/home"
export XDG_DATA_HOME="$HOME/xdg-data"
export IPFS_PATH="$XDG_DATA_HOME/ipfs"

ELASTOS_BIN="$HOME/.local/bin/elastos"
KUBO_BIN="$XDG_DATA_HOME/elastos/bin/kubo"
IPFS_PROVIDER_BIN="$XDG_DATA_HOME/elastos/bin/ipfs-provider"
COORDS_FILE="$XDG_DATA_HOME/elastos/runtime-coords.json"
LOG_DIR="$HOME/logs"
mkdir -p "$LOG_DIR"

# At-rest encryption for localhost-provider. The key file is generated
# (or carried over) by the install/upgrade scripts. The localhost-
# provider reads ELASTOS_LOCALHOST_ENCRYPTION_KEY at Init when its
# ProviderConfig.encryption_key is empty; once set, all writes are
# AES-256-GCM and on-disk state is ciphertext only.
LOCALHOST_KEY_FILE="$XDG_DATA_HOME/elastos/.localhost-key"
if [ -s "$LOCALHOST_KEY_FILE" ]; then
    export ELASTOS_LOCALHOST_ENCRYPTION_KEY="$(cat "$LOCALHOST_KEY_FILE")"
fi

# Approach A step 5d: server-enforced lock screen. With this on,
# browser sessions start in PreAuth (no capability tokens) and must
# complete /api/auth/unlock or /api/auth/setup before storage /
# provider calls succeed. The lock screen UI in hey-welcome.js
# becomes a real gate instead of CSS. Set to 0 (or unset + restart)
# to roll back to the legacy "auto-grant on visit" behavior — useful
# if anything goes wrong with the cookie→Bearer handshake or the
# unlock endpoint verification.
#
# To disable: comment the next line out, run
#   sudo systemctl restart elastos_runtime
export ELASTOS_AUTH_GATE=1

# ── IPFS backend (Kubo + ipfs-provider) ─────────────────────────────
# Hey Social and the IPFS provider capsule both need a running Kubo
# daemon. Without these subprocesses, /api/provider/ipfs/* returns
# errors and posting media fails. Started here so the systemd unit
# supervises them alongside `elastos serve` — they die when the unit
# stops and restart with it.
KUBO_PID=""
IPFS_PROVIDER_PID=""

if [ -x "$KUBO_BIN" ]; then
    # First-run repo init (idempotent — only writes config if missing).
    if [ ! -d "$IPFS_PATH" ]; then
        echo "Initializing Kubo repo at $IPFS_PATH..."
        "$KUBO_BIN" init >> "$LOG_DIR/kubo.log" 2>&1 || true
    fi
    # Disable telemetry — local-first capsule, no phone-home.
    "$KUBO_BIN" config Plugins.Plugins.telemetry.Config.Mode off >/dev/null 2>&1 || true
    "$KUBO_BIN" daemon >> "$LOG_DIR/kubo.log" 2>&1 < /dev/null &
    KUBO_PID=$!
    echo "Started kubo daemon PID $KUBO_PID (log: $LOG_DIR/kubo.log)"
    # Wait up to 30s for the RPC API to bind so ipfs-provider can connect.
    for _ in $(seq 1 30); do
        curl -fsS --max-time 1 http://127.0.0.1:5001/api/v0/version >/dev/null 2>&1 && break
        sleep 1
    done
fi

if [ -x "$IPFS_PROVIDER_BIN" ]; then
    "$IPFS_PROVIDER_BIN" >> "$LOG_DIR/ipfs-provider.log" 2>&1 < /dev/null &
    IPFS_PROVIDER_PID=$!
    echo "Started ipfs-provider PID $IPFS_PROVIDER_PID (log: $LOG_DIR/ipfs-provider.log)"
fi

"$ELASTOS_BIN" serve &
SERVE_PID=$!

trap '
    [ -n "$IPFS_PROVIDER_PID" ] && kill -TERM "$IPFS_PROVIDER_PID" 2>/dev/null || true
    [ -n "$KUBO_PID" ] && kill -TERM "$KUBO_PID" 2>/dev/null || true
    kill -TERM "$SERVE_PID" 2>/dev/null || true
    wait "$SERVE_PID" 2>/dev/null || true
    exit 0
' TERM INT

# Wait up to 60s for BOTH conditions.
for _ in $(seq 1 60); do
    if [ -f "$COORDS_FILE" ] && \
       curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if [ ! -f "$COORDS_FILE" ]; then
    echo "ERROR: runtime-coords.json never written by serve after 60s. Service will keep running but room gateway can't start."
else
    # Open the browser gateway. Foreground; exits 0 once serve spawns the
    # gateway subprocess. Failure is non-fatal — we still want serve up so
    # operators can debug.
    if "$ELASTOS_BIN" room open --addr "0.0.0.0:__PORT__"; then
        echo "room gateway listening on 0.0.0.0:__PORT__"
    else
        echo "WARN: elastos room open failed; serve continues but /apps/<X>/ won't be reachable"
    fi
fi

# Block on serve for the rest of the service lifetime.
wait "$SERVE_PID"
