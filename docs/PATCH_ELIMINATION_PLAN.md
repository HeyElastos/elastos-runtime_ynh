# Patch elimination plan — 23 → 3

**Goal:** Hyper is a WASM capsule on stock ElastOS. Whatever the capsule can
do, it does. The pack patches the runtime only for things WASM cannot do.

**Status (2026-09-02):** Gossip is ElastOS Carrier (`elastos://peer/*`). Auth
is ElastOS Home (`?home_token=`). PQ keys (Ed25519 seed, X25519, ML-KEM) live
in the capsule. Identity-projection and blobs-provider are not built.

## Remaining patches (3)

| Patch | Why WASM cannot replace it |
|---|---|
| **0003** | Stock 0.7 `gateway_provider_proxy` still hardcodes allowed apps. Schemes the capsule declares (`peer`, `did`, `content`, `wallet`) 404 unless this fallback authorizes from `permissions.messaging`. |
| **0026** | Unit tests that pin 0003's scheme matching (exact scheme, no wildcard, no prefix leak). Travels with 0003. |
| **0020** | Host `ProviderBridge::send_raw` holds the IO mutex with no timeout. A stalled provider hangs every other op. Not a Hyper feature. |

Drop 0003+0026 when upstream authorizes `/api/provider/*` from the calling
capsule's manifest. Drop 0020 when upstream times out `send_raw`.

## Closed (handled in WASM or stock 0.7)

| Patch | Replacement |
|---|---|
| 0001 runtime-token | Home launch token is the credential (`x-elastos-home-token` on every provider call). Stock has no generic `/session/start`. |
| 0002 capsule storage | Capsule JSON store (localStorage). No principal-root HTTP. |
| 0004–0006 identity-projection | Ed25519 + ML-KEM + X25519 in hey-core. Home authenticates; the capsule holds the social/PQ keys. |
| 0007–0009, 0013, 0015–0017, 0019, 0022–0025 | Stock 0.7 Carrier (iroh 1.0.2). Mesh behaviour is ElastOS's job. |
| 0012 Home close-key | Hyper does not patch Home GUI. |
| 0014 ipfs failfast | Stock ipfs-provider. |
| 0021 blobs-provider | Attachments use ElastOS `content` / `ipfs`. |

## Auth from Home

1. Home passkey signs the user in.
2. Home launches the capsule with `?home_token=<v4 envelope>`.
3. The capsule keeps the token (sessionStorage) and sends it as
   `x-elastos-home-token`. Provider calls do not need a minted bearer.
4. The token is scrubbed from the visible URL.
5. `GET /api/session` is metadata only — never treat `principal` as a social DID.
6. Display name may come from ElastOS `did/get_nickname` when 0003 lets the
   capsule reach `elastos://did/*`.

## Identity in the capsule

The ElastOS `did-provider` DID is the **device** identity, not the human
account. Hyper's social `did:key` is derived in WASM from a local seed
(persisted in the capsule store), generated on first Home-authenticated boot.
Signing and ML-KEM decapsulation are local. The identity-projection host
binary is gone.

## The one patch that should go upstream

0003: honor `permissions.messaging` for `/api/provider/<scheme>/*` instead of
a hardcoded table of built-in capsule ids. Built-in schemes keep their existing
arms; this is a fallback for schemes stock does not claim (`peer`, `did`,
`ipfs`, `content`, `wallet`).
