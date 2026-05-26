// ─────────────────────────────────────────────────────────────────────
// hey-mesh-status.js
//
// The runtime doesn't currently expose a global iroh mesh peer count
// via a browser-reachable API (per-topic counts exist on chat-room
// poll endpoints; nothing global). Rather than display a fake "23
// peers", we poll /api/health and show TRUTHFUL state: whether the
// local iroh node is online, plus the runtime version when we can
// see it.
//
// Selectors updated:
//   .hey-mesh-pill        — toolbar pill (right side of top bar)
//   .hey-fed-footer span  — federation footer (bottom-right)
// ─────────────────────────────────────────────────────────────────────

(() => {
  const POLL_MS = 30_000;

  // Try the gateway's loopback first; fall back to whatever the page
  // was served from. Either way the response is the runtime's stamped
  // {status,version}.
  const HEALTH_URLS = [
    "/api/health",                 // same-origin via the gateway
    "http://127.0.0.1:3000/api/health", // dev / direct
  ];

  const setOnline = (version) => {
    const verLabel = version ? ` · ${version}` : "";
    document.querySelectorAll(".hey-mesh-pill").forEach((el) => {
      el.textContent = `iroh online${verLabel}`;
      el.dataset.state = "online";
    });
    // Legacy fed-footer (now hidden) — keep the strings consistent in case
    // it's ever un-hidden for debugging.
    document.querySelectorAll(".hey-fed-footer span:not(.dot)").forEach((el) => {
      el.textContent = `iroh online${verLabel} · zero servers`;
    });
  };

  const setOffline = () => {
    document.querySelectorAll(".hey-mesh-pill").forEach((el) => {
      el.textContent = "iroh offline";
      el.dataset.state = "offline";
    });
    document.querySelectorAll(".hey-fed-footer span:not(.dot)").forEach((el) => {
      el.textContent = "iroh offline · runtime unreachable";
    });
  };

  const probe = async () => {
    for (const url of HEALTH_URLS) {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(url, { credentials: "include", signal: ctrl.signal });
        clearTimeout(timeout);
        if (!r.ok) continue;
        const body = await r.json().catch(() => ({}));
        setOnline(body.version || null);
        return;
      } catch (_) { /* try next */ }
    }
    setOffline();
  };

  // Initial state: leave the static "23 peers" or "Carrier · …" text
  // in the markup as a placeholder for ~80ms while the first probe
  // runs, then replace.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", probe, { once: true });
  } else {
    probe();
  }
  setInterval(probe, POLL_MS);
})();
