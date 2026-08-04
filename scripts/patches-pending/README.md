# Pending patches — NOT applied by the install

`fetch_upstream_source()` in `scripts/_common.sh` globs `scripts/patches/*.patch`.
Anything in **this** directory is deliberately outside that glob: it is written
and verified, but it has an unmet dependency and would break the install today.

Move a patch back into `scripts/patches/` only when its precondition below is met.

## 0024-vendored-transport-patches.patch

Points the elastos workspace at the vendored, patched iroh stack
(`iroh` 1.0.2 / `iroh-gossip` 0.101 / `netdev` 0.45 / `noq-udp` 1.0.1) that
Hyper-Desktop, Hyper-Skia and hey-mobile-runtime all run, so the always-on
Carrier stops being the one process in the fleet on unpatched crates.io. The
iroh fix is a RemoteMap leak (sustained CPU + RSS climb), which matters most on
a box that stays up for months.

**Precondition: the pinned Hey capsule pack must ship `capsules/vendor/`.**

The patch resolves `[patch.crates-io]` through `../capsules/vendor/*`, which
`fetch_hey_capsules()` unpacks from the tarball pinned in
`manifest.toml [resources.sources.hey_capsules]`.

The currently pinned pack (`Hey-capsule` @ `8a5f66d`) has **no** `capsules/vendor/`
directory. With this patch applied against that pin, the build dies immediately:

```
error: failed to load source for dependency `iroh`
Caused by: Unable to update /…/capsules/vendor/iroh
```

### To enable it

1. Land the vendored crates in `HeyElastos/Hey-capsule` — `capsules/vendor/{iroh,
   iroh-gossip,netdev,noq-udp}`, kept byte-identical to `hey-engine/vendor/` by
   that repo's `scripts/sync-vendor.sh`.
2. In the same pack change, make `capsules/peer-provider` and
   `capsules/blobs-provider` their own workspace roots carrying the
   `[patch.crates-io]` block. They are built by `cd`-ing into their directories,
   where no workspace root exists, so a pack-root patch block never reaches them
   and the box silently builds unpatched.
3. Bump `[resources.sources.hey_capsules]` url + sha256 to that commit.
4. `git mv scripts/patches-pending/0024-*.patch scripts/patches/`.
5. Reinstall from scratch and confirm the lockfile shows the four crates with no
   `source =` line (i.e. resolved from the vendored paths, not crates.io).

Note step 2's pin: the vendored iroh calls `noq_udp::hyper_rearm_dead_families`,
which exists only in the vendored `noq-udp` 1.0.1 — the two are a matched pair.
Without an explicit `noq-udp = "=1.0.1"` pin a from-scratch resolve pulls
`iroh-relay` 1.0.3 → `noq` 1.1 → `noq-udp` 1.1.1, `[patch.crates-io]` silently
stops applying, and the build fails on the missing function. That pin is part of
this patch for the runtime side; the pack needs its own copy for the providers.
