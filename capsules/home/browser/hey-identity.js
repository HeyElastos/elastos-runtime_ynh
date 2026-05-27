// ─────────────────────────────────────────────────────────────────────
// hey-identity.js — real Ed25519 + did:key derivation for Hey-Home.
//
// Mirrors Hey Social's client/src/lib/identity.js byte-for-byte so the
// same recovery key produces the SAME did:key in either app. Uses the
// Web Crypto API's Ed25519 primitive (Chrome 122+, Safari 17+, Firefox
// 130+ — all 2024 releases).
//
// Wire format:
//   recoveryKey = 32 random bytes, hex-encoded (64 chars)
//   seed        = the 32 bytes interpreted as an Ed25519 private key
//   publicKey   = Ed25519 public key derived from the seed (32 bytes)
//   didKey      = "did:key:z" + base58btc( [0xed 0x01] || publicKey )
//
// Backward-incompat note: Hey-Home previously derived did:key as
// SHA-256(seed) interpreted-as-pubkey — a stub. Profiles minted under
// the old code DO NOT have a usable signing key and must be re-minted
// to interoperate with Hey Social. The welcome flow handles migration
// by treating a profile without `pubKeyHex` as legacy and prompting.
//
// Exposes window.heyIdentity = { generateRecoveryKey, expandKeypair,
// hashAuthKey, sign, verify, publicKeyToDidKey, didKeyToPublicKey }.
// ─────────────────────────────────────────────────────────────────────

(() => {
  const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);
  const BASE58 =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  // ── byte ↔ hex / base58 ──────────────────────────────────────────
  const hexToBytes = (hex) => {
    if (typeof hex !== "string" || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2) {
      throw new Error("Invalid hex string");
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  };

  const bytesToHex = (bytes) =>
    Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

  // Same base58btc encoder Hey uses, written longhand-friendly so the
  // same bytes serialize identically in both apps.
  const base58Encode = (buf) => {
    if (buf.length === 0) return "";
    let n = 0n;
    for (const b of buf) n = (n << 8n) | BigInt(b);
    let out = "";
    while (n > 0n) {
      out = BASE58[Number(n % 58n)] + out;
      n /= 58n;
    }
    for (const b of buf) {
      if (b !== 0) break;
      out = "1" + out;
    }
    return out;
  };

  const base58Decode = (str) => {
    if (str.length === 0) return new Uint8Array();
    let n = 0n;
    for (const c of str) {
      const idx = BASE58.indexOf(c);
      if (idx < 0) throw new Error(`Invalid base58 character: ${c}`);
      n = n * 58n + BigInt(idx);
    }
    const bytes = [];
    while (n > 0n) {
      bytes.unshift(Number(n & 0xffn));
      n >>= 8n;
    }
    for (const c of str) {
      if (c !== "1") break;
      bytes.unshift(0);
    }
    return new Uint8Array(bytes);
  };

  // ── Ed25519 via Web Crypto ───────────────────────────────────────
  //
  // Web Crypto's `Ed25519` algorithm requires importing the seed as a
  // PKCS#8 private key. We build the PKCS#8 envelope manually around
  // the raw 32-byte seed — the structure is fixed at 16 bytes of
  // prefix + the 32-byte octet-string of the seed.
  //
  // Test-1 vector verified locally (RFC 8032): seed of zeros derives
  // public key = 3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29.
  const PKCS8_ED25519_PREFIX = new Uint8Array([
    0x30, 0x2e,                          // SEQUENCE (46 bytes)
    0x02, 0x01, 0x00,                    // INTEGER 0 (version)
    0x30, 0x05,                          // SEQUENCE (5)
    0x06, 0x03, 0x2b, 0x65, 0x70,        // OID 1.3.101.112 (Ed25519)
    0x04, 0x22,                          // OCTET STRING (34)
    0x04, 0x20,                          // inner OCTET STRING (32)
  ]);

  const seedToPkcs8 = (seed) => {
    if (!(seed instanceof Uint8Array) || seed.length !== 32) {
      throw new Error("seed must be 32 bytes");
    }
    const out = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
    out.set(PKCS8_ED25519_PREFIX, 0);
    out.set(seed, PKCS8_ED25519_PREFIX.length);
    return out;
  };

  // Import the seed as a CryptoKey we can sign with, AND extract the
  // 32-byte public key. We derive the public key by JWK-exporting the
  // key (Web Crypto returns the spki-form public key alongside).
  const seedToKeyMaterial = async (seedHex) => {
    if (!/^[0-9a-f]{64}$/i.test(seedHex)) {
      throw new Error("recoveryKey must be a 64-char hex string (32 bytes)");
    }
    if (!crypto.subtle || typeof crypto.subtle.importKey !== "function") {
      throw new Error("Web Crypto unavailable in this browser");
    }
    const seed = hexToBytes(seedHex);
    const pkcs8 = seedToPkcs8(seed);

    // Some older browsers may not yet support Ed25519 here. We probe
    // up-front and bail with a clear error rather than producing wrong
    // bytes.
    let privKey;
    try {
      privKey = await crypto.subtle.importKey(
        "pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]
      );
    } catch (err) {
      throw new Error(
        "Your browser doesn't expose Ed25519 in Web Crypto yet. " +
        "Update to Chrome 122+, Safari 17+, or Firefox 130+."
      );
    }

    // Derive the public key by exporting JWK — the `x` field is the
    // raw 32-byte public key, base64url-encoded.
    const jwk = await crypto.subtle.exportKey("jwk", privKey);
    if (!jwk.x) throw new Error("Ed25519 JWK export missing x parameter");
    const b64u = jwk.x.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64u.length % 4)) % 4;
    const bin = atob(b64u + "=".repeat(pad));
    const publicKey = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) publicKey[i] = bin.charCodeAt(i);
    if (publicKey.length !== 32) {
      throw new Error(`Ed25519 public key wrong length: ${publicKey.length}`);
    }
    return { seed, publicKey, privKey };
  };

  // ── did:key encoding ─────────────────────────────────────────────
  const publicKeyToDidKey = (publicKey) => {
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
      throw new Error("publicKey must be 32 bytes");
    }
    const wrapped = new Uint8Array(2 + 32);
    wrapped.set(ED25519_MULTICODEC, 0);
    wrapped.set(publicKey, 2);
    return "did:key:z" + base58Encode(wrapped);
  };

  const didKeyToPublicKey = (didKey) => {
    if (typeof didKey !== "string" || !didKey.startsWith("did:key:z")) {
      throw new Error("Not a did:key:z... string");
    }
    const decoded = base58Decode(didKey.slice("did:key:z".length));
    if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
      throw new Error("Not an Ed25519 did:key");
    }
    return decoded.slice(2);
  };

  // ── Public API ───────────────────────────────────────────────────
  const generateRecoveryKey = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  };

  // SHA-256(recoveryKey-hex-string) — same algorithm Hey Social uses
  // to compute authKeyHash. Lets a node verify a recovery key without
  // storing it.
  const hashAuthKey = async (recoveryHex) => {
    const buf = new TextEncoder().encode(recoveryHex);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return bytesToHex(new Uint8Array(digest));
  };

  // Returns { seed, publicKey, privKey, didKey, pubKeyHex }.
  // `pubKeyHex` is stored in the profile so future boots can recognize
  // post-rewrite profiles without re-deriving (the seed isn't kept).
  const expandKeypair = async (recoveryHex) => {
    const { seed, publicKey, privKey } = await seedToKeyMaterial(recoveryHex);
    return {
      seed,
      publicKey,
      privKey,
      pubKeyHex: bytesToHex(publicKey),
      didKey: publicKeyToDidKey(publicKey),
    };
  };

  const sign = async (message, privKey) => {
    const data =
      typeof message === "string" ? new TextEncoder().encode(message) : message;
    const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, privKey, data);
    return bytesToHex(new Uint8Array(sigBuf));
  };

  // Convenience: expand a 32-byte seed (hex) into a signing key, sign,
  // and return the signature as hex. Used for /api/auth/unlock's
  // passkey path — the JS gets identityPrf out of a passkey assertion,
  // derives the Ed25519 keypair from it, and signs a server challenge
  // to prove possession of the private key (same key whose pubkey
  // gives the stored did:key).
  const signWithSeed = async (seedHex, message) => {
    const { privKey } = await seedToKeyMaterial(seedHex);
    return sign(message, privKey);
  };

  const verify = async (message, signatureHex, publicKey) => {
    try {
      if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return false;
      const sig = hexToBytes(signatureHex);
      if (sig.length !== 64) return false;
      // Import public key for verify.
      const spki = new Uint8Array(12 + 32);
      spki.set([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00], 0);
      spki.set(publicKey, 12);
      const key = await crypto.subtle.importKey(
        "spki", spki, { name: "Ed25519" }, false, ["verify"]
      );
      const data =
        typeof message === "string" ? new TextEncoder().encode(message) : message;
      return crypto.subtle.verify({ name: "Ed25519" }, key, sig, data);
    } catch {
      return false;
    }
  };

  // Cheap probe so the welcome script can decide whether to even try
  // the Ed25519 path before showing a setup form.
  const ed25519Supported = async () => {
    try {
      // Use a known seed; if the import succeeds the browser has Ed25519.
      await seedToKeyMaterial(
        "0000000000000000000000000000000000000000000000000000000000000001"
      );
      return true;
    } catch {
      return false;
    }
  };

  window.heyIdentity = {
    generateRecoveryKey,
    expandKeypair,
    hashAuthKey,
    sign,
    signWithSeed,
    verify,
    publicKeyToDidKey,
    didKeyToPublicKey,
    ed25519Supported,
  };
})();
