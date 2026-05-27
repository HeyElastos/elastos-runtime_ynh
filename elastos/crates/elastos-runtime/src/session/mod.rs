//! Session management for ElastOS
//!
//! Sessions represent authenticated connections to the runtime, typically from
//! VMs or external clients. Each session has a bearer token that must be
//! included in API requests.
//!
//! Session types:
//! - Shell: The primary UI capsule, can grant/deny capabilities
//! - Capsule: Other capsules that can only request capabilities
mod registry;

pub use registry::SessionRegistry;

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::primitives::time::SecureTimestamp;

/// Unique identifier for a session
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl SessionId {
    /// Create a new random session ID
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    /// Create from a string
    pub fn from_string(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Type of session - determines permissions
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionType {
    /// Shell session - can grant/deny capabilities, view pending requests
    /// The desktop, CLI, or TUI shell
    Shell,

    /// Regular capsule session - can only request capabilities
    Capsule,
}

impl fmt::Display for SessionType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SessionType::Shell => write!(f, "shell"),
            SessionType::Capsule => write!(f, "capsule"),
        }
    }
}

/// Authentication state of a session — the lock screen's server-side
/// counterpart. Today (legacy default) every browser session starts
/// `Authenticated` so any caller gets capability auto-grant. When the
/// auth-gate roll-out lands (ELASTOS_AUTH_GATE=1), new browser sessions
/// will start `PreAuth`, capability auto-grant will refuse them, and
/// `POST /api/auth/unlock` will graduate the session after
/// server-side verification of a passkey assertion or recovery PIN.
///
/// `Setup` is a one-shot bootstrap state used during first-run signup
/// — the runtime accepts identity writes IFF no shared identity file
/// exists yet, then transitions the session straight to Authenticated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    /// No identity proof submitted. Capability auto-grant will refuse
    /// non-public resources once the gate is enabled.
    PreAuth,
    /// First-run signup is in progress (or allowed). Identity writes
    /// are permitted while this state holds and no identity exists.
    Setup,
    /// Identity verified (passkey assertion or recovery PIN matched
    /// stored credentials). Full capability auto-grant per the
    /// session's capsule manifest.
    #[default]
    Authenticated,
}

impl AuthState {
    /// True when the session has proven identity and should receive
    /// capability tokens for manifest-declared resources.
    pub fn is_authenticated(&self) -> bool {
        matches!(self, AuthState::Authenticated)
    }
}

impl fmt::Display for AuthState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthState::PreAuth => write!(f, "pre_auth"),
            AuthState::Setup => write!(f, "setup"),
            AuthState::Authenticated => write!(f, "authenticated"),
        }
    }
}

/// A session represents an authenticated connection to the runtime
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// Unique session identifier
    pub id: SessionId,

    /// Bearer token for this session (UUID)
    /// This is what clients send in Authorization header
    pub token: String,

    /// Associated VM ID (if this session belongs to a VM)
    pub vm_id: Option<String>,

    /// Browser capsule this session belongs to (when session_type is Capsule
    /// and the session was minted on behalf of a launched browser capsule by
    /// the home gateway). Drives manifest-based auto-grant for capability
    /// requests so a capsule can read/write within its declared permissions
    /// without an out-of-band approval flow.
    #[serde(default)]
    pub capsule_id: Option<String>,

    /// Type of session (determines permissions)
    pub session_type: SessionType,

    /// Owner's public key (hex-encoded) - identifies the user's namespace
    /// This is set when the user authenticates with their key
    pub owner: Option<String>,

    /// Authentication state — controls whether capability auto-grant
    /// will mint tokens for this session. See AuthState docs.
    #[serde(default)]
    pub auth_state: AuthState,

    /// When the session was created
    pub created_at: SecureTimestamp,

    /// Last activity timestamp (for cleanup)
    pub last_active: SecureTimestamp,
}

impl Session {
    /// Create a new session
    pub fn new(session_type: SessionType, vm_id: Option<String>) -> Self {
        let now = SecureTimestamp::now();
        Self {
            id: SessionId::new(),
            token: uuid::Uuid::new_v4().to_string(),
            vm_id,
            capsule_id: None,
            session_type,
            owner: None,
            auth_state: AuthState::default(),
            created_at: now,
            last_active: now,
        }
    }

    /// Create a new session with an owner
    pub fn with_owner(session_type: SessionType, vm_id: Option<String>, owner: String) -> Self {
        let now = SecureTimestamp::now();
        Self {
            id: SessionId::new(),
            token: uuid::Uuid::new_v4().to_string(),
            vm_id,
            capsule_id: None,
            session_type,
            owner: Some(owner),
            auth_state: AuthState::default(),
            created_at: now,
            last_active: now,
        }
    }

    /// Set the capsule this session was minted on behalf of.
    pub fn with_capsule_id(mut self, capsule_id: String) -> Self {
        self.capsule_id = Some(capsule_id);
        self
    }

    /// Override the auth_state at construction time (used by browser-
    /// session minting when the auth-gate roll-out is enabled — new
    /// sessions start in PreAuth and must call `/api/auth/unlock`
    /// before capability tokens are auto-granted).
    pub fn with_auth_state(mut self, auth_state: AuthState) -> Self {
        self.auth_state = auth_state;
        self
    }

    /// Set the owner for this session
    pub fn set_owner(&mut self, owner: String) {
        self.owner = Some(owner);
    }

    /// Mark the session as authenticated. Called by /api/auth/unlock
    /// after server-side verification of the passkey assertion or
    /// recovery PIN against the stored credential / hash.
    pub fn set_authenticated(&mut self) {
        self.auth_state = AuthState::Authenticated;
    }

    /// Mark the session as a one-shot setup session. Allowed only when
    /// no shared identity exists yet on the node — see the upcoming
    /// /api/auth/setup endpoint.
    pub fn set_setup(&mut self) {
        self.auth_state = AuthState::Setup;
    }

    /// Create a shell session for a VM
    pub fn new_shell(vm_id: String) -> Self {
        Self::new(SessionType::Shell, Some(vm_id))
    }

    /// Create a capsule session for a VM
    pub fn new_capsule(vm_id: String) -> Self {
        Self::new(SessionType::Capsule, Some(vm_id))
    }

    /// Check if this is a shell session
    pub fn is_shell(&self) -> bool {
        self.session_type == SessionType::Shell
    }

    /// Convenience: server gate that should refuse non-public
    /// resource access when false. Returns true for shell sessions
    /// (always-trusted orchestrator) and any session in Authenticated
    /// or Setup auth_state. Refuses PreAuth.
    pub fn can_access_resources(&self) -> bool {
        if self.is_shell() {
            return true;
        }
        matches!(self.auth_state, AuthState::Authenticated | AuthState::Setup)
    }

    /// Update last activity timestamp
    pub fn touch(&mut self) {
        self.last_active = SecureTimestamp::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_id() {
        let id1 = SessionId::new();
        let id2 = SessionId::new();
        assert_ne!(id1, id2);
        assert!(!id1.as_str().is_empty());
    }

    #[test]
    fn test_session_creation() {
        let session = Session::new_shell("vm-123".to_string());
        assert!(session.is_shell());
        assert_eq!(session.vm_id, Some("vm-123".to_string()));
    }

    #[test]
    fn test_session_touch() {
        let mut session = Session::new_shell("vm-789".to_string());
        let initial = session.last_active;

        std::thread::sleep(std::time::Duration::from_millis(10));
        session.touch();

        assert!(session.last_active.monotonic_seq > initial.monotonic_seq);
    }

    #[test]
    fn test_auth_state_defaults_to_authenticated_for_backward_compat() {
        // Until the auth-gate roll-out flips browser sessions to
        // PreAuth at mint time, every new session must default to
        // Authenticated so capability auto-grant keeps working.
        let s = Session::new(SessionType::Capsule, None);
        assert_eq!(s.auth_state, AuthState::Authenticated);
        assert!(s.can_access_resources());
    }

    #[test]
    fn test_pre_auth_capsule_session_blocked_from_resources() {
        let s = Session::new(SessionType::Capsule, None)
            .with_auth_state(AuthState::PreAuth);
        assert!(!s.can_access_resources());
    }

    #[test]
    fn test_setup_session_can_access_resources() {
        // Setup is the bootstrap state for first-run signup — must be
        // allowed to write the initial identity file.
        let s = Session::new(SessionType::Capsule, None)
            .with_auth_state(AuthState::Setup);
        assert!(s.can_access_resources());
    }

    #[test]
    fn test_shell_session_always_authenticated_regardless_of_state() {
        // Shell sessions are the always-trusted orchestrator — even
        // if something marks one PreAuth, it should still pass the
        // gate. Otherwise the runtime can't bootstrap itself.
        let s = Session::new(SessionType::Shell, None)
            .with_auth_state(AuthState::PreAuth);
        assert!(s.can_access_resources());
    }

    #[test]
    fn test_set_authenticated_graduates_session() {
        let mut s = Session::new(SessionType::Capsule, None)
            .with_auth_state(AuthState::PreAuth);
        assert!(!s.can_access_resources());
        s.set_authenticated();
        assert_eq!(s.auth_state, AuthState::Authenticated);
        assert!(s.can_access_resources());
    }
}
