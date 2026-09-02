#!/bin/bash
#
# Fast-path update for the Hey capsule pack ONLY.
#
# Skips the slow parts of `yunohost app upgrade elastos_runtime`
# (cargo build, kubo download, full `elastos setup --with ...`).
# Fetches the latest Hey-capsule tarball, builds the React bundles,
# deploys them to the runtime's data_dir, restarts the service.
#
# Use this when iterating on hey-social / hey-chat JS and you
# want a sub-minute deploy loop instead of waiting 30+ minutes for
# a full app upgrade.
#
# Usage (run as root or via sudo):
#
#   sudo bash /var/www/elastos_runtime/scripts/update-hey-only.sh
#   sudo bash /var/www/elastos_runtime/scripts/update-hey-only.sh <commit-sha>
#   sudo bash /var/www/elastos_runtime/scripts/update-hey-only.sh main
#
# Defaults to the latest commit on Hey-capsule's main branch.
#
# What it does NOT do (use `yunohost app upgrade` for these):
#   - Rebuild the elastos runtime binary
#   - Rebuild native provider binaries (did, ipfs, blobs, webspace)
#   - Re-fetch upstream Elastos Runtime
#   - Reapply upstream patches
#   - Update the apt deps / system_user / nginx config
#
# What it DOES:
#   - Fetch the named Hey-capsule commit's tarball from GitHub
#   - Run `npm install && npm run build` for each app capsule that
#     has a client/ subdir (hey-social, hey-chat)
#   - Move client/dist/* up to the capsule root (index.html + assets/)
#   - Copy brand SVGs from client/public/ up to the capsule root
#   - Replace the live capsule in data_dir with the freshly-built one
#   - chown to the runtime user
#   - Restart the elastos_runtime systemd service

set -euo pipefail

REPO="HeyElastos/Hey-capsule"
COMMIT="${1:-main}"
DATA_DIR="/home/yunohost.app/elastos_runtime/home/xdg-data/elastos/capsules"
APP_USER="elastos_runtime"

if [ ! -d "$DATA_DIR" ]; then
    echo "ERROR: $DATA_DIR does not exist. Is elastos_runtime installed?" >&2
    exit 1
fi

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

echo "=== Fetching $REPO @ $COMMIT ==="
curl -fsSL "https://github.com/$REPO/archive/$COMMIT.tar.gz" -o "$TMP/pack.tar.gz"
tar -xzf "$TMP/pack.tar.gz" -C "$TMP" --strip-components 1

for app in hey-social hey-chat hyper-desktop; do
    SRC="$TMP/capsules/$app"
    if [ ! -d "$SRC" ]; then
        echo "=== Skipping $app (not in pack) ==="
        continue
    fi
    if [ ! -f "$SRC/capsule.json" ]; then
        echo "=== Skipping $app (no capsule.json) ==="
        continue
    fi

    if [ -f "$SRC/client/package.json" ]; then
        # React/Vite app — build with npm.
        echo "=== Building $app (npm install + vite build) ==="
        (cd "$SRC/client" && npm install --no-audit --no-fund --loglevel=error && npm run build)

        if [ ! -f "$SRC/client/dist/index.html" ]; then
            echo "ERROR: $app build produced no client/dist/index.html" >&2
            exit 1
        fi

        rm -rf "$SRC/index.html" "$SRC/assets"
        mv "$SRC/client/dist/index.html" "$SRC/"
        [ -d "$SRC/client/dist/assets" ] && mv "$SRC/client/dist/assets" "$SRC/"
        if [ -d "$SRC/client/public" ]; then
            for svg in "$SRC/client/public"/*.svg; do
                [ -f "$svg" ] && cp -f "$svg" "$SRC/"
            done
        fi
    elif [ -f "$SRC/Trunk.toml" ]; then
        # Rust+Leptos+WASM app — built by CI / dev-machine into dist/,
        # shipped pre-built in the Hey-capsule tarball. No on-server trunk
        # build needed — keeps the fast deploy actually fast.
        if [ ! -f "$SRC/dist/index.html" ]; then
            echo "ERROR: $app has Trunk.toml but no dist/index.html in the tarball — did CI fail to build, or was dist/ gitignored?" >&2
            exit 1
        fi
        # The runtime serves capsule files from the capsule ROOT, not from a
        # dist/ subdir: the entrypoint is mounted at /apps/<app>/ and its
        # relative asset URLs (./xxx.js, ./xxx_bg.wasm) resolve against that
        # root. So flatten dist/* up to the capsule root — exactly like the
        # React client/dist/* flatten above. capsule.json entrypoint must be
        # "index.html" (the post-Trunk file), NOT "dist/index.html"; otherwise
        # the WASM/JS 404 and the app boots to a blank screen.
        echo "=== $app: pre-built WASM (from tarball), flattening dist/ -> capsule root ==="
        rm -f "$SRC/index.html"          # drop the Trunk source template at root
        cp -af "$SRC/dist/." "$SRC/"     # overlay the built index.html + hashed assets
        rm -rf "$SRC/dist"
    else
        # Static capsule (no client/, no Trunk.toml) — just deploy whatever
        # the tarball ships at the capsule root.
        echo "=== $app: static capsule, deploying as-is ==="
    fi

    echo "=== Deploying $app to $DATA_DIR ==="
    rm -rf "$DATA_DIR/$app"
    cp -r "$SRC" "$DATA_DIR/$app"
    chown -R "$APP_USER:$APP_USER" "$DATA_DIR/$app"
done

# Capsules shipped next to this script (pack/) win over the GitHub tarball.
# Used for hyper-desktop until the Hey-capsule pin includes it.
PACK_OVERLAY="$(cd "$(dirname "$0")/.." && pwd)/pack"
if [ -d "$PACK_OVERLAY" ]; then
    for extra in "$PACK_OVERLAY"/*/; do
        [ -d "$extra" ] || continue
        app="$(basename "$extra")"
        [ -f "$extra/capsule.json" ] || continue
        echo "=== Overlaying $app from pack/ ==="
        DEST="$TMP/overlay-$app"
        rm -rf "$DEST"
        cp -r "$extra" "$DEST"
        if [ -f "$DEST/Trunk.toml" ] && [ -d "$DEST/dist" ]; then
            rm -f "$DEST/index.html"
            cp -af "$DEST/dist/." "$DEST/"
            rm -rf "$DEST/dist"
        fi
        rm -rf "$DATA_DIR/$app"
        cp -r "$DEST" "$DATA_DIR/$app"
        chown -R "$APP_USER:$APP_USER" "$DATA_DIR/$app"
    done
fi

echo "=== Restarting elastos_runtime ==="
systemctl restart elastos_runtime

echo
echo "=== Done. Hard-refresh your browser to pick up the new bundle. ==="
