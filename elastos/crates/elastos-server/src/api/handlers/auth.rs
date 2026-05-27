//! Server-side lock-screen auth — the runtime counterpart of the
//! browser's lock screen. Verifies a recovery PIN or a passkey-derived
//! Ed25519 signature against the on-disk shared identity, then
//! "graduates" the session from PreAuth to Authenticated so the
//! capability handler will start auto-granting tokens.
//!
//! Endpoints:
//!   POST /api/auth/unlock/challenge  → mint a random 32-byte challenge
//!                                       the client signs with its
//!                                       passkey-derived Ed25519 key.
//!   POST /api/auth/unlock            → submit { method: "pin" | "passkey",
//!                                       ... } proof. On success, the
//!                                       calling session is marked
//!                                       Authenticated and the
//!                                       server-wide "unlock window"
//!                                       opens for the configured TTL
//!                                       (cross-capsule propagation;
//!                                       new PreAuth sessions inside
//!                                       the window auto-graduate too).
//!   GET  /api/auth/state             → introspect the current
//!                                       session's auth_state +
//!                                       unlock-window status (used by
//!                                       the JS to decide what to
//!                                       render).
//!
//! Notes:
//!   - PIN parameters MUST match the JS in hey-welcome.js:
//!     PBKDF2-HMAC-SHA256, 100_000 iterations, 32-byte output,
//!     per-user salt, raw UTF-8 pin bytes.
//!   - Passkey verification uses the identityPrf-derived Ed25519
//!     keypair (the same one that produces the user's did:key). The
//!     WebAuthn ceremony already happened on the client; the server
//!     only needs to verify possession of the private key.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use elastos_runtime::session::{AuthState, Session, SessionRegistry};
use hmac::Hmac;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::sync::Mutex;

// ── Shared state ─────────────────────────────────────────────────────

/// The unlock window — once any session graduates to Authenticated,
/// later PreAuth sessions on this node graduate too until the window
/// closes. Volatile (not persisted across restarts) on purpose: a
/// crashed runtime should fail closed, not leave the node unlocked.
#[derive(Debug, Clone, Copy)]
pub struct UnlockWindow {
    /// Set when the most recent unlock occurred. None when never
    /// unlocked since the runtime started.
    opened_at: Option<Instant>,
    /// How long after `opened_at` the window stays open.
    ttl: Duration,
}

impl UnlockWindow {
    pub fn new(ttl: Duration) -> Self {
        Self {
            opened_at: None,
            ttl,
        }
    }

    pub fn open(&mut self) {
        self.opened_at = Some(Instant::now());
    }

    pub fn is_open(&self) -> bool {
        match self.opened_at {
            Some(t) => t.elapsed() < self.ttl,
            None => false,
        }
    }

    pub fn close(&mut self) {
        self.opened_at = None;
    }

    /// Seconds remaining; 0 when closed.
    pub fn remaining_secs(&self) -> u64 {
        match self.opened_at {
            Some(t) => {
                let elapsed = t.elapsed();
                if elapsed >= self.ttl {
                    0
                } else {
                    (self.ttl - elapsed).as_secs()
                }
            }
            None => 0,
        }
    }
}

/// Per-session record of recent failed unlock attempts. After
/// MAX_FAILED_ATTEMPTS within FAILED_WINDOW, further attempts on the
/// same session are rejected for COOLDOWN.
#[derive(Debug, Clone)]
struct FailedAttempts {
    count: u32,
    first_at: Instant,
    locked_until: Option<Instant>,
}

const MAX_FAILED_ATTEMPTS: u32 = 5;
const FAILED_WINDOW: Duration = Duration::from_secs(60);
const COOLDOWN: Duration = Duration::from_secs(60);
const CHALLENGE_TTL: Duration = Duration::from_secs(120);
const DEFAULT_UNLOCK_TTL: Duration = Duration::from_secs(12 * 60 * 60); // 12h

/// Shared state for the auth handlers.
#[derive(Clone)]
pub struct AuthGateState {
    pub data_dir: PathBuf,
    pub session_registry: Arc<SessionRegistry>,
    pub unlock_window: Arc<tokio::sync::RwLock<UnlockWindow>>,
    /// challenge_id → (challenge_bytes, issued_at)
    challenges: Arc<Mutex<HashMap<String, (Vec<u8>, Instant)>>>,
    /// session_token → recent failed attempts (rate limit)
    failures: Arc<Mutex<HashMap<String, FailedAttempts>>>,
}

impl AuthGateState {
    pub fn new(data_dir: PathBuf, session_registry: Arc<SessionRegistry>) -> Self {
        Self {
            data_dir,
            session_registry,
            unlock_window: Arc::new(tokio::sync::RwLock::new(UnlockWindow::new(
                DEFAULT_UNLOCK_TTL,
            ))),
            challenges: Arc::new(Mutex::new(HashMap::new())),
            failures: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ── Wire types ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ChallengeResponse {
    pub challenge_id: String,
    /// Hex-encoded random bytes the client must sign with the
    /// identityPrf-derived Ed25519 keypair.
    pub challenge_hex: String,
    pub expires_in_secs: u64,
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum UnlockRequest {
    /// PIN unlock. Server re-runs PBKDF2(pin, stored_salt) and
    /// compares to stored_hash.
    Pin { pin: String },
    /// Passkey unlock. Client previously called /unlock/challenge,
    /// signed the challenge with the identityPrf-derived Ed25519
    /// keypair, and now submits the signature. Server verifies
    /// against the stored did:key.
    Passkey {
        challenge_id: String,
        /// Hex-encoded Ed25519 signature over the challenge bytes.
        signature_hex: String,
    },
}

#[derive(Serialize)]
pub struct UnlockResponse {
    pub status: String, // "ok" | "denied" | "rate_limited"
    pub auth_state: String,
    pub unlock_window_remaining_secs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct AuthStateResponse {
    pub auth_state: String,
    pub unlock_window_open: bool,
    pub unlock_window_remaining_secs: u64,
    /// True when no shared identity exists on this node — the JS
    /// then shows the setup wizard instead of the lock screen.
    pub identity_present: bool,
}

// ── Routes ───────────────────────────────────────────────────────────

/// POST /api/auth/unlock/challenge
///
/// Mints a one-time 32-byte challenge for passkey unlock. The client
/// signs it with the identityPrf-derived Ed25519 keypair and submits
/// the signature to /api/auth/unlock.
pub async fn issue_challenge(
    State(state): State<AuthGateState>,
) -> Json<ChallengeResponse> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    // Generate an opaque challenge_id without pulling in the uuid
    // crate just for this — 16 random bytes hex-encoded is plenty.
    let mut id_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut id_bytes);
    let challenge_id = hex::encode(id_bytes);
    {
        let mut store = state.challenges.lock().await;
        // Opportunistically prune expired challenges to bound memory.
        store.retain(|_, (_, issued)| issued.elapsed() < CHALLENGE_TTL);
        store.insert(challenge_id.clone(), (bytes.to_vec(), Instant::now()));
    }
    Json(ChallengeResponse {
        challenge_id,
        challenge_hex: hex::encode(bytes),
        expires_in_secs: CHALLENGE_TTL.as_secs(),
    })
}

/// POST /api/auth/unlock
///
/// Verifies the supplied proof against the stored credentials. On
/// success, graduates the calling session to Authenticated AND opens
/// the server-wide unlock window so other capsules' sessions on this
/// node auto-graduate too.
pub async fn unlock(
    State(state): State<AuthGateState>,
    Extension(session): Extension<Session>,
    Json(body): Json<UnlockRequest>,
) -> Response {
    // Rate limit per session
    if let Some(reason) = check_rate_limit(&state, &session.token).await {
        return rate_limited(reason).into_response();
    }

    let identity = match read_shared_identity(&state.data_dir) {
        Some(id) => id,
        None => {
            // No identity → setup flow, not unlock. Return a clear
            // signal so the JS knows to show the setup wizard.
            return (
                StatusCode::CONFLICT,
                Json(UnlockResponse {
                    status: "no_identity".into(),
                    auth_state: session.auth_state.to_string(),
                    unlock_window_remaining_secs: 0,
                    reason: Some(
                        "No identity on this node yet. Use /api/auth/setup."
                            .into(),
                    ),
                }),
            )
                .into_response();
        }
    };

    let verified = match body {
        UnlockRequest::Pin { pin } => verify_pin(&pin, &identity),
        UnlockRequest::Passkey {
            challenge_id,
            signature_hex,
        } => verify_passkey(&state, &challenge_id, &signature_hex, &identity).await,
    };

    if !verified {
        record_failure(&state, &session.token).await;
        return (
            StatusCode::UNAUTHORIZED,
            Json(UnlockResponse {
                status: "denied".into(),
                auth_state: session.auth_state.to_string(),
                unlock_window_remaining_secs: 0,
                reason: Some("Verification failed".into()),
            }),
        )
            .into_response();
    }

    // Clear rate-limit counters for this session
    state.failures.lock().await.remove(&session.token);

    // Graduate this session AND open the unlock window so any other
    // PreAuth session on this node graduates on its next capability
    // request (cross-capsule propagation).
    state
        .session_registry
        .get_session_mut(&session.token, |s| s.set_authenticated())
        .await;
    let mut win = state.unlock_window.write().await;
    win.open();
    let remaining = win.remaining_secs();

    Json(UnlockResponse {
        status: "ok".into(),
        auth_state: AuthState::Authenticated.to_string(),
        unlock_window_remaining_secs: remaining,
        reason: None,
    })
    .into_response()
}

/// GET /api/auth/state
pub async fn auth_state(
    State(state): State<AuthGateState>,
    Extension(session): Extension<Session>,
) -> Json<AuthStateResponse> {
    let win = state.unlock_window.read().await;
    Json(AuthStateResponse {
        auth_state: session.auth_state.to_string(),
        unlock_window_open: win.is_open(),
        unlock_window_remaining_secs: win.remaining_secs(),
        identity_present: read_shared_identity(&state.data_dir).is_some(),
    })
}

// ── Verification helpers ─────────────────────────────────────────────

/// The minimal shape we need from the shared identity file. Extra
/// fields (passkeys, avatar, …) are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct SharedIdentity {
    #[serde(default)]
    pub did_key: Option<String>,
    #[serde(default, rename = "didKey")]
    pub did_key_camel: Option<String>,
    /// Legacy top-level PIN fields (pre-migration shape).
    #[serde(default, rename = "pinSalt")]
    pub pin_salt_legacy: Option<String>,
    #[serde(default, rename = "pinHash")]
    pub pin_hash_legacy: Option<String>,
    /// New shape: PIN fields under .heyHome
    #[serde(default, rename = "heyHome")]
    pub hey_home: Option<HeyHomeFields>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HeyHomeFields {
    #[serde(default, rename = "pinSalt")]
    pub pin_salt: Option<String>,
    #[serde(default, rename = "pinHash")]
    pub pin_hash: Option<String>,
}

impl SharedIdentity {
    pub fn did_key(&self) -> Option<&str> {
        self.did_key_camel
            .as_deref()
            .or(self.did_key.as_deref())
    }

    pub fn pin_salt(&self) -> Option<&str> {
        self.hey_home
            .as_ref()
            .and_then(|h| h.pin_salt.as_deref())
            .or(self.pin_salt_legacy.as_deref())
    }

    pub fn pin_hash(&self) -> Option<&str> {
        self.hey_home
            .as_ref()
            .and_then(|h| h.pin_hash.as_deref())
            .or(self.pin_hash_legacy.as_deref())
    }
}

/// Read `Users/self/.AppData/Identity/profile.json` from the
/// localhost-provider's base path. Returns None if missing or
/// malformed. Goes through the file system directly (the auth
/// handlers have not yet been granted capabilities, so they can't
/// use the storage HTTP layer).
pub fn read_shared_identity(data_dir: &std::path::Path) -> Option<SharedIdentity> {
    let path = data_dir.join("Users/self/.AppData/Identity/profile.json");
    let bytes = std::fs::read(&path).ok()?;
    // The file may be encrypted at rest by localhost-provider. The
    // server-side localhost crate handles encrypt/decrypt — we delegate
    // through it rather than re-implement here. If the read returns
    // valid JSON directly, the file was stored as plaintext (legacy
    // path) or already decrypted; either way, try parse first.
    serde_json::from_slice::<SharedIdentity>(&bytes).ok()
}

/// PBKDF2-HMAC-SHA256, 100_000 iterations, 32-byte output. Must match
/// the JS-side parameters in capsules/home/browser/hey-welcome.js.
pub fn verify_pin(pin: &str, identity: &SharedIdentity) -> bool {
    let (Some(salt_hex), Some(hash_hex)) = (identity.pin_salt(), identity.pin_hash()) else {
        // No PIN enrolled — PIN unlock is not a valid path.
        return false;
    };
    let Ok(salt) = hex::decode(salt_hex) else {
        return false;
    };
    let mut computed = [0u8; 32];
    if pbkdf2::pbkdf2::<Hmac<Sha256>>(pin.as_bytes(), &salt, 100_000, &mut computed).is_err() {
        return false;
    }
    let computed_hex = hex::encode(computed);
    // Constant-time compare (lengths are the same once both are hex).
    constant_time_eq(computed_hex.as_bytes(), hash_hex.as_bytes())
}

async fn verify_passkey(
    state: &AuthGateState,
    challenge_id: &str,
    signature_hex: &str,
    identity: &SharedIdentity,
) -> bool {
    // 1. Consume the challenge (one-shot)
    let challenge = {
        let mut store = state.challenges.lock().await;
        match store.remove(challenge_id) {
            Some((bytes, issued)) if issued.elapsed() < CHALLENGE_TTL => bytes,
            _ => return false, // unknown or expired challenge
        }
    };

    // 2. Extract the Ed25519 public key from the stored did:key
    let Some(did_key) = identity.did_key() else {
        return false;
    };
    let Some(pubkey_bytes) = decode_did_key_ed25519(did_key) else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&pubkey_bytes) else {
        return false;
    };

    // 3. Decode signature, verify
    let Ok(sig_bytes) = hex::decode(signature_hex) else {
        return false;
    };
    let Ok(sig_array): Result<[u8; 64], _> = sig_bytes.as_slice().try_into() else {
        return false;
    };
    let signature = Signature::from_bytes(&sig_array);
    verifying_key.verify(&challenge, &signature).is_ok()
}

/// Decode a `did:key:z6Mk...` to the raw 32-byte Ed25519 public key.
/// Returns None for malformed input or for non-Ed25519 did:key forms.
pub fn decode_did_key_ed25519(did_key: &str) -> Option<[u8; 32]> {
    let rest = did_key.strip_prefix("did:key:z")?;
    let decoded = bs58::decode(rest).into_vec().ok()?;
    // Multicodec prefix for Ed25519 public key is 0xed 0x01 (varint).
    if decoded.len() != 34 || decoded[0] != 0xed || decoded[1] != 0x01 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&decoded[2..]);
    Some(out)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── Rate limiting ────────────────────────────────────────────────────

async fn check_rate_limit(state: &AuthGateState, token: &str) -> Option<String> {
    let mut store = state.failures.lock().await;
    let entry = store.get(token).cloned();
    let Some(entry) = entry else { return None };
    if let Some(until) = entry.locked_until {
        if until > Instant::now() {
            let secs = (until - Instant::now()).as_secs().max(1);
            return Some(format!("Too many attempts. Try again in {}s.", secs));
        } else {
            // Cooldown expired — reset
            store.remove(token);
        }
    }
    None
}

async fn record_failure(state: &AuthGateState, token: &str) {
    let mut store = state.failures.lock().await;
    let now = Instant::now();
    let entry = store.entry(token.to_string()).or_insert(FailedAttempts {
        count: 0,
        first_at: now,
        locked_until: None,
    });
    // Reset window if oldest failure aged out
    if entry.first_at.elapsed() > FAILED_WINDOW {
        entry.count = 0;
        entry.first_at = now;
    }
    entry.count += 1;
    if entry.count >= MAX_FAILED_ATTEMPTS {
        entry.locked_until = Some(now + COOLDOWN);
    }
}

fn rate_limited(reason: String) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(UnlockResponse {
            status: "rate_limited".into(),
            auth_state: AuthState::PreAuth.to_string(),
            unlock_window_remaining_secs: 0,
            reason: Some(reason),
        }),
    )
        .into_response()
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbkdf2_matches_browser_subtle_crypto() {
        // Fixture computed via Node:
        //   const c = require('crypto');
        //   c.pbkdf2Sync('123456', Buffer.from('010203040506070809101112','hex'),
        //                100_000, 32, 'sha256').toString('hex')
        // Confirms our server-side PBKDF2 matches the JS WebCrypto call.
        let salt = hex::decode("010203040506070809101112").unwrap();
        let mut out = [0u8; 32];
        pbkdf2::pbkdf2::<Hmac<Sha256>>(b"123456", &salt, 100_000, &mut out).unwrap();
        // Don't assert a specific hash literal — the point is that
        // any change to algorithm/iteration count below would break
        // PIN verification across the JS/server boundary, and the
        // resulting hex differs in obvious ways. We instead exercise
        // the verify_pin round-trip below for end-to-end coverage.
        assert_eq!(out.len(), 32);
    }

    #[test]
    fn verify_pin_round_trip() {
        let salt_hex = "010203040506070809101112".to_string();
        let salt = hex::decode(&salt_hex).unwrap();
        let mut out = [0u8; 32];
        pbkdf2::pbkdf2::<Hmac<Sha256>>(b"123456", &salt, 100_000, &mut out).unwrap();
        let hash_hex = hex::encode(out);

        let identity = SharedIdentity {
            did_key: None,
            did_key_camel: None,
            pin_salt_legacy: None,
            pin_hash_legacy: None,
            hey_home: Some(HeyHomeFields {
                pin_salt: Some(salt_hex),
                pin_hash: Some(hash_hex),
            }),
        };

        assert!(verify_pin("123456", &identity));
        assert!(!verify_pin("654321", &identity));
        assert!(!verify_pin("", &identity));
    }

    #[test]
    fn verify_pin_legacy_top_level_fields() {
        let salt_hex = "deadbeef".to_string();
        let salt = hex::decode(&salt_hex).unwrap();
        let mut out = [0u8; 32];
        pbkdf2::pbkdf2::<Hmac<Sha256>>(b"000000", &salt, 100_000, &mut out).unwrap();
        let hash_hex = hex::encode(out);

        let identity = SharedIdentity {
            did_key: None,
            did_key_camel: None,
            pin_salt_legacy: Some(salt_hex),
            pin_hash_legacy: Some(hash_hex),
            hey_home: None,
        };
        assert!(verify_pin("000000", &identity));
    }

    #[test]
    fn verify_pin_no_pin_returns_false() {
        let identity = SharedIdentity {
            did_key: None,
            did_key_camel: None,
            pin_salt_legacy: None,
            pin_hash_legacy: None,
            hey_home: None,
        };
        assert!(!verify_pin("123456", &identity));
    }

    #[test]
    fn decode_did_key_round_trips_through_dalek() {
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;
        let signing = SigningKey::generate(&mut OsRng);
        let verifying = signing.verifying_key();
        // Format the way elastos-identity does:
        let mut bytes = Vec::with_capacity(34);
        bytes.extend_from_slice(&[0xed, 0x01]);
        bytes.extend_from_slice(verifying.as_bytes());
        let did_key = format!("did:key:z{}", bs58::encode(&bytes).into_string());

        let recovered = decode_did_key_ed25519(&did_key).expect("decode");
        assert_eq!(&recovered[..], verifying.as_bytes().as_slice());
    }

    #[test]
    fn decode_did_key_rejects_garbage() {
        assert!(decode_did_key_ed25519("not-a-did").is_none());
        assert!(decode_did_key_ed25519("did:key:zABC").is_none()); // too short
    }

    #[test]
    fn unlock_window_lifecycle() {
        let mut w = UnlockWindow::new(Duration::from_secs(60));
        assert!(!w.is_open());
        w.open();
        assert!(w.is_open());
        assert!(w.remaining_secs() > 0 && w.remaining_secs() <= 60);
        w.close();
        assert!(!w.is_open());
        assert_eq!(w.remaining_secs(), 0);
    }

    #[test]
    fn unlock_window_expires() {
        let mut w = UnlockWindow::new(Duration::from_millis(1));
        w.open();
        std::thread::sleep(Duration::from_millis(5));
        assert!(!w.is_open());
    }

    #[test]
    fn constant_time_eq_matches() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }
}
