# Hey + Upstream Runtime — Modular Architecture Contract

This document is the load-bearing constraint on every change. The goal:
**upstream releases v0.4.0, v0.5.0, vN should be a one-line bump for us**,
not a rewrite of Hey.

The rule has two halves:

1. **We never edit upstream-owned files.**
2. **Hey only talks to upstream through stable, public contracts.**

When both hold, `sync-upstream.sh vX.Y.Z` is a refresh, not a merge.

---

## File ownership map

```
elastos-runtime_ynh/
│
├── elastos/                          ← UPSTREAM. Refresh only via sync-upstream.sh.
│                                       Never edit. Never patch in place.
│
├── capsules/
│   ├── agent/, ai-provider/,        ← UPSTREAM capsules. Same rule.
│   │   chat/, chat-room/, …
│   │   home/, system/, inbox/,
│   │   library/, documents/,
│   │   browser/, wallet/, …
│   │
│   ├── blobs-provider/              ← HEY CAPSULE PACK. Native provider.
│   │                                   Talks to capsules via /api/provider/
│   │                                   blobs/* HTTP contract. Portable to
│   │                                   any upstream Elastos Runtime.
│   │
│   ├── hey-social/                  ← HEY CAPSULE PACK. App capsule.
│   └── hey-chat/               ← HEY CAPSULE PACK. App capsule.
│
├── conf/                             ← YUNOHOST PACKAGE. nginx + systemd
│   │                                   + branding (this YunoHost install
│   │                                   only — NOT shipped with Hey pack).
│   └── home-overlay.css             ← Frosted-glass theme. Lives here so
│                                       Hey capsules stay portable. Fork
│                                       this YunoHost package, change this
│                                       one file, and you've re-branded.
├── scripts/                          ← OURS. YunoHost-specific install/upgrade.
│   └── sync-upstream.sh              ← OURS. The upgrade tool.
├── components.json                   ← MERGED. Upstream entries verbatim +
│                                       our additive entries appended.
└── manifest.toml                     ← OURS.
```

---

## The contract Hey capsules MUST follow

Hey Social, Hey Messenger, and any future Hey capsule may ONLY call:

### Stable HTTP contracts (these survive every upstream release)

| Path | Contract owner |
|---|---|
| `POST /api/provider/peer/*` (gossip_send/recv/join/leave, list_peers, get_ticket) | upstream — Carrier transport |
| `POST /api/provider/blobs/*` (add_bytes, fetch, share, drop, list) | us — `capsules/blobs-provider` |
| `POST /api/provider/ipfs/*` (add_bytes, get_bytes, pin, ls, …) | upstream — `capsules/ipfs-provider` |
| `POST /api/provider/did/*` (resolve, sign, verify) | upstream — `capsules/did-provider` |
| `GET/PUT/DELETE /api/localhost/*path` | upstream — sandboxed storage |
| `POST /api/capability/request` | upstream — capability auto-grant |
| `POST /api/auth/passkey/register/begin` + `/complete` | upstream — v0.3.0+ passkey signup |
| `POST /api/auth/passkey/authenticate/begin` + `/complete` | upstream — v0.3.0+ passkey signin |
| `GET /api/auth/passkey/status` | upstream — has-anyone-signed-up |
| Bearer handshake at `POST /api/apps/<capsule>/runtime-token` | upstream — cookie→bearer |

### Forbidden — these are runtime-internal and may change between versions

- Direct file reads of `Users/self/.AppData/Identity/profile.json`
  → use the passkey auth contract instead
- Any `/api/auth/state`, `/api/auth/unlock`, `/api/auth/setup`, `/api/auth/wrapped-seed`
  → these were OUR ADD-ONS that v0.3.0 obsoletes. Don't reintroduce.
- Session-registry internals, capability-token format, encryption-envelope details
  → black boxes. If you find yourself reasoning about their internals, stop.

### When upstream breaks a "stable" contract

It's happened before — `ipfs.add_bytes` shape might change in v0.4. The
escape hatch is **vendor that one provider**, not patch upstream:

1. Copy upstream's `capsules/<provider>/` source into `capsules/<provider>-pinned/`.
2. Add it to `components.json` as ours.
3. Update Hey to call `/api/provider/<provider>-pinned/*`.
4. Port to the new upstream shape on our schedule, then drop the pin.

This keeps the divergence per-provider, never blanket.

---

## Theme overlay (conf/home-overlay.css)

The frosted-glass theme is a **YunoHost-package concern, NOT part of
the Hey capsule pack.** This separation matters: it means the Hey
capsule pack can be lifted out of this repo and installed on any
Elastos Runtime — bare Elacity install, a different YunoHost
package, anywhere — without dragging the visual choices of this
package along.

The install script appends `conf/home-overlay.css` to upstream's
`capsules/home/browser/style.css` during install:

```bash
cat $install_dir/conf/home-overlay.css \
    >> $data_dir/capsules/home/browser/style.css
```

This is a one-way write into a derivative of the upstream file. The
*source* upstream file in `install_dir/` is never touched.

The overlay is allowed to:
- Override CSS variables (colors, radii, spacing)
- Add `backdrop-filter: blur(...)` to existing window/dock/topbar selectors
- Override `background:` on chrome elements

The overlay is NOT allowed to:
- Change DOM structure (we never edit upstream's index.html or shell-*.js)
- Inject scripts
- Override behaviour, only appearance

If upstream restructures the DOM in vX, the overlay's CSS selectors
may need updating — but the file is short (under ~200 lines) and the
work is bounded.

**To fork this YunoHost package with different branding:** copy this
repo, replace `conf/home-overlay.css`, done. Hey capsules unchanged.

---

## Upgrade procedure

When upstream releases vN.M.0:

```bash
./scripts/sync-upstream.sh vN.M.0
# Replaces:
#   - elastos/
#   - All upstream-owned capsules under capsules/
# Preserves:
#   - capsules/{blobs-provider, hey-social, hey-chat, hey-theme}
#   - components.json's Hey-additive entries (re-merged)
#   - conf/, scripts/, manifest.toml

# Manual review (the only thing that should EVER block an upgrade):
#   - Did upstream remove a stable contract Hey depends on?
#   - Did upstream add a new mandatory provider scheme we need to wire?
#
# Both are flagged by the script's diff summary.

git commit -am "Bump runtime to vN.M.0"
# manifest.toml's autoupdate.strategy = "latest_github_commit" handles the rest
```

Time budget for a clean upgrade: **under 30 minutes** including a smoke test.
If an upgrade takes longer than that, we violated the contract somewhere
and the fix is to find that violation, not to muscle through.

---

## Definition of done for the v0.3.0 rebase

The rebase is complete when:

- [ ] `cargo check -p elastos-server` passes (already true on v030-rebase branch)
- [ ] `cargo build --release` from `scripts/install` succeeds end-to-end
- [ ] Fresh install on a YunoHost VM produces a working welcome screen
- [ ] Welcome screen is upstream v0.3.0's passkey-only signup
- [ ] After first user signs up, second visit shows signin (not signup)
- [ ] Hey Social launches from the dock and authenticates via
      `/api/auth/passkey/authenticate/{begin,complete}` only
- [ ] Hey Chat launches and DMs work over Carrier + iroh-blobs
- [ ] `hey-theme/home-overlay.css` produces the frosted-glass window chrome
- [ ] `sync-upstream.sh v0.3.0` is a no-op (tests the upgrade path)
- [ ] No file inside `elastos/` or upstream-owned `capsules/` has Hey-side edits
      (`scripts/check-modularity.sh` enforces this)

Each item is its own commit. None of them are repinned in `manifest.toml`
until ALL are green.
