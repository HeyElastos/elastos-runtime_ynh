#!/usr/bin/env bash
#
# Configure this runtime's kubo (IPFS) Peering.Peers so file attachments fetch
# across Hey runtimes — the IPFS analog of the carrier relay federation.
#
# A file attachment's BYTES travel via content/IPFS by CID (NOT gossip, so they
# were never subject to the 4KB gossip cap). On the public DHT alone, a fresh
# CID is slow/unreliable to find across runtimes; peering the federation's kubo
# nodes directly makes cross-runtime fetch ~1s. This persists to kubo config
# (survives restart, verified) AND applies live via `swarm peering add`.
#
# Idempotent — re-run any time, e.g. after install/upgrade or when the
# federation list changes:
#
#   sudo bash /var/www/elastos_runtime/scripts/configure-ipfs-peering.sh
#
# Env (override the built-in defaults):
#   HEY_IPFS_FEDERATION_PEERS  comma/space-separated kubo multiaddrs
#                              (/ip4/<ip>/tcp/4001/p2p/<peerid>)
#   HEY_IPFS_API               kubo HTTP API (default http://127.0.0.1:5001)
#   HEY_IPFS_FEDERATION=0      disable (no-op)
#
# Defaults MUST match scripts/_common.sh's HEY_IPFS_FEDERATION_PEERS / HEY_IPFS_API.
set -euo pipefail

HEY_IPFS_FEDERATION_PEERS="${HEY_IPFS_FEDERATION_PEERS:-/ip4/94.156.119.216/tcp/4001/p2p/12D3KooWSmM6N6Md7U6a2JrErgC8z1LuQ7gk2SSYo5GH7DzSjCYH,/ip4/94.156.119.217/tcp/4001/p2p/12D3KooWSCpnJLdik75T9G46BfcHCSw7rvD4mtbCGHHZJes4jbGu}"
HEY_IPFS_API="${HEY_IPFS_API:-http://127.0.0.1:5001}"

[ "${HEY_IPFS_FEDERATION:-1}" = "1" ] || { echo "IPFS federation disabled (HEY_IPFS_FEDERATION=0)"; exit 0; }
peers="$HEY_IPFS_FEDERATION_PEERS"
api="$HEY_IPFS_API"
[ -n "$peers" ] || { echo "No federation peers set (HEY_IPFS_FEDERATION_PEERS empty)."; exit 0; }

echo "Waiting for kubo API at $api ..."
up=""
for _ in $(seq 1 30); do
    curl -fsS -m 3 -X POST "$api/api/v0/id" >/dev/null 2>&1 && { up=1; break; }
    sleep 2
done
[ -n "$up" ] || { echo "ERROR: kubo API ($api) not reachable. Is the runtime running?" >&2; exit 1; }

self="$(curl -fsS -m 4 -X POST "$api/api/v0/id" | sed -n 's/.*"ID":"\([^"]*\)".*/\1/p')"
echo "This node: ${self:-<unknown>}"

json="["
first=1
for addr in $(printf '%s' "$peers" | tr ',' ' '); do
    [ -n "$addr" ] || continue
    id="${addr##*/p2p/}"
    if [ -n "$id" ] && [ "$id" = "$self" ]; then
        echo "  skip self: $id"
        continue
    fi
    ipaddr="${addr%/p2p/*}"
    [ "$first" = 1 ] || json="$json,"
    json="$json{\"ID\":\"$id\",\"Addrs\":[\"$ipaddr\"]}"
    first=0
    echo "  peering -> $addr"
    curl -fsS -m 8 -X POST "$api/api/v0/swarm/peering/add?arg=$addr" >/dev/null 2>&1 \
        || echo "    (live peering add failed; persisted config still applied)"
done
json="$json]"

[ "$first" = 1 ] && { echo "Only this node is in the federation list — nothing to peer."; exit 0; }

curl -fsS -G -m 8 -X POST "$api/api/v0/config" \
    --data-urlencode "arg=Peering.Peers" \
    --data-urlencode "arg=$json" \
    --data "json=true" >/dev/null
echo "Done. Peering.Peers persisted (survives restart) + live peering applied."
echo "Cross-runtime file attachments should now fetch in ~1s."
