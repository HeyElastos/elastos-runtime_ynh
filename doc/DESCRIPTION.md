**Elastos Runtime** is a small trusted base that runs signed capsules with explicit capabilities and content-addressed resource fetching via `elastos://`. It's the OS-layer of an Elastos node: a single `elastos` binary that supervises capsules running as WASM, microVMs, or static data bundles.

This YunoHost package installs the official signed Elastos Runtime binary via the upstream curl-bash installer, provisions the `demo` + `operator` profiles, runs `elastos serve` as a systemd service, and exposes the runtime through nginx so any browser on your LAN can reach Home and other capsule surfaces via your YunoHost domain.

**Status:** pre-release and unstable. Verified on Linux x86_64 and aarch64. Not for production workloads.
