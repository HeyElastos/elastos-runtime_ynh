# Patch elimination plan — 23 → 1

**Goal:** run 100% stock upstream ElastOS Runtime, with every Hyper-specific
behaviour living in Hyper's own capsules and provider binaries, and at most
**one** patch — the gate that lets a third-party app exist at all.

**Status (2026-09-02):** Hyper desktop WASM rides **ElastOS as the OS**.
Gossip is the runtime Carrier (`elastos://peer/*`); the hey-mesh / second
iroh node plan in §1–§3 is cancelled. `peer-provider` is no longer built
or shipped. Keep Carrier behaviour patches until upstream absorbs them.
Keep 0001–0006 / 0021 so Hyper can *register into* ElastOS (identity +
blobs as scheme extensions), not fork it.

Current shipping state was `0.6.0~ynh4` with 25 patches; 0.7 drops the
iroh version-bump patches (0010, 0018) because upstream is already on
iroh 1.0.2.

Every claim below was checked against upstream `d358ded` (0.6.0) and the
current pack; the check is named inline so it can be re-run.

---

## 0. The constraint that shapes everything

`capsules/hyper-desktop` is `"type": "data"`, entrypoint `index.html` — a
wasm32 Leptos capsule that runs **in the browser sandbox**. It cannot open a
socket, cannot run an iroh node, cannot register a provider. No runtime patch
can move *into* it.

**The Hyper WASM capsule cannot own a socket.** `hey-core` compiles to WASM
and runs in the tab, so P2P has to be proxied by the host. That host process
is **ElastOS Carrier**, not a second Hyper iroh node. Access patches (0001–
0006, 0021) exist so a third-party capsule can reach OS providers;
carrier patches exist because Hyper still needs mesh behaviour the stock
Carrier does not yet ship. They are OS integration, not a fork of the
network plane.

---

## 1. Target architecture

```
browser tab                    host                          network
┌────────────────────┐   ┌──────────────────────────┐
│ hyper-desktop      │   │ ElastOS Runtime          │
│ hey-social/hey-chat│──▶│  (100% stock upstream)   │
│  (wasm + hey-core) │   │  gateway provider proxy  │
└────────────────────┘   │            │             │
   /api/provider/        │            ▼             │
   hey-mesh/*            │  ┌───────────────────┐   │
                         │  │ hey-mesh provider │───┼──▶ iroh 1.0.2
                         │  │ (Hyper-owned,     │   │    gossip mesh
                         │  │  native, own iroh)│   │    (Desktop, Android,
                         │  └───────────────────┘   │     other servers)
                         │                          │
                         │  built-in carrier ───────┼──▶ iroh 0.96
                         │  (upstream's, untouched) │    (upstream's own
                         └──────────────────────────┘     trusted-source /
                                                          presence traffic)
```

Two iroh nodes, deliberately separated. Upstream's carrier keeps doing
upstream's job on upstream's iroh version; Hyper's traffic never touches it.

### Why this kills the iroh dependency

Earlier analysis said upstream had to bump to iroh 1.0.2 before we could go
stock. **That was wrong** — it is only true while Hyper borrows upstream's
carrier. Once Hyper's P2P runs in Hyper's own provider, upstream's carrier
version is irrelevant to us, and `0010`, `0018`, `0024` all become dead
weight regardless of what upstream does.

This removes the only upstream dependency that we could not influence.

---

## 2. The vehicle already exists

`capsules/peer-provider` is not a new build. It is already:

- a durable iroh-gossip node with on-disk persistence (topics + bootstrap
  tickets re-joined on startup, per-topic message log, per-consumer cursors)
- op-complete: `init`, `get_config`, `set_config`, `get_ticket`,
  `gossip_join`, `gossip_leave`, `gossip_send`, `gossip_recv`,
  `list_topic_peers`, `list_peers`
- already on the target stack — iroh 1.0.2 / iroh-gossip 0.101, vendored and
  patched, as of pack commit `0a2f7fa`
- already configurable for exactly the modes the carrier patches add:
  `relay_mode = "independent"` (no relay/discovery, direct addresses only),
  `bind_port` (fixed UDP port), `public_addr` (dialable address in the ticket)

Upstream 0.6 absorbed `elastos://peer/*` into its in-process carrier
(*"Replaces the separate peer-provider subprocess"*), which is what pushed
Hyper's mesh behaviour into `carrier.rs` in the first place. Reviving
peer-provider under a **different scheme** reverses that, without touching
upstream.

### What still has to be ported into it

The behaviour of the 10 carrier patches. Not from scratch — the same logic
already exists in `hey-engine/crates/hey-mobile-runtime/src/carrier.rs`
(6045 lines; 243 references to path-type/direct handling, 95 to NAT/bootstrap,
47 to IPv6 addressing, including the relay-homing fix noted as *"can home on
DIFFERENT relays and never mesh — so DMs/invites silently failed"*).

| patch | behaviour to port |
|---|---|
| 0007 | IPv6 dual-bind |
| 0008 | gossip connect timeout |
| 0009 | relay-map federation (self-hosted relay list) |
| 0013 | first-add-only bootstrap peer logging |
| 0015 | autonomous boot join |
| 0016 | always-on global mesh topic |
| 0017 / 0022 | relay independence |
| 0019 | path-type detection + `peer_paths` op |
| 0023 | NAT'd hosts seed the mesh bootstrap |

`relay_mode`/`bind_port`/`public_addr` already cover much of 0009/0017/0022.

---

## 3. Decisions to make before writing code

### 3.1 Scheme name

Must be a **top-level** scheme, not a sub-provider.

Verified: `ProviderRegistry::register()` iterates `provider.schemes()` and
inserts with **no allowlist**. Only `register_sub_provider()` is gated by
`RESERVED_SUB_NAMES` (24 entries: `peer`, `did`, `content`, `message`,
`object`, `wallet`, …). A top-level scheme sidesteps that gate entirely — so
patches 0004 and 0021 have no successor to write.

`peer` is taken by upstream's carrier. The pack already uses hyphenated custom
schemes (`hey-transcoder`, `social-feed`), so the convention exists.

**Recommendation: `hey-mesh`.** Distinct from upstream's `peer`, describes what
it is. Alternatives: `hey-peer` (closer to the old name, risks confusion with
upstream's `peer`), `hyper` (brand-aligned but vague).

### 3.2 UDP port for the second node

Upstream's carrier binds **4433** (`bind_addr 0.0.0.0:4433`), and the package
already opens it — `scripts/_common.sh` has `PEER_UDP_PORT=4433` plus an
`ensure_firewall_port` helper that allows the port *and verifies* it actually
opened (`yunohost firewall list` under-reports UDP on some builds).

The Hyper node needs its own port. **Recommendation: 4434**, set via
peer-provider's existing `bind_port` config, opened with the existing
`ensure_firewall_port` helper. No new machinery.

### 3.3 One node or two?

Two iroh nodes means two sockets, two relay connections, two sets of timers on
an always-on box. That cuts against the radio mandate — *batch onto one clock;
more contacts must mean less traffic*.

Options:
1. **Accept two.** Simplest. Upstream's carrier is mostly idle for a
   Hyper-only box (trusted-source updates, its own presence topics).
2. **Quiet upstream's carrier.** If the runtime can be configured to not join
   its discovery topics when nothing uses them, the second node costs little.
   Needs investigation — may be an upstream config request.

Decide before building; it changes nothing structurally but it does change the
battery/traffic story.

### 3.4 capsule.json changes

`hyper-desktop` currently declares:

```json
"messaging": ["elastos://peer/*", "elastos://identity/*",
              "elastos://blobs/*", "elastos://did/*"]
```

`elastos://peer/*` becomes `elastos://hey-mesh/*`. Same for `hey-social` and
`hey-chat`. The WASM side's provider calls change scheme string only — the op
surface is identical, since peer-provider already speaks the same ops the
browser emits.

---

## 4. The one patch that stays

Everything above is blocked on it: without it a Hyper provider can neither be
**registered** nor **reached**.

Two changes, one patch, both generic — no Hyper names in the diff:

**(a) Gateway provider proxy — authorize from the manifest.**
`gateway_provider_proxy.rs` currently gates on a hardcoded
`match scheme.as_str()` → `allowed_apps` table. Replace with: read the calling
capsule's `permissions.messaging` from its `capsule.json` and authorize the
schemes it declares. The runtime already parses that manifest and then ignores
it. `hyper-desktop` already declares exactly what it needs.

**(b) `server_infra` — spawn declared providers, not hardcoded ones.**
It currently calls `find_installed_provider_binary("…")` for **23 hardcoded
names**. Add: any provider binary present in `bin/` that declares a scheme gets
spawned and registered the same way.

This subsumes 0001, 0002, 0003, 0004, 0005, 0006 and 0021.

### Upstream PR framing

Pitch it as a capability fix, not a Hey feature:

> The runtime parses each capsule's `permissions.messaging` and
> `permissions.storage`, then ignores them and authorizes provider access from
> a hardcoded table of built-in capsule ids. Any third-party capsule — even one
> whose manifest correctly declares the schemes it needs — gets 403/404 on
> every `/api/provider/<scheme>/<op>` call. Likewise `server_infra` only spawns
> providers from a hardcoded list of 23 names, so a third-party provider binary
> can never be registered.
>
> This makes provider access and provider registration manifest-driven, which
> is what the capsule model already implies. No behaviour change for built-in
> capsules: their manifests declare what the table granted them.

If merged, the count goes to **0**.

---

## 5. Staged removal order

Each stage is independently shippable and independently revertable. Do not
start a stage before the previous one's gate passes.

| # | stage | drops | gate |
|---|---|---|---|
| 1 | Write the keystone patch (§4), collapse 0001–0006 + 0021 into it | 23 → 17 | patched tree compiles; hey-social still reaches its providers on a real box |
| 2 | Send stage 1 upstream as a PR | — | — |
| 3 | Revive `peer-provider` on `hey-mesh`; register + reach it through the stage-1 patch, no behaviour ported yet | — | browser can `gossip_send`/`gossip_recv` via `/api/provider/hey-mesh/*` |
| 4 | Port the 10 carrier patches' behaviour into it; repoint capsule.jsons | 17 → 7 | two boxes mesh over `hey-mesh`; direct (non-relayed) path confirmed |
| 5 | Drop the iroh patches — upstream's carrier version no longer matters | 7 → 4 | full install from scratch on stock upstream carrier |
| 6 | Drop 0012 (Hyper shell replaces upstream Home) and 0014 (use Hyper's own content/docs provider) | 4 → 2 | Home entry point is `hyper-desktop`; content publish/fetch works |
| 7 | Upstream 0020 (unbounded `send_raw` holds the shared bridge mutex) | 2 → 1 | merged upstream, or kept as the second patch |

**End state: 1 patch** (the access/registration gate), or **0** if upstream
merges it.

Stage 4 is the only large one. Stages 5 and 6 are deletions.

---

## 6. Risks and open questions

1. **Does upstream's built-in carrier still need to work?** If any Hyper flow
   depends on `elastos://peer/*` (upstream's carrier) rather than `hey-mesh`,
   that flow still rides upstream's iroh 0.96 and its unpatched behaviour.
   Audit every `elastos://peer` call site before stage 4.

2. **Two nodes on one box** — see §3.3. Decide deliberately.

3. **0020 is a real runtime bug, not a Hyper preference.** `send_raw` awaits
   with no timeout while holding the shared IO mutex, so *any* stalled provider
   blocks every other op on that bridge. It cannot move to app level. Upstream
   it, or accept a second permanent patch.

4. **Upstream may decline the keystone patch.** Then it stays as the one patch
   — which is the stated goal, so this is an acceptable landing point, not a
   failure.

5. **Not yet verified: iroh 0.96 ↔ 1.0.2 interop.** Under this plan it stops
   mattering for Hyper traffic (separate nodes, both ends on 1.0.2). It only
   matters if stage 4 is skipped. Worth measuring anyway, since it tells us
   whether a stock box can ever mesh with Hyper clients.

6. **`peer-provider` may currently be dead weight** — upstream's carrier owns
   `elastos://peer/*`, so the binary we build and ship may never be called
   today. Confirm before stage 3; it may already be a no-op we can repurpose
   wholesale.

---

## 7. What this does not change

- No ElastOS Runtime code is replaced, reimplemented, or forked. Hyper extends
  it through the capsule/provider mechanism it already provides — the same way
  `blobs-provider`, `content-provider`, `docs-provider` and
  `identity-projection-provider` already do.
- The Hey capsule pack keeps vendoring its patched iroh (`capsules/vendor/`,
  kept in sync by `scripts/sync-vendor.sh`), because the provider binaries need
  it and the pack ships standalone to the box.
