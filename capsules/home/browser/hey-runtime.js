// ─────────────────────────────────────────────────────────────────────
// hey-runtime.js — Hey-Home's browser-side wrapper around the Elastos
// Runtime's HTTP surface. Mirrors the contract Hey Social uses in
// client/src/lib/runtime.js so both apps speak the same protocol to
// the runtime.
//
// Exposes window.heyRuntime = { storage, peer, ipfs, did, capability,
// providerCall }. Classic-script form (no ESM) so it sits alongside the
// other hey-home browser scripts.
//
// Endpoints:
//   GET/PUT/DELETE /api/localhost/<path>
//     Sandboxed storage CRUD. The shared identity lives under
//     .AppData/Identity/profile.json — both Hey and Hey-Home read+write it.
//
//   POST /api/provider/<scheme>/<op>
//     Capability-gated proxy to provider capsules (peer, ipfs, did, etc.).
//
//   POST /api/capability/request, GET /api/capability/request/<id>
//     The token-grant flow. We cache acquired tokens in sessionStorage
//     so navigation inside a session reuses them.
// ─────────────────────────────────────────────────────────────────────

(() => {
  // Install base derived from page path so the shell works under YunoHost
  // subpath mounts (e.g. "/elastos/apps/home/" → API_BASE = "/elastos").
  const API_BASE = (() => {
    const m = window.location.pathname.match(/^(.*?)\/apps\/[^/]+\//);
    return m ? m[1] : "";
  })();
  const STORAGE_BASE = API_BASE + "/api/localhost";
  const PROVIDER_BASE = API_BASE + "/api/provider";
  const TOKEN_STORE_KEY = "hey-home-capability-tokens";
  const BEARER_STORE_KEY = "hey-home-runtime-bearer";

  // ── Runtime Bearer token handshake (Approach A step 5b) ──────────
  // The home shell loads with the home-session cookie (signed launch
  // token envelope), but the runtime's auth_middleware only honors
  // Authorization: Bearer. Without it, every /api/localhost,
  // /api/provider, /api/capability, /api/auth call 401s and the home
  // shell falls back to browser-side IDB. The handshake exchanges
  // the cookie for a real session token via the gateway endpoint
  // /api/apps/home/runtime-token (added in step 5a). Token cached in
  // sessionStorage so within-tab navigation doesn't re-handshake.
  // Idempotent on the server side — running it twice mints a second
  // session, harmless until cleanup runs.
  let bearerToken = (() => {
    try { return sessionStorage.getItem(BEARER_STORE_KEY) || null; } catch { return null; }
  })();
  const persistBearer = (t) => {
    try { sessionStorage.setItem(BEARER_STORE_KEY, t); } catch { /* private mode */ }
  };
  const bearerReady = (async () => {
    if (bearerToken) return bearerToken;
    try {
      const resp = await fetch(API_BASE + "/api/apps/home/runtime-token", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!resp.ok) {
        console.warn("[hey-home] runtime-token handshake failed:", resp.status);
        return null;
      }
      const data = await resp.json();
      if (data && typeof data.token === "string" && data.token) {
        bearerToken = data.token;
        persistBearer(bearerToken);
        return bearerToken;
      }
      return null;
    } catch (err) {
      console.warn("[hey-home] runtime-token handshake error:", err);
      return null;
    }
  })();

  // Wrapped fetch that injects Authorization: Bearer once the
  // handshake completes. Existing call sites still pass their own
  // headers / credentials; we merge.
  const apiFetch = async (url, init = {}) => {
    await bearerReady;
    const baseHeaders = init.headers || {};
    const authedHeaders = bearerToken
      ? { ...baseHeaders, Authorization: `Bearer ${bearerToken}` }
      : { ...baseHeaders };
    return fetch(url, {
      credentials: "include",
      ...init,
      headers: authedHeaders,
    });
  };

  // ── Capability tokens ────────────────────────────────────────────
  const loadTokenStore = () => {
    try { return JSON.parse(sessionStorage.getItem(TOKEN_STORE_KEY) || "{}"); }
    catch { return {}; }
  };
  const saveTokenStore = (m) => {
    try { sessionStorage.setItem(TOKEN_STORE_KEY, JSON.stringify(m)); }
    catch { /* private mode */ }
  };
  const tokenCache = loadTokenStore();

  // Shell sessions get an implicit trust grant from the runtime. The
  // fallback string is what we send when no acquired token is cached.
  let fallbackToken = "shell-session";
  const tokenForResource = (resource) =>
    (resource && tokenCache[resource]) || fallbackToken;

  const authHeaders = (resource) => {
    const token = tokenForResource(resource);
    return token ? { "X-Capability-Token": token } : {};
  };

  const requestCapabilityToken = async (resource, action = "write") => {
    const post = await apiFetch(API_BASE + "/api/capability/request", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource, action }),
    });
    if (!post.ok) throw new Error(`capability/request HTTP ${post.status}`);
    const initial = await post.json();
    if (initial.status === "granted" && initial.token) return initial.token;
    if (initial.status === "auto_denied" || initial.status === "denied") return null;
    if (initial.status !== "pending" || !initial.request_id) {
      throw new Error(`capability/request unexpected status: ${initial.status}`);
    }
    const delays = [200, 400, 800, 1500, 2000];
    const deadline = Date.now() + 30_000;
    let i = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
      i++;
      const r = await apiFetch(
        `${API_BASE}/api/capability/request/${encodeURIComponent(initial.request_id)}`,
        { credentials: "include" }
      );
      if (!r.ok) continue;
      const status = await r.json();
      if (status.status === "granted" && status.token) return status.token;
      if (status.status === "denied" || status.status === "expired") return null;
    }
    return null;
  };

  const getCapabilityToken = async (resource, action = "write") => {
    if (tokenCache[resource]) return tokenCache[resource];
    try {
      const token = await requestCapabilityToken(resource, action);
      if (token) {
        tokenCache[resource] = token;
        saveTokenStore(tokenCache);
        return token;
      }
    } catch (err) {
      console.warn("[hey-home] capability acquire failed; using fallback", err);
    }
    return fallbackToken;
  };

  // Fire-and-forget at boot. Hey-Home needs:
  //   localhost:write (shared identity, shell marker)
  //   peer:read       (get_ticket, list_peers — surfacing iroh state)
  //   did:read        (resolve peer DIDs when expanding friends)
  // If the runtime isn't gating yet, every call silently falls back to
  // the shell-session placeholder — non-blocking and dev-mode-friendly.
  const acquireBootCapabilities = () =>
    Promise.all([
      getCapabilityToken("localhost://*", "write").catch(() => null),
      getCapabilityToken("elastos://peer/*", "read").catch(() => null),
      getCapabilityToken("elastos://did/*", "read").catch(() => null),
    ]);

  // ── Localhost storage ────────────────────────────────────────────
  const LOCALHOST_RESOURCE = "localhost://*";
  const storagePath = (path) =>
    `${STORAGE_BASE}/${(path || "").replace(/^\/+/, "")}`;

  const storage = {
    readJson: async (path) => {
      const resp = await apiFetch(storagePath(path), {
        credentials: "include",
        headers: authHeaders(LOCALHOST_RESOURCE),
      });
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`localhost GET ${path}: HTTP ${resp.status}`);
      return resp.json();
    },
    writeJson: async (path, value) => {
      const resp = await apiFetch(storagePath(path), {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(LOCALHOST_RESOURCE),
        },
        body: JSON.stringify(value),
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`localhost PUT ${path}: HTTP ${resp.status} ${txt}`);
      }
      return true;
    },
    remove: async (path) => {
      const resp = await apiFetch(storagePath(path), {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(LOCALHOST_RESOURCE),
      });
      if (!resp.ok && resp.status !== 404)
        throw new Error(`localhost DELETE ${path}: HTTP ${resp.status}`);
      return true;
    },
  };

  // ── Provider proxy ───────────────────────────────────────────────
  const schemeToResource = (scheme) => `elastos://${scheme}/*`;

  const providerCall = async (scheme, op, body = {}) => {
    const resp = await apiFetch(
      `${PROVIDER_BASE}/${encodeURIComponent(scheme)}/${encodeURIComponent(op)}`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(schemeToResource(scheme)),
        },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`provider(${scheme}/${op}) HTTP ${resp.status} ${txt}`);
    }
    return resp.json();
  };

  // ── Peer (Carrier) ───────────────────────────────────────────────
  // Hey-Home only needs the read surface — surfacing ticket + peer list,
  // not publishing. (Publishing belongs to apps like Hey Social.)
  const peer = {
    getTicket: () => providerCall("peer", "get_ticket", {}),
    listPeers: () => providerCall("peer", "list_peers", {}),
  };

  // ── DID provider (resolve only) ──────────────────────────────────
  const did = {
    resolve: (didStr) => providerCall("did", "resolve", { did: didStr }),
  };

  // ── Capability flow ──────────────────────────────────────────────
  const capability = {
    request: ({ resource, action }) =>
      apiFetch(API_BASE + "/api/capability/request", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource, action }),
      }).then((r) => r.json()),
    status: (id) =>
      apiFetch(`${API_BASE}/api/capability/request/${encodeURIComponent(id)}`, {
        credentials: "include",
      }).then((r) => r.json()),
    acquire: getCapabilityToken,
  };

  window.heyRuntime = {
    storage,
    peer,
    did,
    capability,
    providerCall,
    acquireBootCapabilities,
    // Awaitable handshake promise. Resolves to the bearer token (or
    // null on failure). Other scripts (hey-welcome.js) await this
    // before calling /api/auth/* so the Authorization header is set.
    bearerReady,
    // Live getter — handy for debugging via DevTools.
    getBearer: () => bearerToken,
  };
})();
