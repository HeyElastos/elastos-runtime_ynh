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

ELASTOS_BIN="$HOME/.local/bin/elastos"
COORDS_FILE="$XDG_DATA_HOME/elastos/runtime-coords.json"

"$ELASTOS_BIN" serve &
SERVE_PID=$!

trap '
    kill -TERM "$SERVE_PID" 2>/dev/null
    wait "$SERVE_PID" 2>/dev/null
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
