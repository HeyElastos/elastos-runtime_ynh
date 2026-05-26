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
const LOCAL_CACHE_KEY = "hey-home-profile";

const runtimeAvailable = () =>
  typeof window !== "undefined" && !!window.heyRuntime;

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

// loadProfile precedence:
//   1. shared Identity path (canonical, what Hey Social writes)
//   2. legacy HeyHome path  (migrate up + delete the legacy file)
//   3. localStorage cache   (only when runtime is unreachable)
const loadProfile = async () => {
  const shared = await runtimeGet(SHARED_IDENTITY_PATH);
  if (shared.ok && shared.value) {
    localPut(shared.value);
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
        return migrated;
      }
    }
    // No legacy either — fall through to localStorage as last resort.
    const cached = localGet();
    if (cached) {
      console.info("[hey-home] migrating localStorage profile → shared Identity");
      const migrated = legacyToShared(cached);
      await runtimePut(SHARED_IDENTITY_PATH, migrated);
      return migrated;
    }
    return null;
  }
  // Runtime unreachable — design-preview mode. Use localStorage so the
  // welcome screen still works when index.html is opened directly.
  console.warn("[hey-home] runtime localhost-provider unreachable; using localStorage", shared);
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
  const r = await runtimePut(SHARED_IDENTITY_PATH, profile);
  if (!r.ok) {
    console.warn("[hey-home] runtime profile save failed; localStorage only", r);
  }
};

const clearProfile = async () => {
  localDelete();
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
// real keypair generation in secure hardware; we just record the
// credential ID + transports for later assertions.
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
        userVerification: "preferred",
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
  const transports =
    response.getTransports ? response.getTransports() : [];

  return {
    id: b64uEncode(new Uint8Array(cred.rawId)),
    publicKey: publicKeyB64u,
    userHandle: b64uEncode(userHandle),
    transports,
    createdAt: new Date().toISOString(),
  };
};

// Assert a passkey against the credentials stored in the profile.
// Returns the assertion on success; throws if the user cancels or no
// authenticator matches.
const assertPasskey = async (profile) => {
  const allowCredentials = (profile.passkeys || []).map((pk) => ({
    id: b64uDecode(pk.id),
    type: "public-key",
    transports: pk.transports || [],
  }));
  if (allowCredentials.length === 0) {
    throw new Error("No passkey enrolled on this profile");
  }
  const challenge = randomBytes(32);

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: window.location.hostname,
      timeout: 60_000,
      userVerification: "preferred",
      allowCredentials,
    },
  });

  if (!assertion) throw new Error("Passkey authentication cancelled");
  // We trust the OS authenticator's UV gesture. A future hardening
  // pass should COSE-decode pk.publicKey and verify the assertion
  // signature locally before considering the unlock successful.
  return assertion;
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

  // PIN dots
  const pins = el("div", { class: "hw-pins" });
  for (let i = 0; i < 6; i++) pins.appendChild(el("div", { class: "hw-pin" }));
  const hint = el("div", { class: "hw-hint" }, [
    hasPasskey ? "Tap your passkey or enter recovery PIN" : "Enter recovery PIN",
  ]);

  const passkeyBtnLabel = el("span", {}, ["Use passkey"]);
  const passkeyBtn = hasPasskey ? el("button", { class: "hw-btn", type: "button" }, [
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
  const buttons = el("div", { class: "hw-buttons" }, [passkeyBtn, unlockBtn]);
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
  const hasPin = !!readPinFields(profile).pinHash;
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

  const tryUnlock = async () => {
    if (!hasPin) {
      // Migration path: profile predates the PIN gate; force PIN setup
      // before letting them in.
      promptPinSetup();
      return;
    }
    if (hiddenPin.value.length !== 6) {
      hint.textContent = "Enter all 6 digits";
      return;
    }
    unlockBtn.disabled = true;
    const ok = await verifyPin(hiddenPin.value, profile);
    if (ok) {
      hint.textContent = "Welcome back…";
      successFlash(() => handOffToDesktop(root, greeting));
    } else {
      unlockBtn.disabled = false;
      hint.textContent = "Wrong PIN";
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
        await assertPasskey(profile);
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
        const credential = await enrollPasskey(name);
        await proceedToKeyCard({ name, passkey: credential });
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

  // Build the profile (with passkey if chosen), prompt PIN setup, then
  // show the recovery-key card. PIN gates every future unlock.
  //
  // The raw recoveryKey is held in a local variable, shown ONCE on the
  // key card, and never written to storage. Only its SHA-256 hash
  // (recoveryKeyHash) plus the derived Ed25519 public key (pubKeyHex)
  // are persisted — same shape Hey Social writes via writeSharedIdentity.
  const proceedToKeyCard = async ({ name, passkey }) => {
    const ident = window.heyIdentity;
    if (!ident) throw new Error("hey-identity.js not loaded");
    const recoveryKey = ident.generateRecoveryKey();
    const { didKey, pubKeyHex } = await ident.expandKeypair(recoveryKey);
    const recoveryKeyHash = await ident.hashAuthKey(recoveryKey);
    // Inline PIN-setup overlay BEFORE the key card. Two-stage: enter, confirm.
    const pinSalt = generatePinSalt();
    const pin = await collectNewPin(step1);
    const pinHash = await hashPin(pin, pinSalt);
    const profile = writePinFields({
      name,
      didKey,
      pubKeyHex,
      recoveryKeyHash,
      passkeys: passkey ? [passkey] : [],
      createdAt: new Date().toISOString(),
      createdBy: "hey-home",
    }, { pinSalt, pinHash });
    step1.classList.add("hw-step-exit");
    await new Promise((r) => setTimeout(r, 320));
    step1.style.display = "none";
    renderKeyCard(step2, profile, recoveryKey, root);
    step2.style.display = "flex";
  };

  // Replace step1 contents with a PIN-setup card; resolve when the user
  // has entered the same 6 digits twice.
  const collectNewPin = (container) => new Promise((resolve) => {
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
    await saveProfile(profile);
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

  // Boot tasks — all fire-and-forget so they can run in parallel with
  // the profile load. None of them block the UI.
  if (runtimeAvailable()) {
    announceShell();                                 // marks us as the active shell for Hey
    window.heyRuntime.acquireBootCapabilities?.();   // grants tokens for future calls
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
