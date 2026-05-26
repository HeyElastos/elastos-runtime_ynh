# Elastos Runtime — YunoHost package

This repo is both the [HeyElastos](https://github.com/HeyElastos) fork of the Elastos Runtime source **and** the YunoHost packaging that wraps it.

## What gets installed (sovereign source-build, no Elacity dependency)

- Rust 1.89 toolchain at `/opt/elastos_runtime/rust/`
- Cargo-built `elastos` binary + native + WASM capsules from this fork's source
- A short-lived **local-only publisher** during install that serves the freshly built capsules to the client runtime over a localhost-only Carrier loop (no internet P2P, no Elacity)
- Permanent client install at `$data_dir/home/` with:
  - `.local/bin/elastos` — the cargo-built binary
  - `.local/share/elastos/sources.json` — pointing at the bootstrap publisher (the one that's torn down after install; sources.json keeps the trust record)
  - `.local/share/elastos/components.json` + `capsules/` — installed Home profile components
- Systemd unit running `elastos serve --addr 127.0.0.1:$PORT`
- Nginx reverse-proxy at the install path on your YunoHost domain (default `/elastos`)

## Why this approach over the upstream installer

The official `https://elastos.elacitylabs.com/install.sh` provisions trust against Elacity's publisher iroh node. When that node is unreachable from your home network, `elastos setup --profile demo` cannot fetch components and the install fails closed.

This package implements the source-build path from upstream's `scripts/home-frontdoor-smoke.sh` — a documented "self-host" pattern where a temporary local runtime acts as the publisher to your real runtime. Both sides only talk to 127.0.0.1, no internet needed for the component install. After bootstrap, the temp publisher is torn down and only the client runtime keeps running.

End state: you depend on no upstream infrastructure. Updates come from `git pull` + `yunohost app upgrade`.

## Trade-offs vs the upstream installer

- ✅ Fully sovereign — works even when Elacity's publisher is offline
- ✅ Runs the binary built from THIS fork, not upstream's signed one — modifications you make are actually used
- ❌ Install is slow: ~20–40 min cold build (Rust + cargo workspace + WASM)
- ❌ Install is fat: needs ~4 GB RAM during build, ~5 GB disk for cargo cache (target/ is cleaned post-build but the toolchain in `/opt/elastos_runtime/rust/` is ~1.5 GB)
- ❌ Currently only installs the `home` profile (no chat-room demo surfaces yet — see below)

## Browser access from LAN

After install, from any device on your LAN:

```
https://<your-yunohost-domain>/elastos/apps/chat-room/
```

That hits the room gateway through nginx — no SSH, no SSO if you picked `visitors` permission.

### What's browser-accessible

The hosted gateway serves any capsule registered in the active profile at `/apps/<name>/`. With `--profile demo` (what this package installs), that includes:

- **`/apps/home/`** — the Home desktop shell. Visiting this route triggers a `home-session` cookie that grants the browser session Home-scoped capabilities, so subsequent API calls (`/api/apps/home/summary`, `/api/apps/home/launch`, etc.) work transparently.
- **`/apps/chat-room/`** — the hosted chat-room.
- Plus everything else in [components.json](components.json) under the `demo` profile (gba-ucity, documents, library, inbox, …) once registered.

There is no separate "publish capsule to browser" toggle: being in the active profile = being reachable at `/apps/<name>/`. See [`elastos/crates/elastos-server/src/api/browser_capsules.rs`](elastos/crates/elastos-server/src/api/browser_capsules.rs) for the routing.

### Authority model in the browser

Per [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), Home in the browser runs under **browser-session capability policy** (not the Home-scoped authority an interactive `elastos` TTY session gets). Practically that means some operations that the TTY Home performs ambiently will prompt the user via Inbox in the browser. Same Home shell, narrower default privileges.

## Notes on the install

- Cold install takes 20–40 min (cargo workspace + WASM builds). Upgrades reuse the cargo cache in `$install_dir/elastos/target/` so they're much faster (~3–5 min).
- The runtime expects `/dev/kvm` for microVM capsules. On a YunoHost mini PC without KVM enabled, WASM capsules (including Home) still work; microVM ones (e.g. `chat`, `did-provider`, `ipfs-provider`) won't.
- Current package installs the `home` profile only. Extending to the `demo` profile (chat-room + GBA + documents + library + inbox) requires building those additional capsules — straightforward extension once the home profile is verified working.

## Operator commands

After install you can talk to the runtime as the app user. Wrap commands in this env so HOME and XDG paths resolve correctly:

```bash
sudo -u elastos_runtime env \
    HOME=/home/yunohost.app/elastos_runtime/home \
    XDG_DATA_HOME=/home/yunohost.app/elastos_runtime/home/.local/share \
    /home/yunohost.app/elastos_runtime/home/.local/bin/elastos node info
```

## Recovery — finishing setup manually if Carrier failed

If install finished with "NOT STARTED — Carrier setup did not complete", the binary is in place but `setup` couldn't reach the Elastos publisher over iroh's P2P network. To recover:

**1) Diagnose Carrier reachability.** From the YunoHost box:

```bash
# Default iroh relay endpoints — must be reachable over HTTPS/443
curl -v --max-time 10 https://use1-1.relay.iroh.network/relay/probe
curl -v --max-time 10 https://euw1-1.relay.iroh.network/relay/probe

# Check outbound UDP isn't filtered (NAT/firewall)
# UDP 443 is the most common iroh QUIC port; some ISPs block it.
sudo ss -lupn | grep elastos
sudo ufw status verbose
```

If outbound UDP is restricted or relays unreachable, fix at your router/firewall first. Iroh hole-punches over UDP and falls back to relay HTTPS — both must work.

**2) Re-run setup as the app user:**

```bash
sudo -u elastos_runtime env \
    HOME=/home/yunohost.app/elastos_runtime/home \
    XDG_DATA_HOME=/home/yunohost.app/elastos_runtime/home/.local/share \
    /home/yunohost.app/elastos_runtime/home/.local/bin/elastos setup --profile demo

sudo -u elastos_runtime env \
    HOME=/home/yunohost.app/elastos_runtime/home \
    XDG_DATA_HOME=/home/yunohost.app/elastos_runtime/home/.local/share \
    /home/yunohost.app/elastos_runtime/home/.local/bin/elastos setup --profile operator
```

**3) Start the service:**

```bash
sudo systemctl start elastos_runtime
sudo systemctl status elastos_runtime
journalctl -u elastos_runtime -f
```

## Upgrading

`yunohost app upgrade elastos_runtime` re-fetches the package, runs `elastos update` (which pulls the next signed release via the trusted source), and restarts the service. State under `$data_dir` is preserved.
