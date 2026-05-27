// ─────────────────────────────────────────────────────────────────────
// Hey-Home welcome + first-run setup.
// Renders before the upstream shell hands off to the desktop.
//
//   - On first boot (no profile in localStorage): a setup wizard asks
//     for a nickname, generates a recovery key + did:key, shows them
//     once, then drops into the desktop.
//   - On every subsequent boot: a lock screen shows the existing user
//     and unlocks into the desktop.
//
// Real auth (recovery PIN, passkey assertion) lives in the Hey app
// capsule; here, unlocking is a visual transition.
// ─────────────────────────────────────────────────────────────────────

// ── Profile storage ───────────────────────────────────────────────
// CANONICAL STORE: the SHARED identity file Hey Social also reads:
//   /api/localhost/Users/self/.AppData/Identity/profile.json
//
// Schema (compatible with Hey's writeSharedIdentity):
//   { name, didKey, recoveryKeyHash, passkeys, createdAt, createdBy,
//     pubKeyHex, pinSalt?, pinHash? }
//
// The raw recoveryKey is NEVER persisted — only its SHA-256 hash.
// Showing the raw key at signup is a one-shot; if the user loses it,
// the only recovery path is the passkey (if enrolled).
//
// Legacy (pre-Ed25519-rewrite) profiles lived at:
//   /api/localhost/Users/self/.AppData/LocalHost/HeyHome/profile.json
// On boot we read the canonical path first, then migrate from the
// legacy path if found. localStorage caching is also kept as a
// fallback for non-runtime hosts (design preview).

const SHARED_IDENTITY_PATH =
  "Users/self/.AppData/Identity/profile.json";
const SHELL_MARKER_PATH =
  "Users/self/.AppData/SystemServices/Shell/active.json";
const LEGACY_PROFILE_PATH =
  "Users/self/.AppData/LocalHost/HeyHome/profile.json";
// Hey Social profile + passkey creds. The home shell reads these as a
// LAST-RESORT migration source: if a Hey Social user exists on this
// node but the shared identity file was never written (the user signed
// up via Hey before the passkeySignup→writeSharedIdentity fix), the
// home shell would otherwise show the SIGNUP wizard on every new
// device — letting a stranger overwrite the node's identity. With this
// path readable, we backfill the shared identity from Hey's profile
// and the lock screen shows up correctly on first visit.
const HEY_PROFILE_PATH =
  "Users/self/.AppData/LocalHost/Hey/profile.json";
const HEY_PASSKEY_CREDS_PATH =
  "Users/self/.AppData/LocalHost/Hey/passkey-creds.json";
const LOCAL_CACHE_KEY = "hey-home-profile";

const runtimeAvailable = () =>
  typeof window !== "undefined" && !!window.heyRuntime;

// ── Auth-gate endpoints (Approach A step 5c) ─────────────────────────
//
// The server side (handlers/auth.rs) verifies the proof and graduates
// the calling session from PreAuth to Authenticated. When the gate is
// disabled (ELASTOS_AUTH_GATE=0, today's default), these calls are
// effectively no-ops on the server — the session was Authenticated by
// default. When enabled, they're load-bearing.
//
// Either way the JS treats them as best-effort: a failure here doesn't
// abort the local unlock UX. If the server refuses, capability calls
// will surface their own 401s and the user re-tries.

const apiBase = () => {
  if (typeof window === "undefined") return "";
  const m = window.location.pathname.match(/^(.*?)\/apps\/[^/]+\//);
  return m ? m[1] : "";
};

const authFetch = async (path, init = {}) => {
  // Wait for hey-runtime.js to complete the cookie → Bearer handshake
  // (step 5b) before sending — auth_middleware on the server only
  // accepts Authorization: Bearer, and the bearer comes from the
  // handshake. Falls through plain if heyRuntime isn't loaded yet
  // (design preview).
  let bearer = null;
  try {
    if (window.heyRuntime?.bearerReady) {
      bearer = await window.heyRuntime.bearerReady;
    }
  } catch (_) { /* ignore */ }
  const headers = {
    "Content-Type": "application/json",
    ...(init.headers || {}),
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  };
  return fetch(apiBase() + path, {
    credentials: "include",
    ...init,
    headers,
  });
};

// Fetch the runtime's identity preview. Used by loadProfile when
// runtime storage reads can't reach the shared identity yet
// (PreAuth session without an unlock-claim cookie → capability
// auto-grant refuses → 401 on /api/localhost/...). The /api/auth/
// state response carries enough to render the lock screen — name,
// did:key, has_passkey, has_pin — without leaking the PIN hash
// or passkey-credential list. Returns null on failure (network /
// missing identity / runtime down).
const serverAuthStateIdentity = async () => {
  try {
    const r = await authFetch("/api/auth/state", { method: "GET" });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data?.identity_present || !data.identity_preview) return null;
    const preview = data.identity_preview;
    if (!preview.didKey) return null;
    // Synthesize a profile that the lock screen renderers + unlock
    // handlers can use directly. `passkeys` carries the REAL
    // credential records from the preview (id / publicKey /
    // publicKeyAlgorithm / transports) so:
    //   - `(profile.passkeys || []).length > 0` reads as "has
    //     passkey", which drives the passkey button UI
    //   - assertPasskey's allowCredentials list has actual ids
    //   - verifyAssertionSignature has the publicKey it needs
    // For PIN-only profiles, passkeys is [] and heyHome carries a
    // null pinHash sentinel. tryUnlock detects previewOnly:true and
    // skips its local PBKDF2 check, submitting the typed PIN
    // straight to /api/auth/unlock for server-side verification.
    // (Local verifyPin against a placeholder would never match and
    // would lock the user out of their own node.)
    return {
      schema: "elastos.identity/v1",
      name: preview.name || "Hey user",
      didKey: preview.didKey,
      passkeys: Array.isArray(preview.passkeys) ? preview.passkeys : [],
      heyHome: preview.has_pin
        ? { pinSalt: null, pinHash: null, fromPreview: true }
        : null,
      previewOnly: true,
    };
  } catch (err) {
    console.warn("[hey-home] /api/auth/state preview failed", err);
    return null;
  }
};

// Submit a PIN proof. Server runs PBKDF2 against the stored salt/hash
// and graduates the session on match. Returns true on success.
const serverUnlockWithPin = async (pin) => {
  try {
    const r = await authFetch("/api/auth/unlock", {
      method: "POST",
      body: JSON.stringify({ method: "pin", pin }),
    });
    return r.ok;
  } catch (err) {
    console.warn("[hey-home] /api/auth/unlock (pin) failed:", err);
    return false;
  }
};

// Sign a server-issued challenge with the passkey-derived Ed25519 key
// to prove possession. The signature is verified against the stored
// did:key (Ed25519 multicodec).
const serverUnlockWithPasskey = async (identityPrf) => {
  if (!identityPrf || identityPrf.length !== 32) return false;
  try {
    const challengeResp = await fetch(
      apiBase() + "/api/auth/unlock/challenge",
      { method: "POST", credentials: "include" }
    );
    if (!challengeResp.ok) return false;
    const { challenge_id, challenge_hex } = await challengeResp.json();
    if (!challenge_id || !challenge_hex) return false;
    const challengeBytes = new Uint8Array(
      challenge_hex.match(/.{2}/g).map((h) => parseInt(h, 16))
    );
    // Derive the same Ed25519 keypair the server expects (from
    // identityPrf, the passkey's PRF output) and sign the challenge.
    const ident = window.heyIdentity;
    if (!ident?.signWithSeed) return false;
    const seed = Array.from(identityPrf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const signatureHex = await ident.signWithSeed(seed, challengeBytes);
    if (!signatureHex) return false;
    const r = await authFetch("/api/auth/unlock", {
      method: "POST",
      body: JSON.stringify({
        method: "passkey",
        challenge_id,
        signature_hex: signatureHex,
      }),
    });
    return r.ok;
  } catch (err) {
    console.warn("[hey-home] /api/auth/unlock (passkey) failed:", err);
    return false;
  }
};

// First-run setup. Refuses server-side if an identity already exists.
// Returns true on success — the caller still does the client-side
// write so localStorage / IDB caches stay in sync.
const serverSetup = async (profile, passkeyCreds) => {
  try {
    const r = await authFetch("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({
        profile,
        passkey_creds: passkeyCreds || [],
      }),
    });
    if (!r.ok) {
      console.warn("[hey-home] /api/auth/setup failed:", r.status);
    }
    return r.ok;
  } catch (err) {
    console.warn("[hey-home] /api/auth/setup failed:", err);
    return false;
  }
};

const runtimeGet = async (path) => {
  if (!runtimeAvailable()) return { ok: false, status: 0 };
  try { return { ok: true, value: await window.heyRuntime.storage.readJson(path) }; }
  catch (err) { return { ok: false, error: err }; }
};
const runtimePut = async (path, value) => {
  if (!runtimeAvailable()) return { ok: false, status: 0 };
  try { await window.heyRuntime.storage.writeJson(path, value); return { ok: true }; }
  catch (err) { return { ok: false, error: err }; }
};
const runtimeDelete = async (path) => {
  if (!runtimeAvailable()) return { ok: false, status: 0 };
  try { await window.heyRuntime.storage.remove(path); return { ok: true }; }
  catch (err) { return { ok: false, error: err }; }
};

const localGet = () => {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
};
const localPut = (v) => {
  try { localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(v)); } catch (_) {}
};
const localDelete = () => {
  try { localStorage.removeItem(LOCAL_CACHE_KEY); } catch (_) {}
};

// IndexedDB-backed identity cache. Survives cookie clears (only "Clear
// all site data" wipes it), which is what makes Hey Social's signin
// feel persistent — mirror the same pattern here so the home shell
// shows the LOCK SCREEN (not signup) after the user clears cookies.
// Only the public profile lives here — no private keys; passkey-PRF
// derives the vault key on every unlock, and that credential is in the
// platform authenticator.
const IDB_NAME = "elastos-home-identity";
const IDB_STORE = "profile";
const idbOpen = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(IDB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const idbGet = async () => {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get("self");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) { return null; }
};
const idbPut = async (v) => {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(v, "self");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) { /* private mode etc. */ }
};
const idbDelete = async () => {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete("self");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {}
};

// loadProfile precedence:
//   1. shared Identity path (canonical, what Hey Social writes)
//   2. legacy HeyHome path  (migrate up + delete the legacy file)
//   3. IndexedDB cache      (survives cookie clears — the persistence
//                            that makes Hey Social feel sticky)
//   4. localStorage cache   (legacy fallback, wiped on cookie clear)
const loadProfile = async () => {
  const shared = await runtimeGet(SHARED_IDENTITY_PATH);
  if (shared.ok && shared.value) {
    localPut(shared.value);
    await idbPut(shared.value);
    return shared.value;
  }
  if (shared.ok) {
    // Runtime reachable but no shared identity yet — check legacy path.
    const legacy = await runtimeGet(LEGACY_PROFILE_PATH);
    if (legacy.ok && legacy.value) {
      console.info("[hey-home] migrating legacy HeyHome profile → shared Identity");
      const migrated = legacyToShared(legacy.value);
      const saved = await runtimePut(SHARED_IDENTITY_PATH, migrated);
      if (saved.ok) {
        await runtimeDelete(LEGACY_PROFILE_PATH);
        localPut(migrated);
        await idbPut(migrated);
        return migrated;
      }
    }
    // Maybe IDB has a cached identity from a prior session (cookie
    // was cleared but IDB persisted). Migrate it back to the runtime
    // and use it.
    const idbCached = await idbGet();
    if (idbCached) {
      console.info("[hey-home] restoring identity from IndexedDB → shared Identity");
      await runtimePut(SHARED_IDENTITY_PATH, idbCached);
      localPut(idbCached);
      return idbCached;
    }
    // Last resort: localStorage cache (typically wiped when cookies
    // are cleared, but keep as a fallback for very old installs).
    const cached = localGet();
    if (cached) {
      console.info("[hey-home] migrating localStorage profile → shared Identity");
      const migrated = legacyToShared(cached);
      await runtimePut(SHARED_IDENTITY_PATH, migrated);
      await idbPut(migrated);
      return migrated;
    }
    // SECURITY-CRITICAL last-resort migration: if a Hey Social user
    // exists on this node but the shared identity was never written
    // (Hey signup before db9ae38), back-fill the shared identity from
    // it. Without this, ANY device hitting the home shell URL would
    // see the signup wizard — strangers could overwrite the node's
    // identity. With this, the lock screen shows up correctly.
    const heyProfile = await runtimeGet(HEY_PROFILE_PATH);
    if (heyProfile.ok && heyProfile.value && heyProfile.value.didKey) {
      const heyCreds = await runtimeGet(HEY_PASSKEY_CREDS_PATH);
      const passkeys = (heyCreds.ok && Array.isArray(heyCreds.value)) ? heyCreds.value : [];
      const migrated = {
        name: heyProfile.value.name || "Hey user",
        didKey: heyProfile.value.didKey,
        pubKeyHex: null,
        recoveryKeyHash: heyProfile.value.authKeyHash || "",
        passkeys,
        avatar: heyProfile.value.avatar || "",
        bio: heyProfile.value.bio || "",
        createdAt: heyProfile.value.createdAt || new Date().toISOString(),
        createdBy: "hey-home-migration-from-hey-social",
      };
      console.info("[hey-home] migrating Hey Social profile → shared Identity (security backfill)");
      const saved = await runtimePut(SHARED_IDENTITY_PATH, migrated);
      if (saved.ok) {
        localPut(migrated);
        await idbPut(migrated);
        return migrated;
      }
    }
    return null;
  }
  // Runtime unreachable for STORAGE reads (PreAuth + no unlock-claim
  // cookie → capability auto-grant refused). Try /api/auth/state's
  // identity preview before falling through to browser caches. This
  // is what makes the lock screen render on a fresh browser visit:
  // the cookie isn't there yet, so storage 401s, but the preview
  // endpoint surfaces name + didKey + has_passkey + has_pin without
  // needing capabilities.
  const previewIdentity = await serverAuthStateIdentity();
  if (previewIdentity) {
    console.info("[hey-home] using /api/auth/state identity preview for lock screen");
    return previewIdentity;
  }
  console.warn("[hey-home] runtime localhost-provider unreachable; trying IDB / localStorage", shared);
  const idbCached = await idbGet();
  if (idbCached) return idbCached;
  return localGet();
};

// Legacy profiles stored the raw recoveryKey AND used a SHA-256-stub
// DID. They need to be re-minted to interoperate with Hey Social.
// For now we keep the name + passkeys + PIN, mark the profile as
// `legacy: true`, and let the welcome flow prompt the user to re-mint
// their identity. (We don't auto-derive a "right" DID because the user
// might have published the stub DID somewhere already.)
const legacyToShared = (p) => {
  if (!p) return p;
  const out = { ...p };
  if ("recoveryKey" in out) delete out.recoveryKey;
  // Flag profiles that pre-date the Ed25519 rewrite.
  if (!out.pubKeyHex) out.legacy = true;
  if (!out.createdBy) out.createdBy = "hey-home";
  // Migrate top-level PIN fields into .heyHome namespace (was a flat
  // top-level shape before Layer 1; foreign apps shouldn't see them
  // as unknown root keys).
  if (out.pinSalt || out.pinHash) {
    out.heyHome = { ...(out.heyHome || {}) };
    if (out.pinSalt && !out.heyHome.pinSalt) out.heyHome.pinSalt = out.pinSalt;
    if (out.pinHash && !out.heyHome.pinHash) out.heyHome.pinHash = out.pinHash;
    delete out.pinSalt;
    delete out.pinHash;
  }
  return out;
};

const saveProfile = async (profile) => {
  localPut(profile);
  await idbPut(profile);
  const r = await runtimePut(SHARED_IDENTITY_PATH, profile);
  if (!r.ok) {
    console.warn("[hey-home] runtime profile save failed; localStorage+IDB only", r);
  }
};

const clearProfile = async () => {
  localDelete();
  await idbDelete();
  await runtimeDelete(SHARED_IDENTITY_PATH);
  // Also clear the legacy path in case both still exist.
  await runtimeDelete(LEGACY_PROFILE_PATH);
};

// Write the shell-marker file Hey Social reads to detect that it's
// hosted by hey-home (rather than stock home or no shell). Best effort
// — failures are logged but don't block boot.
const announceShell = async () => {
  if (!runtimeAvailable()) return;
  const r = await runtimePut(SHELL_MARKER_PATH, {
    name: "hey-home",
    version: "0.1.0",
    writtenAt: new Date().toISOString(),
  });
  if (!r.ok) console.warn("[hey-home] shell marker write failed", r);
};

// ── Identity helpers ───────────────────────────────────────────────
// Ed25519 / base58 / did:key live in window.heyIdentity (hey-identity.js).
// Hex helpers stay local because the PIN code below uses them and they
// don't pull in anything heavyweight.

const bytesToHex = (bytes) =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

const hexToBytes = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

// ── PIN gate (PBKDF2-hashed 6-digit) ───────────────────────────────
// Stored as profile.pinSalt + profile.pinHash. 100k iterations of
// PBKDF2 + SHA-256 over the 6-digit string. 1M PINs × ~50ms per try =
// ~14 hours to brute force a single PIN locally — not perfect, but
// enough friction to gate casual LAN access.
const PBKDF2_ITERATIONS = 100_000;

const generatePinSalt = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
};

const hashPin = async (pin, saltHex) => {
  const enc = new TextEncoder();
  const salt = hexToBytes(saltHex);
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key, 256
  );
  return bytesToHex(new Uint8Array(bits));
};

// Read the PIN fields from a profile. They were originally stored at
// the top level; we now namespace them under `profile.heyHome` so Hey
// Social treats them as foreign-app state instead of unknown top-level
// keys. The fallback to top-level reads keeps legacy profiles working
// until the next save migrates them in writePinFields().
const readPinFields = (profile) => ({
  pinSalt: profile?.heyHome?.pinSalt || profile?.pinSalt || null,
  pinHash: profile?.heyHome?.pinHash || profile?.pinHash || null,
});

// Returns a new profile object with PIN under .heyHome and any legacy
// top-level fields removed. Pure — caller is responsible for writing.
const writePinFields = (profile, { pinSalt, pinHash }) => {
  const next = { ...profile };
  next.heyHome = { ...(next.heyHome || {}), pinSalt, pinHash };
  delete next.pinSalt;
  delete next.pinHash;
  return next;
};

const verifyPin = async (pin, profile) => {
  const { pinSalt, pinHash } = readPinFields(profile);
  if (!pinSalt || !pinHash) return false;
  const candidate = await hashPin(pin, pinSalt);
  // Constant-time-ish compare — overkill for 64-char hex but cheap.
  if (candidate.length !== pinHash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ pinHash.charCodeAt(i);
  }
  return diff === 0;
};

// ── WebAuthn (passkey) ────────────────────────────────────────────
const passkeySupported = () =>
  typeof window !== "undefined" &&
  typeof window.PublicKeyCredential !== "undefined";

const b64uEncode = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64uDecode = (b64u) => {
  const pad = (4 - (b64u.length % 4)) % 4;
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const randomBytes = (n) => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
};

// Enroll a passkey for the given nickname. The browser/OS handles the
// real keypair generation in secure hardware; we record the credential
// ID, the public key (SPKI bytes), the public-key algorithm, and the
// transports. The algorithm is needed at assertion time to import the
// public key into Web Crypto for local signature verification.
const enrollPasskey = async (name) => {
  const challenge = randomBytes(32);
  const userHandle = randomBytes(32);

  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Hey-Home", id: window.location.hostname },
      user: {
        id: userHandle,
        name: name || "hey-user",
        displayName: name || "Hey user",
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -8 },   // Ed25519
        { type: "public-key", alg: -7 },   // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      timeout: 60_000,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        // Require UV (PIN / biometric) rather than "preferred" so a
        // bare touch isn't enough — combined with local sig verify
        // below this closes the "compromised browser fakes assertion"
        // hole.
        userVerification: "required",
      },
      // Single PRF eval — the identity seed shared with every other
      // Elastos capsule (so one passkey = one DID across the device).
      // The shell's vault key is derived from this output via HKDF
      // (see deriveVaultPrf below). We avoid a `second` eval because
      // some authenticators (Nitrokey 3, some Yubikey/Hello firmwares)
      // accept the create() call but then reject post-UV when two
      // hmac-secret salts are requested.
      extensions: {
        prf: {
          eval: {
            first: new TextEncoder().encode("elastos-identity-v1").buffer,
          },
        },
      },
    },
  });

  if (!cred) throw new Error("Passkey enrollment cancelled");

  const response = cred.response;
  let publicKeyB64u = null;
  if (response.getPublicKey) {
    const pk = response.getPublicKey();
    if (pk) publicKeyB64u = b64uEncode(new Uint8Array(pk));
  }
  const publicKeyAlgorithm =
    response.getPublicKeyAlgorithm ? response.getPublicKeyAlgorithm() : null;
  const transports =
    response.getTransports ? response.getTransports() : [];

  // PRF output from registration. 'first' = shared identity seed
  // ('elastos-identity-v1'). The vault PRF is HKDF-derived from it.
  const prfResults = cred.getClientExtensionResults?.()?.prf?.results || {};
  const identityPrfBytes = prfResults.first ? new Uint8Array(prfResults.first) : null;
  const vaultPrfBytes = identityPrfBytes
    ? await deriveVaultPrf(identityPrfBytes, "hey-home-vault-v1")
    : null;

  return {
    id: b64uEncode(new Uint8Array(cred.rawId)),
    publicKey: publicKeyB64u,
    publicKeyAlgorithm,
    userHandle: b64uEncode(userHandle),
    transports,
    createdAt: new Date().toISOString(),
    // Out-of-band: the PRF outputs (only used right at signup; never
    // persisted on the credential entry itself).
    _identityPrf: identityPrfBytes,
    _vaultPrf: vaultPrfBytes,
  };
};

// HKDF-SHA256 expand 32 bytes from the identity PRF with a per-app label.
const deriveVaultPrf = async (identityPrf, label) => {
  const km = await crypto.subtle.importKey(
    "raw", identityPrf, "HKDF", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: new TextEncoder().encode(label),
    },
    km,
    256,
  );
  return new Uint8Array(bits);
};

// ── WebAuthn local signature verification ────────────────────────────
// Without this, the assertPasskey path trusts the OS authenticator's
// claimed success blindly. A compromised browser process or malicious
// extension could fabricate an assertion that looks like a successful
// gesture without the real authenticator being touched. Locally
// verifying the signature against the registered public key closes
// that hole — only the real authenticator (which holds the private
// key) can produce a signature that verifies.

// ASN.1 DER ECDSA signature → raw r||s for Web Crypto.
// WebAuthn ES256 signatures are DER-encoded; Web Crypto's ECDSA verify
// wants 64 raw bytes (32-byte r, 32-byte s).
const derToRawECDSA = (der) => {
  let i = 2;
  if ((der[1] & 0x80) !== 0) i = 2 + (der[1] & 0x7f);
  if (der[i] !== 0x02) throw new Error("DER: missing r INTEGER tag");
  const rLen = der[i + 1];
  let r = der.slice(i + 2, i + 2 + rLen);
  i = i + 2 + rLen;
  if (der[i] !== 0x02) throw new Error("DER: missing s INTEGER tag");
  const sLen = der[i + 1];
  let s = der.slice(i + 2, i + 2 + sLen);
  while (r[0] === 0x00 && r.length > 32) r = r.slice(1);
  while (r.length < 32) r = new Uint8Array([0, ...r]);
  while (s[0] === 0x00 && s.length > 32) s = s.slice(1);
  while (s.length < 32) s = new Uint8Array([0, ...s]);
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
};

const constantTimeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

// Returns true if the assertion's signature is genuinely produced by
// the authenticator that holds the private key corresponding to the
// stored public key. Also checks: assertion type is "webauthn.get",
// challenge matches the one we issued, RP ID hash matches our origin.
const verifyAssertionSignature = async (cred, assertion, expectedChallenge) => {
  try {
    if (!cred.publicKey) return false;
    const alg = cred.publicKeyAlgorithm || -7; // default ES256 for legacy creds
    const spki = b64uDecode(cred.publicKey);

    // 1. Verify clientDataJSON's type + challenge.
    const clientDataBytes = new Uint8Array(assertion.response.clientDataJSON);
    const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
    if (clientData.type !== "webauthn.get") return false;
    const expectedChallengeB64u = b64uEncode(expectedChallenge);
    if (clientData.challenge !== expectedChallengeB64u) return false;

    // 2. Verify rpIdHash (first 32 bytes of authenticatorData) matches
    //    sha256(hostname).
    const authData = new Uint8Array(assertion.response.authenticatorData);
    if (authData.length < 37) return false; // rpIdHash(32) + flags(1) + counter(4)
    const rpIdHash = authData.slice(0, 32);
    const expectedRpHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(window.location.hostname))
    );
    if (!constantTimeEqual(rpIdHash, expectedRpHash)) return false;

    // 3. Verify the UV flag is set (UP bit = 0x01, UV bit = 0x04).
    const flags = authData[32];
    if ((flags & 0x01) === 0) return false; // UP must be set
    if ((flags & 0x04) === 0) return false; // UV must be set (we required it at enroll)

    // 4. Verify the signature: signed data = authenticatorData || sha256(clientDataJSON).
    const clientHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", clientDataBytes)
    );
    const signedData = new Uint8Array(authData.length + 32);
    signedData.set(authData, 0);
    signedData.set(clientHash, authData.length);

    let importParams, verifyParams;
    let sigBytes = new Uint8Array(assertion.response.signature);
    if (alg === -7) {
      importParams = { name: "ECDSA", namedCurve: "P-256" };
      verifyParams = { name: "ECDSA", hash: { name: "SHA-256" } };
      sigBytes = derToRawECDSA(sigBytes);
    } else if (alg === -8) {
      importParams = { name: "Ed25519" };
      verifyParams = { name: "Ed25519" };
    } else if (alg === -257) {
      importParams = { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } };
      verifyParams = { name: "RSASSA-PKCS1-v1_5" };
    } else {
      return false;
    }
    const pubKey = await crypto.subtle.importKey(
      "spki", spki, importParams, false, ["verify"]
    );
    return await crypto.subtle.verify(verifyParams, pubKey, sigBytes, signedData);
  } catch (err) {
    console.warn("[hey-home] verifyAssertionSignature failed", err);
    return false;
  }
};

// Assert a passkey against the credentials stored in the profile.
// Returns { assertion, prfOutput }: the assertion is always present
// on success; prfOutput is a Uint8Array(32) when the authenticator
// supports the PRF extension and the user has a vault, otherwise null.
// Throws if the user cancels, no authenticator matches, OR the
// signature fails local verification.
const assertPasskey = async (profile) => {
  const creds = profile.passkeys || [];
  if (creds.length === 0) throw new Error("No passkey enrolled on this profile");
  const allowCredentials = creds.map((pk) => ({
    id: b64uDecode(pk.id),
    type: "public-key",
    transports: pk.transports || [],
  }));
  const challenge = randomBytes(32);

  // PRF input MUST be the unified identity seed — same as enrollment
  // in hey-vault.js (and the same one Hey Social uses). The vault key
  // is HKDF-derived from this output below, so a stale "hey-home-
  // vault-v1" input would compute a wrap key that can't decrypt what
  // enrollment wrote. The same identityPrf is also what the server-
  // side passkey unlock needs to verify possession of the Ed25519
  // private key.
  const prfInput = new TextEncoder().encode("elastos-identity-v1").buffer;

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: window.location.hostname,
      timeout: 60_000,
      userVerification: "required",
      allowCredentials,
      extensions: { prf: { eval: { first: prfInput } } },
    },
  });
  if (!assertion) throw new Error("Passkey authentication cancelled");

  // Identify which stored cred produced this assertion.
  const usedId = b64uEncode(new Uint8Array(assertion.rawId));
  const used = creds.find((c) => c.id === usedId);
  if (!used) throw new Error("Assertion from unknown credential");

  // The OS gesture isn't enough on its own — verify the signature
  // locally against the registered public key.
  const verified = await verifyAssertionSignature(used, assertion, challenge);
  if (!verified) throw new Error("Passkey assertion failed signature verification");

  // Raw identityPrf (32 bytes hmac-secret output). The legacy
  // `prfOutput` name kept for callers; new callers should treat it
  // as the IDENTITY PRF and HKDF-derive vault keys from it.
  const prfRaw =
    assertion.getClientExtensionResults?.()?.prf?.results?.first;
  const identityPrf = prfRaw ? new Uint8Array(prfRaw) : null;

  return { assertion, prfOutput: identityPrf, identityPrf };
};

// requireAuth — prompt the user for either a passkey or PIN.
// Used to gate destructive lock-screen actions (e.g. "Switch identity")
// behind the same authentication the unlock flow uses. Returns true on
// successful auth, false if the user cancels or fails.
const requireAuth = async (profile) => {
  const hasPasskey = passkeySupported() && (profile.passkeys || []).length > 0;
  // Try passkey first when available — fast, no UI of our own.
  if (hasPasskey) {
    try {
      await assertPasskey(profile);
      return true;
    } catch (err) {
      console.warn("[hey-home] passkey auth declined; falling back to PIN", err);
      // Fall through to PIN prompt only if user cancelled. For genuine
      // verification failures (signature wrong) we still allow PIN as
      // an alternative — the PIN itself is rate-limited.
    }
  }
  // PIN path via the existing frosted hey-modal prompt.
  const heyPromptFn = window.heyPrompt;
  if (typeof heyPromptFn !== "function") return false;
  const { pinHash, pinSalt } = readPinFields(profile);
  if (!pinHash || !pinSalt) {
    // No PIN configured — and (above) no passkey worked. Deny.
    return false;
  }
  const pin = await heyPromptFn(
    "Enter your 6-digit PIN to continue",
    { title: "Confirm", confirmLabel: "Continue", cancelLabel: "Cancel", type: "password", placeholder: "••••••" }
  );
  if (!pin) return false;
  return verifyPin(pin, profile);
};

// ── DOM helper ─────────────────────────────────────────────────────
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
};

const svg = (attrs, html) => {
  const wrap = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries(attrs || {})) wrap.setAttribute(k, v);
  if (html) wrap.innerHTML = html;
  return wrap;
};

// ── Clock + date ──────────────────────────────────────────────────
const tickClock = (hhEl, mmEl) => {
  const d = new Date();
  hhEl.textContent = d.getHours().toString().padStart(2, "0");
  mmEl.textContent = d.getMinutes().toString().padStart(2, "0");
};
const setDate = (dateEl) => {
  const days = ["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"];
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const d = new Date();
  dateEl.textContent = `${days[d.getDay()]} · ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
};

// ── Shared decorations (glows) ────────────────────────────────────
const buildGlows = () => [
  el("div", { class: "hw-glow a" }),
  el("div", { class: "hw-glow b" }),
  el("div", { class: "hw-glow c" }),
];

// ── Greeting flash (used by both flows on hand-off to desktop) ───
const buildGreeting = (name) => el("div", { id: "hey-greeting" }, [
  el("div", { class: "hw-greet-mark" }, [`Hey, ${name}`]),
  el("div", { class: "hw-greet-sub" }, ["Your iroh node is online · zero servers"]),
]);

// Refuse to hand off to the desktop if a vault has been set up but
// isn't unlocked. Without this gate, an attacker who defeats the
// "soft" PIN check (or just bypasses the welcome layer via DevTools)
// reaches the desktop even when the user's actual data is sealed
// behind passkey-PRF. Returns true on success (vault OK, or no vault
// configured), false if hand-off should be blocked.
const enforceVaultGate = async () => {
  if (!window.heyVault) return true; // vault module not loaded — pre-vault era
  try {
    const hasVault = await window.heyVault.hasVault();
    if (!hasVault) return true; // no vault → no constraint
    if (window.heyVault.isUnlocked()) return true; // vault unlocked → proceed
  } catch (err) {
    console.warn("[hey-home] vault gate check failed", err);
    // Fail open on infrastructure errors — but log loudly.
    return true;
  }
  // Vault exists but isn't unlocked: refuse hand-off.
  window.heyAlert?.(
    "This account has a passkey-protected vault. Tap your passkey to unlock — PIN alone won't open vault data.",
    { title: "Vault locked", confirmLabel: "OK" }
  );
  return false;
};

// Brief, repeatable glow flare across the backdrop orbs. Used at every
// slide transition (step1 → step2, PIN setup card appearing, PIN
// confirm, passkey gesture, etc.) to keep the screen feeling alive as
// the user moves toward the desktop. The CSS handles the actual filter
// transition — this just toggles the attribute.
const flareGlows = (root, duration = 650) => {
  if (!root) return;
  root.setAttribute("data-flare", "true");
  setTimeout(() => root.removeAttribute("data-flare"), duration);
};

// Re-trigger a step's enter animation when it's shown after being
// display:none. CSS handles the animation; we have to remove and re-add
// the data-replay attribute across a paint to reset animation-name.
const replayStepEnter = (step) => {
  if (!step) return;
  step.setAttribute("data-replay", "true");
  // Force a reflow so the browser commits the "animation: none" state
  // before we remove the attribute, otherwise the reset is coalesced
  // away and the animation never restarts.
  void step.offsetWidth;
  step.removeAttribute("data-replay");
};

const handOffToDesktop = (root, greeting) => {
  // 1) Flare: data-state="unlocking" runs the gold glow burst + card release.
  // 2) After ~450ms, fade greeting in; lock state flips after a moment.
  // 3) Final removal once the greeting fade-out completes.
  root.setAttribute("data-state", "unlocking");
  setTimeout(() => greeting.setAttribute("data-state", "visible"), 350);
  setTimeout(() => {
    root.setAttribute("data-state", "unlocked");
    document.body.removeAttribute("data-locked");
    // Clear any clock interval the welcome attached to its root.
    const handle = root.__heyHomeClockInterval;
    if (handle) clearInterval(handle);
  }, 950);
  setTimeout(() => {
    greeting.remove();
    root.remove();
  }, 2800);
};

// ── Welcome / lock screen (existing user) ─────────────────────────
const buildWelcome = (profile) => {
  const root = el("div", { id: "hey-welcome", "data-state": "locked" });
  buildGlows().forEach((g) => root.appendChild(g));

  // Clock
  const hh = el("span"); const mm = el("span");
  hh.textContent = "00"; mm.textContent = "00";
  const clock = el("div", { class: "hw-clock" }, [
    hh, el("span", { class: "colon" }, [":"]), mm,
  ]);
  const date = el("div", { class: "hw-date" }, ["—"]);
  root.appendChild(clock);
  root.appendChild(date);
  root.appendChild(el("div", { class: "hw-divider" }));

  // User card
  const avatar = el("div", { class: "hw-avatar" }, [profile.name[0].toUpperCase()]);
  const username = el("div", { class: "hw-username" }, [
    el("span", { class: "at" }, ["@"]),
    profile.name,
  ]);
  const didEl = el("div", { class: "hw-did" }, [
    el("span", { class: "key" }, ["did:key:"]),
    profile.didKey.replace(/^did:key:/, "").slice(0, 36) + "…",
  ]);
  const meta = el("div", { class: "hw-meta" }, [
    el("span", { class: "pip" }),
    el("span", {}, ["node online"]),
    el("span", { class: "sep" }, ["·"]),
    el("span", {}, ["iroh online"]),
    el("span", { class: "sep" }, ["·"]),
    el("span", {}, [`since ${new Date(profile.createdAt).toLocaleDateString()}`]),
  ]);

  // ── Legacy profile banner ────────────────────────────────────────
  // Profiles minted before the Ed25519 rewrite have a SHA-256-stub
  // did:key that can't sign verifiably. Hey-Home still works for them,
  // but Hey Social won't accept their events. Surface a one-line nudge.
  const legacyBanner = profile.legacy
    ? el("div", {
        class: "hw-legacy-banner",
        style:
          "margin: 10px 0 0; padding: 8px 12px;" +
          "background: rgba(212, 184, 75, 0.12);" +
          "border: 1px solid rgba(212, 184, 75, 0.35);" +
          "border-radius: 10px;" +
          "font-size: 12px; color: rgba(248,250,252,0.88);" +
          "display: flex; gap: 8px; align-items: flex-start;",
      }, [
        svg({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
          "stroke-width": "1.75", "stroke-linecap": "round",
          style: "width:14px;height:14px;flex-shrink:0;margin-top:1px;" },
          '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="10"/>'),
        el("span", {}, [
          "This identity was made before the Ed25519 rewrite. " +
          "Switch identity to re-mint a real signing key (Hey Social won't accept events from this one).",
        ]),
      ])
    : null;

  // ── Carrier ticket reveal ────────────────────────────────────────
  // Loads asynchronously from the runtime's peer provider; stays hidden
  // if get_ticket fails (dev mode, runtime down, capability denied, …).
  const ticketLabel = el("span", { class: "label" }, ["Tap to copy your iroh ticket"]);
  const ticketBtn = el("button", {
    type: "button",
    class: "hw-ticket-btn",
    style:
      "display: none;" +
      "margin: 12px 0 0; padding: 8px 12px;" +
      "background: rgba(255, 255, 255, 0.04);" +
      "border: 1px solid rgba(255, 255, 255, 0.12);" +
      "border-radius: 10px;" +
      "color: rgba(248,250,252,0.85);" +
      "font: inherit; font-size: 12px;" +
      "cursor: pointer;" +
      "align-items: center; gap: 8px;" +
      "transition: background 0.15s, border-color 0.15s;",
    title: "Tap to copy your iroh ticket for others to connect",
  }, [
    svg({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round",
      style: "width:14px;height:14px;flex-shrink:0;" },
      '<path d="M4 12a8 8 0 0 1 16 0M7 12a5 5 0 0 1 10 0M12 12v.01"/>'),
    ticketLabel,
  ]);
  if (window.heyRuntime?.peer) {
    window.heyRuntime.peer.getTicket().then((resp) => {
      const t = resp?.data?.ticket || resp?.ticket || (typeof resp?.data === "string" ? resp.data : null);
      if (t && typeof t === "string" && t.length > 0) {
        ticketBtn.dataset.ticket = t;
        ticketBtn.style.display = "inline-flex";
      }
    }).catch(() => { /* dev mode etc. — just hide */ });
  }
  ticketBtn.addEventListener("click", async () => {
    const t = ticketBtn.dataset.ticket;
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      ticketLabel.textContent = "Copied — share to bring a peer";
      setTimeout(() => {
        ticketLabel.textContent = "Tap to copy your iroh ticket";
      }, 1600);
    } catch (err) {
      console.warn("[hey-home] clipboard write failed", err);
      ticketLabel.textContent = "Couldn't copy — long-press the field";
    }
  });

  const hasPasskey = (profile.passkeys || []).length > 0 && passkeySupported();
  // pinHash is null on preview-only profiles (loaded via /api/auth/
  // state without capability tokens), but heyHome.fromPreview signals
  // "the server says a PIN exists". Treat both as "has PIN" so the
  // lock screen renders the PIN field — actual verification still
  // happens server-side via /api/auth/unlock.
  const hasPin =
    !!readPinFields(profile).pinHash || !!profile?.heyHome?.fromPreview;
  // Strict rule (per user request): the lock screen shows ONE unlock
  // method, never two. If a passkey is enrolled, that's the only
  // option — the PIN field disappears even if a stored PIN is present
  // (e.g. from a legacy profile or an old "added passkey later" path).
  // Eliminates the confusing "tap passkey OR type PIN" dual-prompt
  // and matches the signup contract: passkey-signups never set a PIN,
  // PIN-only signups never get a passkey button.
  const passkeyOnly = hasPasskey;

  // PIN dots
  const pins = el("div", { class: "hw-pins" });
  for (let i = 0; i < 6; i++) pins.appendChild(el("div", { class: "hw-pin" }));
  const hint = el("div", { class: "hw-hint" }, [
    passkeyOnly ? "Tap your passkey to unlock" : "Enter recovery PIN",
  ]);

  const passkeyBtnLabel = el("span", {}, [
    passkeyOnly ? "Unlock with passkey" : "Use passkey",
  ]);
  const passkeyBtn = hasPasskey ? el("button", {
    class: passkeyOnly ? "hw-btn primary" : "hw-btn",
    type: "button",
  }, [
    svg({ viewBox: "0 0 24 24", fill: "currentColor", style: "width:14px;height:14px;" },
      '<path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Z"/>'),
    passkeyBtnLabel,
  ]) : null;
  const unlockBtn = el("button", { class: "hw-btn primary", type: "button" }, [
    "Unlock",
    svg({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
      style: "width:14px;height:14px;" },
      '<path d="M5 12h14M13 5l7 7-7 7"/>'),
  ]);
  // Hide PIN-related UI when passkey is the active method.
  if (passkeyOnly) {
    pins.style.display = "none";
    unlockBtn.style.display = "none";
  }
  const buttons = el("div", { class: "hw-buttons" },
    passkeyOnly ? [passkeyBtn] : [unlockBtn]
  );
  const passkeyError = el("div", {
    class: "hw-passkey-error",
    style: "display:none;",
  });

  const card = el("div", { class: "hw-card" }, [
    avatar, username, didEl, meta, legacyBanner, ticketBtn, pins, hint, buttons, passkeyError,
  ]);
  root.appendChild(card);

  // Bottom row
  const mesh = el("div", { class: "hw-mesh" }, [
    el("span", { class: "dot" }),
    "iroh online · zero servers",
  ]);
  const build = el("div", { class: "hw-build" }, ["hey-home · v0.1.0 · localhost"]);
  const switchBtn = el("button", { class: "hw-switch", type: "button" }, [
    svg({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round",
      style: "width:13px;height:13px;" },
      '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    "Switch identity",
  ]);
  switchBtn.addEventListener("click", async () => {
    // SECURITY: gate the destructive "Switch identity" path behind the
    // same authentication the unlock flow requires. Without this, anyone
    // with physical access to the locked screen can erase the profile
    // (denial-of-service / takeover). requireAuth() asks for a passkey
    // first, falls back to PIN.
    const authed = await requireAuth(profile);
    if (!authed) {
      window.heyAlert?.("Authentication required to switch identity.", {
        title: "Switch identity",
        confirmLabel: "OK",
      });
      return;
    }
    const ok = await (window.heyConfirm || ((m) => Promise.resolve(confirm(m))))(
      "This will erase the Hey-Home profile on this node and return to first-run setup. Your recovery key is the only way to come back.",
      {
        title: "Switch identity?",
        confirmLabel: "Erase profile",
        cancelLabel: "Keep this one",
        danger: true,
      }
    );
    if (ok) {
      switchBtn.disabled = true;
      await clearProfile();
      location.reload();
    }
  });
  root.appendChild(el("div", { class: "hw-bottom" }, [mesh, build, switchBtn]));

  const greeting = buildGreeting(profile.name);

  // ── REAL PIN gate ────────────────────────────────────────────────
  // Hidden text input collects digits; .hw-pin dots reflect length;
  // submit hashes + compares to profile.pinHash. The visible "Unlock"
  // button submits the current entry. No bypass.
  //
  // Legacy profiles (no pinHash): prompt the user to set one before
  // their first unlock.
  const dots = pins.querySelectorAll(".hw-pin");

  const hiddenPin = el("input", {
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
    maxlength: "6",
    class: "hw-pin-input",
    style: "position:absolute; opacity:0; pointer-events:none; width:1px; height:1px;",
  });
  card.appendChild(hiddenPin);
  // Tapping the dots focuses the hidden input so a mobile keyboard pops up.
  pins.addEventListener("click", () => hiddenPin.focus());
  setTimeout(() => hiddenPin.focus(), 200);

  const updateDots = () => {
    const len = hiddenPin.value.length;
    dots.forEach((d, i) => {
      if (i < len) d.classList.add("lit");
      else d.classList.remove("lit", "pop");
    });
  };
  hiddenPin.addEventListener("input", () => {
    hiddenPin.value = hiddenPin.value.replace(/\D/g, "").slice(0, 6);
    updateDots();
    if (hiddenPin.value.length === 6) {
      // auto-submit on full PIN
      tryUnlock();
    }
  });
  hiddenPin.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); tryUnlock(); }
  });

  const wrongFlash = () => {
    pins.classList.add("hw-pin-wrong");
    setTimeout(() => {
      pins.classList.remove("hw-pin-wrong");
      hiddenPin.value = "";
      updateDots();
      hiddenPin.focus();
    }, 480);
  };

  const successFlash = (then) => {
    dots.forEach((d, idx) => {
      setTimeout(() => {
        d.classList.add("lit", "pop");
        setTimeout(() => d.classList.remove("pop"), 200);
      }, idx * 30);
    });
    setTimeout(then, dots.length * 30 + 300);
  };

  // PIN brute-force lockout schedule (exponential after 5 failures, cap 1h).
  // Lockout duration in ms after the Nth failure:
  //   attempts < 5: no lockout (just wrong-flash)
  //   attempt 5:    1s
  //   attempt 6:    2s
  //   attempt 7:    4s
  //   ...
  //   attempt 17+:  3600s (1h cap)
  // After ~17 wrong attempts an attacker is locked out for 1h between
  // each subsequent try — extrapolating to 1M PIN combos that's ~114
  // years to brute force. State persists in profile.heyHome so a
  // refresh/reload doesn't reset.
  const lockoutMsForAttempts = (n) =>
    n < 5 ? 0 : Math.min(Math.pow(2, n - 5) * 1000, 3_600_000);

  const tryUnlock = async () => {
    if (!hasPin) {
      // Profile has no PIN. If a passkey is enrolled, that IS the
      // unlock method — don't force-set a PIN on top (passkey is the
      // stronger credential; a PIN fallback would just be the weakest
      // link). If neither is set, this is a legacy profile pre-dating
      // the PIN gate — force-set one so unlock isn't impossible.
      if (hasPasskey) return;
      promptPinSetup();
      return;
    }
    const hh = profile.heyHome || {};
    // Check active lockout first.
    if (hh.lockedUntil && hh.lockedUntil > Date.now()) {
      const remaining = Math.ceil((hh.lockedUntil - Date.now()) / 1000);
      hint.textContent = `Locked. Try again in ${remaining}s`;
      wrongFlash();
      return;
    }
    if (hiddenPin.value.length !== 6) {
      hint.textContent = "Enter all 6 digits";
      return;
    }
    unlockBtn.disabled = true;
    // Server is the single source of truth for PIN verification. It
    // holds the canonical pinHash + pinSalt, runs the same PBKDF2 the
    // client used to do locally, and graduates the session on match.
    // For preview-only profiles (loaded via /api/auth/state without
    // capability tokens) we don't HAVE the local hash anyway, so the
    // server check is the only option. For full profiles the local
    // check would have given the same answer — no functional change.
    const ok = await serverUnlockWithPin(hiddenPin.value);
    if (ok) {
      // Reset attempt counters on successful unlock.
      profile.heyHome = { ...(profile.heyHome || {}), failedAttempts: 0, lockedUntil: null };
      // Don't write the preview-only profile back to storage — it has
      // null pinHash and would clobber the real one. saveProfile only
      // runs when we have a real profile in hand.
      if (!profile.previewOnly) {
        await saveProfile(profile);
      }
      // PIN passed — but if a vault is configured, the master key
      // isn't derived from PIN. Refuse hand-off so vault-sealed data
      // stays inaccessible. User has to tap passkey or use recovery.
      if (!(await enforceVaultGate())) {
        unlockBtn.disabled = false;
        return;
      }
      hint.textContent = "Welcome back…";
      successFlash(() => handOffToDesktop(root, greeting));
    } else {
      unlockBtn.disabled = false;
      const attempts = (hh.failedAttempts || 0) + 1;
      const lockoutMs = lockoutMsForAttempts(attempts);
      profile.heyHome = {
        ...(profile.heyHome || {}),
        failedAttempts: attempts,
        lockedUntil: lockoutMs > 0 ? Date.now() + lockoutMs : null,
      };
      // Don't save the preview profile back — it has null pinHash
      // and would corrupt the real identity on disk. The server-side
      // rate limiter (5/60s cooldown per session) is the actual
      // brute-force defense; the local lockout below is UX-only.
      if (!profile.previewOnly) {
        await saveProfile(profile);
      }
      if (lockoutMs > 0) {
        hint.textContent = `Locked. Try again in ${Math.ceil(lockoutMs / 1000)}s`;
      } else {
        const left = Math.max(0, 5 - attempts);
        hint.textContent = left > 0
          ? `Wrong PIN — ${left} ${left === 1 ? "try" : "tries"} until lockout`
          : "Wrong PIN";
      }
      wrongFlash();
    }
  };

  unlockBtn.addEventListener("click", tryUnlock);

  // Migration: prompt PIN setup for legacy profiles.
  const promptPinSetup = () => {
    hint.textContent = "Set a 6-digit PIN to lock this account";
    hiddenPin.value = "";
    updateDots();
    // Reuse the same input — but switch handler: first 6 digits sets the
    // PIN, second 6 digits confirm it.
    let stage = "set";
    let firstPin = "";
    hiddenPin.oninput = () => {
      hiddenPin.value = hiddenPin.value.replace(/\D/g, "").slice(0, 6);
      updateDots();
      if (hiddenPin.value.length !== 6) return;
      if (stage === "set") {
        firstPin = hiddenPin.value;
        hiddenPin.value = "";
        updateDots();
        stage = "confirm";
        hint.textContent = "Confirm the PIN";
        return;
      }
      // stage === "confirm"
      if (hiddenPin.value !== firstPin) {
        hint.textContent = "PINs don't match — try again";
        firstPin = "";
        stage = "set";
        wrongFlash();
        return;
      }
      // Save the PIN to the profile and unlock. PIN fields are
      // namespaced under .heyHome (see readPinFields/writePinFields).
      const salt = generatePinSalt();
      hashPin(firstPin, salt).then(async (pinHash) => {
        const updated = writePinFields(profile, { pinSalt: salt, pinHash });
        await saveProfile(updated);
        // Same vault-gate as the regular PIN unlock path.
        if (!(await enforceVaultGate())) return;
        hint.textContent = "PIN saved · unlocking…";
        successFlash(() => handOffToDesktop(root, greeting));
      });
    };
  };

  if (passkeyBtn) {
    passkeyBtn.addEventListener("click", async () => {
      passkeyError.style.display = "none";
      passkeyBtn.disabled = true;
      const wasText = passkeyBtnLabel.textContent;
      passkeyBtnLabel.textContent = "Tap your authenticator…";
      try {
        const { identityPrf } = await assertPasskey(profile);
        // Server-side unlock (Approach A step 5c). Signs a fresh
        // server-issued challenge with the identityPrf-derived
        // Ed25519 key — same key whose did:key is stored in the
        // shared identity. Server verifies the signature against
        // that didKey to flip the session from PreAuth to
        // Authenticated. Best-effort: gate-disabled installs work
        // even if this is a no-op.
        await serverUnlockWithPasskey(identityPrf);
        // If a vault is configured, unwrap the master key now. With
        // the vault gate in place below, failing this means we refuse
        // hand-off — the user can't reach the desktop without the
        // master key materialized.
        if (window.heyVault && (await window.heyVault.hasVault())) {
          if (!identityPrf) {
            throw new Error(
              "This passkey doesn't produce a PRF output — can't unlock vault. " +
              "Re-enroll a PRF-capable authenticator (Yubikey 5.7+, Touch ID on " +
              "macOS 14+, modern Windows Hello, Android 14+) or unlock via recovery key."
            );
          }
          // HKDF-derive the vault key from the identity PRF (matches
          // what hey-vault.js's enrollPasskeyForVault wraps with).
          // Using identityPrf directly would compute a different key
          // and the unwrap would fail.
          const vaultPrf = await deriveVaultPrf(identityPrf, "hey-home-vault-v1");
          await window.heyVault.unlockVaultWithPRF(vaultPrf);
        }
        if (!(await enforceVaultGate())) {
          passkeyBtn.disabled = false;
          passkeyBtnLabel.textContent = wasText;
          return;
        }
        // Visual confirmation: flash all pins gold
        const dots = pins.querySelectorAll(".hw-pin");
        dots.forEach((d, idx) => {
          setTimeout(() => {
            d.classList.add("lit", "pop");
            setTimeout(() => d.classList.remove("pop"), 200);
          }, idx * 30);
        });
        setTimeout(() => handOffToDesktop(root, greeting), 500);
      } catch (err) {
        console.error("[hey-home] passkey unlock failed", err);
        passkeyBtn.disabled = false;
        passkeyBtnLabel.textContent = wasText;
        passkeyError.textContent =
          err && err.name === "NotAllowedError"
            ? "Passkey check cancelled or no matching authenticator."
            : `Passkey unlock failed: ${err.message || err}`;
        passkeyError.style.display = "block";
      }
    });
  }

  return { root, greeting, clockHandle: { hh, mm, date } };
};

// ── First-run setup wizard ────────────────────────────────────────
const buildSetup = () => {
  const root = el("div", { id: "hey-welcome", "data-state": "setup" });
  buildGlows().forEach((g) => root.appendChild(g));

  // Step 1: nickname
  const heymark = el("div", { class: "hw-heymark" }, [
    svg({ class: "hw-heymark-svg", viewBox: "0 0 480 280" },
      '<text x="110" y="200">H</text><text x="230" y="200">e</text><text x="320" y="200">y</text>'),
  ]);
  const tagline = el("p", { class: "hw-tagline" }, [
    "Welcome to ",
    el("span", { class: "em" }, ["Hey-Home"]),
    ".",
    el("br"),
    "Pick a nickname — we'll mint your recovery key locally.",
  ]);

  const nameInput = el("input", {
    class: "hw-name-input", id: "hw-name", type: "text",
    placeholder: "Pick a nickname", autocomplete: "off",
  });
  const continueBtn = el("button", { class: "hw-btn primary", type: "button" }, [
    "Generate my identity",
    svg({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
      style: "width:14px;height:14px;" },
      '<path d="M5 12h14M13 5l7 7-7 7"/>'),
  ]);

  const nameCard = el("form", { class: "hw-name-card" }, [nameInput, continueBtn]);
  nameCard.addEventListener("submit", (e) => { e.preventDefault(); continueBtn.click(); });

  // Passkey path — only shown when WebAuthn is available
  let passkeyRow = null;
  if (passkeySupported()) {
    const orRow = el("div", { class: "hw-or-row" }, ["or"]);
    const passkeyBtn = el("button", { class: "hw-passkey-btn", type: "button" }, [
      svg({ viewBox: "0 0 24 24", fill: "currentColor",
        style: "width:14px;height:14px;" },
        '<path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Z"/>'),
      "Sign up with a passkey",
    ]);
    passkeyBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim().slice(0, 30);
      if (!name) {
        nameInput.focus();
        nameInput.setAttribute("placeholder", "Pick a nickname first");
        return;
      }
      passkeyBtn.disabled = true;
      passkeyBtn.textContent = "Tap your authenticator…";
      try {
        // Prefer the PRF-enabled enrollment so this passkey can both
        // unlock AND derive the vault master key. If the authenticator
        // can't do PRF, fall back to the plain enrollment — the vault
        // simply won't be set up, and the lock screen stays UX-level.
        //
        // Some hardware keys (Nitrokey 3, some older Yubikeys) deliver
        // the hmac-secret PRF output only on a follow-up assertion, not
        // on create() — meaning the OS prompts for PIN twice. The
        // onStatus callback below updates the button label so the user
        // knows the second prompt is intentional, not a glitch.
        let credential = null;
        let prfOutput = null;
        let identityPrf = null;
        if (window.heyVault?.enrollPasskeyForVault) {
          try {
            const vaultEnroll = await window.heyVault.enrollPasskeyForVault({
              name,
              onStatus: (phase) => {
                if (phase === "creating") {
                  passkeyBtn.textContent = "Tap your authenticator…";
                } else if (phase === "deriving") {
                  passkeyBtn.textContent =
                    "Tap again to finalize encryption key…";
                  flareGlows(root, 700);
                }
              },
            });
            credential = vaultEnroll.credential;
            prfOutput = vaultEnroll.prfOutput;
            identityPrf = vaultEnroll.identityPrf || null;
          } catch (vaultErr) {
            if (vaultErr.name === "PRFNotSupported") {
              console.warn("[hey-home] PRF not supported by this authenticator — vault skipped");
            } else {
              throw vaultErr;
            }
          }
        }
        if (!credential) {
          credential = await enrollPasskey(name);
          identityPrf = credential._identityPrf || null;
          prfOutput = credential._vaultPrf || null;
        } else {
          // Repackage the credential into the same shape enrollPasskey
          // returns, so proceedToKeyCard can store it in profile.passkeys.
          const response = credential.response;
          let publicKeyB64u = null;
          if (response.getPublicKey) {
            const pk = response.getPublicKey();
            if (pk) publicKeyB64u = b64uEncode(new Uint8Array(pk));
          }
          const publicKeyAlgorithm =
            response.getPublicKeyAlgorithm ? response.getPublicKeyAlgorithm() : null;
          const transports =
            response.getTransports ? response.getTransports() : [];
          credential = {
            id: b64uEncode(new Uint8Array(credential.rawId)),
            publicKey: publicKeyB64u,
            publicKeyAlgorithm,
            transports,
            createdAt: new Date().toISOString(),
            prfSupported: true,
          };
        }
        await proceedToKeyCard({ name, passkey: credential, prfOutput, identityPrf });
      } catch (err) {
        console.error("[hey-home] passkey enrollment failed", err);
        passkeyBtn.disabled = false;
        passkeyBtn.textContent = "Sign up with a passkey";
        passkeyErrorMsg.textContent =
          err && err.name === "NotAllowedError"
            ? "Passkey enrollment cancelled — try again or use a recovery key."
            : `Could not enroll passkey: ${err.message || err}`;
        passkeyErrorMsg.style.display = "block";
      }
    });
    passkeyRow = el("div", { class: "hw-passkey-row" }, [orRow, passkeyBtn]);
  }
  const passkeyErrorMsg = el("div", {
    class: "hw-passkey-error",
    style: "display:none;",
  });

  const step1 = el("section", { class: "hw-setup-step", "data-step": "1" }, [
    heymark, tagline, nameCard, passkeyRow, passkeyErrorMsg,
  ]);

  // Step 2: key card (built after nickname submit)
  const step2 = el("section", { class: "hw-setup-step", "data-step": "2", style: "display:none;" });

  root.appendChild(step1);
  root.appendChild(step2);

  // Build mesh status footer
  const mesh = el("div", { class: "hw-mesh" }, [
    el("span", { class: "dot" }),
    "iroh mesh · zero servers · creating local node",
  ]);
  const build = el("div", { class: "hw-build" }, ["hey-home · v0.1.0 · first-run setup"]);
  root.appendChild(el("div", { class: "hw-bottom" }, [mesh, build, el("span")]));

  // Build the profile, optionally prompt PIN setup, then show the
  // recovery-key card.
  //
  // PIN is only collected when NO passkey was enrolled. A passkey is
  // a 256-bit hardware-backed credential; a PIN is ~20 bits and would
  // just become the weakest link if it sat alongside as a fallback.
  // Passkey-only profiles unlock by passkey; PIN-only profiles unlock
  // by PIN; users who want both can attach a passkey later from a
  // settings page (TBD).
  //
  // The raw recoveryKey is held in a local variable, shown ONCE on the
  // key card, and never written to storage. Only its SHA-256 hash
  // (recoveryKeyHash) plus the derived Ed25519 public key (pubKeyHex)
  // are persisted — same shape Hey Social writes via writeSharedIdentity.
  const proceedToKeyCard = async ({ name, passkey, prfOutput, identityPrf }) => {
    const ident = window.heyIdentity;
    if (!ident) throw new Error("hey-identity.js not loaded");

    // SECURITY: re-check the shared identity right before writing it.
    // Closes a race window: between page-load (when buildSetup decided
    // to show the wizard) and now, another device or capsule may have
    // written the shared identity. Writing here would overwrite the
    // legitimate user's identity. If we detect one, refuse and tell
    // the user to sign in instead.
    const existingShared = await runtimeGet(SHARED_IDENTITY_PATH);
    if (existingShared.ok && existingShared.value && existingShared.value.didKey) {
      throw new Error(
        "This node already has a user. Reload the page and sign in with " +
        "your existing passkey or recovery PIN instead of signing up."
      );
    }

    // Unified cross-capsule identity. When the passkey produced an
    // identity-PRF output ('elastos-identity-v1'), derive the recovery
    // key from those 32 bytes — every Elastos capsule using the same
    // passkey + same PRF input gets the SAME bytes → same Ed25519
    // keypair → same did:key. One identity across the device.
    //
    // When PRF isn't available (older authenticators, no-passkey signups,
    // PIN-only path) fall back to a random recoveryKey — same as before.
    const bytesToHex = (b) =>
      [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const recoveryKey =
      identityPrf && identityPrf.length === 32
        ? bytesToHex(identityPrf)
        : ident.generateRecoveryKey();
    const { didKey, pubKeyHex } = await ident.expandKeypair(recoveryKey);
    const recoveryKeyHash = await ident.hashAuthKey(recoveryKey);

    // If the passkey supports PRF, initialize the vault NOW — wraps the
    // master key with both the PRF output and the recovery key (so
    // either path can unlock later). Failures here downgrade silently:
    // signup completes, lock screen is UX-only without a vault.
    let vaultInitialized = false;
    if (prfOutput && window.heyVault?.initVault) {
      try {
        await window.heyVault.initVault({ prfOutput, recoveryHex: recoveryKey });
        vaultInitialized = true;
      } catch (err) {
        console.warn("[hey-home] vault init failed; continuing without vault", err);
      }
    }

    let pinSalt = null;
    let pinHash = null;
    if (!passkey) {
      // No passkey — PIN is the only unlock method, so collect it.
      pinSalt = generatePinSalt();
      const pin = await collectNewPin(step1, root);
      pinHash = await hashPin(pin, pinSalt);
    }

    const baseProfile = {
      name,
      didKey,
      pubKeyHex,
      recoveryKeyHash,
      passkeys: passkey ? [passkey] : [],
      createdAt: new Date().toISOString(),
      createdBy: "hey-home",
    };
    const profile = pinHash
      ? writePinFields(baseProfile, { pinSalt, pinHash })
      : baseProfile;

    // Flare bridges the two cards: glow brightens as step1 lifts away
    // and is still fading when step2 enters, so the swap feels like one
    // continuous beat instead of two disconnected ones.
    flareGlows(root, 850);
    step1.classList.add("hw-step-exit");
    await new Promise((r) => setTimeout(r, 240));
    step1.style.display = "none";
    renderKeyCard(step2, profile, recoveryKey, root);
    step2.style.display = "flex";
    replayStepEnter(step2);
  };

  // Replace step1 contents with a PIN-setup card; resolve when the user
  // has entered the same 6 digits twice.
  const collectNewPin = (container, root) => new Promise((resolve) => {
    container.innerHTML = "";
    const card = el("div", { class: "hw-pin-setup" }, [
      el("h2", { class: "hw-pin-setup-title" }, ["Set your unlock PIN"]),
      el("p", { class: "hw-pin-setup-sub" }, [
        "6 digits. You'll enter this every time you open Hey-Home. ",
        "If you forget it, your recovery key is the fallback.",
      ]),
    ]);
    const pinDots = el("div", { class: "hw-pins" });
    for (let i = 0; i < 6; i++) pinDots.appendChild(el("div", { class: "hw-pin" }));
    const hint = el("div", { class: "hw-hint" }, ["Enter a new 6-digit PIN"]);
    const hiddenPin = el("input", {
      type: "text", inputmode: "numeric", autocomplete: "off", maxlength: "6",
      style: "position:absolute; opacity:0; pointer-events:none; width:1px; height:1px;",
    });
    card.appendChild(pinDots);
    card.appendChild(hint);
    card.appendChild(hiddenPin);
    container.appendChild(card);
    container.style.display = "flex";
    // Glow flare so the appearance of the PIN card reads as "next slide"
    // rather than a sudden in-place swap.
    flareGlows(root, 700);
    replayStepEnter(container);

    setTimeout(() => hiddenPin.focus(), 100);
    pinDots.addEventListener("click", () => hiddenPin.focus());

    const dots = pinDots.querySelectorAll(".hw-pin");
    const updateDots = () => {
      const len = hiddenPin.value.length;
      dots.forEach((d, i) => {
        if (i < len) d.classList.add("lit"); else d.classList.remove("lit");
      });
    };
    let stage = "set";
    let firstPin = "";
    hiddenPin.addEventListener("input", () => {
      hiddenPin.value = hiddenPin.value.replace(/\D/g, "").slice(0, 6);
      updateDots();
      if (hiddenPin.value.length !== 6) return;
      if (stage === "set") {
        firstPin = hiddenPin.value;
        hiddenPin.value = "";
        updateDots();
        stage = "confirm";
        hint.textContent = "Confirm the PIN";
        flareGlows(root, 500);
        return;
      }
      if (hiddenPin.value !== firstPin) {
        hint.textContent = "PINs don't match — try again";
        pinDots.classList.add("hw-pin-wrong");
        setTimeout(() => pinDots.classList.remove("hw-pin-wrong"), 480);
        firstPin = "";
        hiddenPin.value = "";
        updateDots();
        stage = "set";
        return;
      }
      hint.textContent = "Saving…";
      flareGlows(root, 800);
      resolve(firstPin);
    });
  });

  // Wire up the recovery-key-only path
  continueBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim().slice(0, 30);
    if (!name) { nameInput.focus(); return; }
    continueBtn.disabled = true;
    continueBtn.textContent = "Generating…";
    try {
      await proceedToKeyCard({ name });
    } catch (err) {
      console.error("[hey-home] identity generation failed", err);
      continueBtn.disabled = false;
      continueBtn.textContent = "Generate my identity";
    }
  });

  return { root };
};

const renderKeyCard = (container, profile, recoveryKey, root) => {
  container.innerHTML = "";

  const hasPasskey = (profile.passkeys || []).length > 0;

  const card = el("div", { class: "hw-key-card" }, [
    el("h2", {}, [
      "Welcome, ",
      el("span", { style: "color: var(--accent);" }, [profile.name]),
      " ✨",
    ]),
    el("p", { class: "hw-key-sub" }, [
      hasPasskey
        ? "Your passkey is bound to this node. Save the recovery key too — it's your only fallback if the authenticator is lost."
        : "This identity lives on this Elastos node. Your recovery key is the only way to sign in elsewhere — it's shown only once, right now.",
    ]),

    hasPasskey ? el("div", { class: "hw-passkey-badge" }, [
      svg({ viewBox: "0 0 24 24", fill: "currentColor",
        style: "width:14px;height:14px;" },
        '<path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Z"/>'),
      el("span", {}, ["Passkey enrolled"]),
    ]) : null,

    el("div", { class: "hw-key-label" }, ["Your recovery key — keep this private"]),
    el("div", { class: "hw-key-value" }, [recoveryKey]),

    el("div", { class: "hw-key-label" }, ["Your public identity — share this freely"]),
    el("div", { class: "hw-key-value accent" }, [profile.didKey]),

    el("div", { class: "hw-key-warn" }, [
      svg({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        "stroke-width": "1.75", "stroke-linecap": "round",
        style: "width:14px;height:14px;flex-shrink:0;" },
        '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="10"/>'),
      el("span", {}, [
        hasPasskey
          ? "Lose both the passkey and the recovery key, and this account is gone. There is no recovery server."
          : "If you lose the recovery key, this account is gone. There is no recovery server.",
      ]),
    ]),

    el("label", { class: "hw-key-check" }, [
      el("input", { type: "checkbox", id: "hw-saved" }),
      el("span", {}, ["I've saved my recovery key somewhere safe"]),
    ]),
  ]);

  const finishBtn = el("button", {
    class: "hw-btn primary", type: "button", disabled: "true",
    style: "margin-top:18px;width:100%;justify-content:center;",
  }, [
    "Take me into Hey-Home",
    svg({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
      style: "width:14px;height:14px;" },
      '<path d="M5 12h14M13 5l7 7-7 7"/>'),
  ]);
  card.appendChild(finishBtn);
  container.appendChild(card);

  const savedCheck = card.querySelector("#hw-saved");
  savedCheck.addEventListener("change", () => {
    if (savedCheck.checked) finishBtn.removeAttribute("disabled");
    else finishBtn.setAttribute("disabled", "true");
  });

  finishBtn.addEventListener("click", async () => {
    finishBtn.disabled = true;
    // Server-side first-run setup (Approach A step 5c). Submits the
    // new profile via /api/auth/setup, which refuses if a shared
    // identity already exists on the node (race-condition guard) and
    // graduates the calling session to Authenticated on success.
    // When the auth gate is off (today's default) the call is
    // effectively redundant with the saveProfile below — but it's
    // load-bearing once 5d flips the env var, and harmless before.
    await serverSetup(profile, profile.passkeys || []);
    await saveProfile(profile);
    // At signup with PRF, vault was initialized + masterKey is already in
    // memory, so enforceVaultGate returns true. With a non-PRF passkey
    // or no passkey, no vault exists and the gate is a no-op.
    if (!(await enforceVaultGate())) {
      finishBtn.disabled = false;
      return;
    }
    const greeting = buildGreeting(profile.name);
    document.body.appendChild(greeting);
    handOffToDesktop(root, greeting);
  });
};

// ── Mount ─────────────────────────────────────────────────────────
const mountWelcome = async () => {
  // body[data-locked="loading"] is set in HTML so the desktop chrome
  // is invisible before this script runs (no FOUC). Once we know
  // which welcome to show, flip to "true" (chrome stays hidden but
  // the loading spinner is dismissed by the CSS).

  // Boot tasks. announceShell is fire-and-forget (best-effort). But
  // acquireBootCapabilities is AWAITED — loadProfile reads runtime
  // storage and needs the capability tokens cached first, otherwise
  // it 401s on every read and falls through to the empty-IDB → setup
  // wizard path. Previously this raced and bricked persistence on
  // fresh browsers / post-runtime-restart sessions.
  if (runtimeAvailable()) {
    announceShell();
    try {
      await window.heyRuntime.acquireBootCapabilities?.();
    } catch (err) {
      console.warn("[hey-home] acquireBootCapabilities failed", err);
    }
  }

  const profile = await loadProfile();
  document.body.setAttribute("data-locked", "true");
  if (profile && profile.name && profile.didKey) {
    const { root, greeting, clockHandle } = buildWelcome(profile);
    document.body.appendChild(root);
    document.body.appendChild(greeting);
    tickClock(clockHandle.hh, clockHandle.mm);
    setDate(clockHandle.date);
    // Store the interval handle on the root so handOffToDesktop can clear
    // it before removing the welcome (otherwise it leaks).
    root.__heyHomeClockInterval = setInterval(
      () => tickClock(clockHandle.hh, clockHandle.mm),
      1000
    );
  } else {
    const { root } = buildSetup();
    document.body.appendChild(root);
    setTimeout(() => {
      const input = document.getElementById("hw-name");
      if (input) input.focus();
    }, 700);
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { mountWelcome(); }, { once: true });
} else {
  mountWelcome();
}
