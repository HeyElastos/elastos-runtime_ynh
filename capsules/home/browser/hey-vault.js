// ─────────────────────────────────────────────────────────────────────
// hey-vault.js — passkey-PRF backed envelope encryption for hey-home.
//
// Threat model this closes:
//   - Attacker with the runtime session cookie can call /api/localhost/*
//     and get back ciphertext envelopes — but can't decrypt without the
//     PRF output, which only the user's passkey can produce.
//   - Root on the YunoHost box can read the wraps file but it's useless
//     without the passkey gesture (or the recovery key).
//   - Lock screen now genuinely means "key wiped from memory" — any
//     vault-stored data is unreadable until the user re-asserts the
//     passkey.
//
// Crypto layout:
//   masterKey  — 256-bit AES-GCM, generated ONCE at vault init, lives
//                in memory only as a non-extractable CryptoKey.
//   wraps file — at /api/localhost/Users/self/.HeyVault/wraps.json:
//     {
//       v: 1,
//       wraps: {
//         prf:      { iv, wrapped }   ← AES-KW with PRF output as key
//         recovery: { iv, wrapped, salt }  ← AES-KW with PBKDF2(recovery)
//       }
//     }
//   Any wrap can unwrap the master key. The master key encrypts vault
//   payloads as AES-GCM envelopes { v, iv, ct }.
//
// Browser support:
//   PRF requires WebAuthn Level 3 — Chrome 119+, Edge 119+, Safari 18+,
//   Firefox 132+. If the authenticator doesn't support PRF, vault setup
//   silently falls back: no vault, no envelope encryption for hey-home.
//   The lock screen still works via PIN/passkey as before.
// ─────────────────────────────────────────────────────────────────────

(() => {
  const VAULT_VERSION = 1;
  // Path is under .AppData/ to match hey-home's existing storage permission
  // namespace (see capsule.json's `permissions.storage`).
  const WRAPS_PATH = "Users/self/.AppData/HeyVault/wraps.json";
  // ── In-memory state (the secret) ─────────────────────────────────
  let masterKey = null; // CryptoKey or null

  // ── Encoding helpers ─────────────────────────────────────────────
  const bytesToHex = (bytes) =>
    Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const hexToBytes = (hex) => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  };
  const b64uDecode = (b64u) => {
    const pad = (4 - (b64u.length % 4)) % 4;
    const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  // ── Storage I/O (runtime localhost-provider) ─────────────────────
  const readJson = (path) => window.heyRuntime?.storage?.readJson(path);
  const writeJson = (path, v) => window.heyRuntime?.storage?.writeJson(path, v);

  // ── WebAuthn PRF: enroll + assert ────────────────────────────────
  //
  // We request a SINGLE PRF eval (`elastos-identity-v1`) for two reasons:
  //   1. Cross-capsule identity — every Elastos capsule asking for that
  //      same input gets the same 32 bytes → same Ed25519 keypair → same
  //      DID. One passkey, one identity across the device.
  //   2. Compatibility — many authenticators (Nitrokey 3, some Yubikeys,
  //      older Windows Hello firmwares) accept a single hmac-secret salt
  //      reliably but reject or stall on dual-eval requests during the
  //      post-UV phase ("OS dialog turns red after PIN entry").
  //
  // The app-specific vault key is then deterministically derived in JS
  // from the identity PRF output via HKDF with a per-app `info` label.
  // Different apps get different vault keys; identity and vault keys
  // stay cryptographically uncorrelated.

  const IDENTITY_PRF_INPUT_BYTES =
    new TextEncoder().encode("elastos-identity-v1");

  // HKDF-derive 32 bytes from the identity PRF using a per-app label.
  const deriveVaultPrfFromIdentity = async (identityPrf, label) => {
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

  // Returns true if PRF is plausibly supported at all.
  const prfPlausible = () =>
    typeof navigator !== "undefined" &&
    !!navigator.credentials &&
    typeof PublicKeyCredential !== "undefined";

  // Enroll a new passkey requesting PRF capability. Returns
  //   { credential, prfOutput, identityPrf, transports }
  // where identityPrf is the raw 32-byte hmac-secret output and prfOutput
  // is the HKDF-derived vault key (kept for API symmetry with callers).
  // Throws Error.name === "PRFNotSupported" if the authenticator can't
  // do PRF at all.
  //
  // `onStatus` is an optional progress callback. It fires with one of:
  //   "creating"     — about to prompt for the create() ceremony (first PIN)
  //   "deriving"     — about to prompt for the assertion-only PRF round
  //                    (second PIN — only happens on hardware keys like
  //                    Nitrokey 3 whose firmware doesn't deliver
  //                    hmac-secret on create. Touch ID / modern Windows
  //                    Hello return PRF on create and skip this.)
  // Callers should update their UI based on the phase so the second
  // prompt doesn't look like a glitch.
  const enrollPasskeyForVault = async ({ name, onStatus }) => {
    if (!prfPlausible()) throw new Error("WebAuthn not available");
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userHandle = crypto.getRandomValues(new Uint8Array(32));

    if (typeof onStatus === "function") onStatus("creating");

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
          // PRF *requires* UV — and we'd want it anyway.
          userVerification: "required",
        },
        extensions: {
          prf: {
            eval: {
              first: IDENTITY_PRF_INPUT_BYTES.buffer,
            },
          },
        },
      },
    });
    if (!cred) throw new Error("Passkey enrollment cancelled");

    const ext = cred.getClientExtensionResults?.() || {};
    const prfRes = ext.prf || {};
    let prfFirst = prfRes.results?.first;

    if (!prfFirst && prfRes.enabled !== true) {
      const err = new Error(
        "Authenticator doesn't support PRF — vault encryption unavailable. " +
        "Try a different authenticator (Yubikey 5.7+, Touch ID on macOS 14+, " +
        "modern Windows Hello, Android 14+ Credential Manager)."
      );
      err.name = "PRFNotSupported";
      throw err;
    }

    if (!prfFirst) {
      // PRF enabled but no result on create — fetch via assertion.
      // This is the "second PIN" path for Nitrokey-class authenticators
      // whose firmware delivers hmac-secret only on subsequent
      // assertions, not on the create() response.
      if (typeof onStatus === "function") onStatus("deriving");
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: window.location.hostname,
          timeout: 60_000,
          userVerification: "required",
          allowCredentials: [{
            id: cred.rawId,
            type: "public-key",
            transports: cred.response.getTransports?.() || [],
          }],
          extensions: {
            prf: { eval: { first: IDENTITY_PRF_INPUT_BYTES.buffer } },
          },
        },
      });
      prfFirst = assertion?.getClientExtensionResults?.()?.prf?.results?.first;
    }

    if (!prfFirst) {
      const err = new Error("PRF output not produced by this authenticator");
      err.name = "PRFNotSupported";
      throw err;
    }

    const identityPrf = new Uint8Array(prfFirst);
    const vaultPrf = await deriveVaultPrfFromIdentity(identityPrf, "hey-home-vault-v1");

    return {
      credential: cred,
      prfOutput: vaultPrf,
      identityPrf,
      transports: cred.response.getTransports?.() || [],
    };
  };

  // Assert an existing passkey, requesting the identity PRF. Returns
  // the 32-byte HKDF-derived vault PRF (kept for API symmetry with
  // existing unlockVaultWithPRF callers).
  const assertPasskeyForVault = async (allowedCredIds) => {
    if (!prfPlausible()) throw new Error("WebAuthn not available");
    const allowCredentials = (allowedCredIds || []).map((id) => ({
      id: typeof id === "string" ? b64uDecode(id) : id,
      type: "public-key",
    }));
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: window.location.hostname,
        timeout: 60_000,
        userVerification: "required",
        allowCredentials,
        extensions: { prf: { eval: { first: IDENTITY_PRF_INPUT_BYTES.buffer } } },
      },
    });
    if (!assertion) throw new Error("Passkey authentication cancelled");
    const prfFirst =
      assertion.getClientExtensionResults?.()?.prf?.results?.first;
    if (!prfFirst) {
      const err = new Error("PRF output not produced by this authenticator");
      err.name = "PRFNotSupported";
      throw err;
    }
    const identityPrf = new Uint8Array(prfFirst);
    return deriveVaultPrfFromIdentity(identityPrf, "hey-home-vault-v1");
  };

  // ── Key wrapping ─────────────────────────────────────────────────

  // Derive a 256-bit AES-KW key from raw secret bytes via HKDF. Suitable
  // for wrapping the random masterKey.
  const deriveWrapKey = async (secretBytes, salt, usage) => {
    const km = await crypto.subtle.importKey(
      "raw", secretBytes, "HKDF", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: salt || new Uint8Array(),
        info: new TextEncoder().encode(usage || "hey-vault-wrap-v1"),
      },
      km,
      { name: "AES-GCM", length: 256 },
      false, // wrapping key non-extractable
      ["encrypt", "decrypt"]
    );
  };

  // Derive a wrap key from a recovery key (hex). PBKDF2 with a per-vault salt.
  const deriveWrapKeyFromRecovery = async (recoveryHex, saltBytes) => {
    const km = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(recoveryHex), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: saltBytes, iterations: 600_000, hash: "SHA-256" },
      km,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  };

  // Wrap the (extractable) masterKey under a wrapKey, return { iv, wrapped }.
  const wrap = async (mkExtractable, wrapKey) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.wrapKey(
      "raw", mkExtractable, wrapKey, { name: "AES-GCM", iv }
    );
    return { iv: bytesToHex(iv), wrapped: bytesToHex(new Uint8Array(wrapped)) };
  };

  // Unwrap a stored wrap into a non-extractable masterKey CryptoKey.
  const unwrap = async (wrapObj, wrapKey) => {
    return crypto.subtle.unwrapKey(
      "raw",
      hexToBytes(wrapObj.wrapped),
      wrapKey,
      { name: "AES-GCM", iv: hexToBytes(wrapObj.iv) },
      { name: "AES-GCM", length: 256 },
      false, // non-extractable once unwrapped
      ["encrypt", "decrypt"]
    );
  };

  // ── Public API ───────────────────────────────────────────────────

  // Set up a fresh vault. Generates a random masterKey and wraps it with
  // both the PRF output AND the recovery key. The wraps file is persisted
  // via the runtime's localhost-provider.
  //
  // Args:
  //   prfOutput: Uint8Array(32) — from a fresh enrollment via enrollPasskeyForVault
  //   recoveryHex: string — the user's recovery key (already shown to them)
  //
  // After this call: masterKey is in memory + wraps file is on disk.
  const initVault = async ({ prfOutput, recoveryHex }) => {
    if (!prfOutput || prfOutput.length !== 32) {
      throw new Error("initVault: prfOutput must be 32 bytes");
    }
    if (!/^[0-9a-f]{64}$/i.test(recoveryHex || "")) {
      throw new Error("initVault: recoveryHex must be a 64-char hex string");
    }

    // 1. Generate an extractable masterKey we can wrap. We import a
    //    non-extractable copy for in-memory use; the extractable one is
    //    only used to produce the wraps and then discarded.
    const masterBytes = crypto.getRandomValues(new Uint8Array(32));
    const masterExtractable = await crypto.subtle.importKey(
      "raw", masterBytes, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
    );
    masterKey = await crypto.subtle.importKey(
      "raw", masterBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
    // Zero our copy of the raw bytes.
    masterBytes.fill(0);

    // 2. Build wraps.
    const prfWrapKey = await deriveWrapKey(prfOutput, undefined, "hey-vault-prf-v1");
    const prfWrap = await wrap(masterExtractable, prfWrapKey);

    const recoverySalt = crypto.getRandomValues(new Uint8Array(16));
    const recoveryWrapKey = await deriveWrapKeyFromRecovery(recoveryHex, recoverySalt);
    const recoveryWrap = await wrap(masterExtractable, recoveryWrapKey);
    recoveryWrap.salt = bytesToHex(recoverySalt);

    // 3. Persist wraps file.
    await writeJson(WRAPS_PATH, {
      v: VAULT_VERSION,
      createdAt: new Date().toISOString(),
      wraps: { prf: prfWrap, recovery: recoveryWrap },
    });
  };

  // Load the wraps file and unlock the vault using the supplied PRF output.
  const unlockVaultWithPRF = async (prfOutput) => {
    const wraps = await readJson(WRAPS_PATH);
    if (!wraps || wraps.v !== VAULT_VERSION) {
      throw new Error("No vault to unlock");
    }
    if (!wraps.wraps?.prf) throw new Error("No PRF wrap on this vault");
    const wrapKey = await deriveWrapKey(prfOutput, undefined, "hey-vault-prf-v1");
    masterKey = await unwrap(wraps.wraps.prf, wrapKey);
  };

  // Cold-fallback: unlock via the recovery key.
  const unlockVaultWithRecovery = async (recoveryHex) => {
    const wraps = await readJson(WRAPS_PATH);
    if (!wraps || wraps.v !== VAULT_VERSION) {
      throw new Error("No vault to unlock");
    }
    if (!wraps.wraps?.recovery) throw new Error("No recovery wrap on this vault");
    const salt = hexToBytes(wraps.wraps.recovery.salt || "");
    if (salt.length !== 16) throw new Error("Recovery wrap missing salt");
    const wrapKey = await deriveWrapKeyFromRecovery(recoveryHex, salt);
    masterKey = await unwrap(wraps.wraps.recovery, wrapKey);
  };

  // Wipe the master key from memory. JS GC reclaims; the CryptoKey
  // handle becomes unreachable. Subsequent encryptJson/decryptJson
  // calls fail until re-unlock.
  const lockVault = () => {
    masterKey = null;
  };

  const isUnlocked = () => masterKey !== null;

  // Has a vault already been initialized? (Wraps file exists.)
  const hasVault = async () => {
    try {
      const wraps = await readJson(WRAPS_PATH);
      return !!(wraps && wraps.v === VAULT_VERSION && wraps.wraps);
    } catch { return false; }
  };

  // Encrypt arbitrary JSON-serializable data with the in-memory master key.
  // Returns an envelope { v, iv, ct } as a plain object.
  const encryptJson = async (value) => {
    if (!masterKey) throw new Error("Vault locked");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(JSON.stringify(value));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, masterKey, pt);
    return {
      v: VAULT_VERSION,
      iv: bytesToHex(iv),
      ct: bytesToHex(new Uint8Array(ct)),
    };
  };

  const decryptJson = async (envelope) => {
    if (!masterKey) throw new Error("Vault locked");
    if (!envelope || envelope.v !== VAULT_VERSION) {
      throw new Error("Not a vault envelope");
    }
    const iv = hexToBytes(envelope.iv);
    const ct = hexToBytes(envelope.ct);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, masterKey, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  };

  // Convenience: write a value to runtime storage, sealed.
  // Reads back as plaintext via readSealed below.
  const writeSealed = async (path, value) => {
    const env = await encryptJson(value);
    return writeJson(path, env);
  };
  const readSealed = async (path) => {
    const env = await readJson(path);
    if (env == null) return null;
    return decryptJson(env);
  };

  // Auto-lock when the tab unloads. JS state goes away anyway but this
  // is defensive.
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => { masterKey = null; });
  }

  window.heyVault = {
    // Setup
    enrollPasskeyForVault,
    assertPasskeyForVault,
    initVault,
    // Lifecycle
    unlockVaultWithPRF,
    unlockVaultWithRecovery,
    lockVault,
    isUnlocked,
    hasVault,
    // Sealed I/O
    encryptJson,
    decryptJson,
    writeSealed,
    readSealed,
  };
})();
