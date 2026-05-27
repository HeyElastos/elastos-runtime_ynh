import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { signUp } from "../api/auth";
import { passkeySignup, passkeySupported } from "../api/passkey";
import { setProfile } from "../hooks/useProfile";
import { copyToClipboard } from "../utils/clipboard";
import { readSharedIdentity, writeSharedIdentity } from "../lib/shell";
import { setSession } from "../lib/session";
import { expandKeypair, hashAuthKey, bytesToHex, sign, ELASTOS_IDENTITY_PRF_INPUT } from "../lib/identity";
import { storage } from "../lib/runtime";

// ── Unified-identity adoption (Approach A step 5f) ──────────────────
//
// When a user signed up via the home shell's welcome screen (passkey
// path), the shared identity at .AppData/Identity/profile.json
// already holds their didKey + passkey credentials. Hey Social
// shouldn't ask them to sign up again — it should adopt that
// identity in one tap. This block does the WebAuthn assertion, calls
// /api/auth/unlock to graduate the runtime session, then synthesizes
// Hey's local profile from the shared identity record. No Hey-side
// passkey-challenge.json write needed (which would 403 in PreAuth).

const apiBase = () => {
  if (typeof window === "undefined") return "";
  const m = window.location.pathname.match(/^(.*?)\/apps\/[^/]+\//);
  return m ? m[1] : "";
};

const authedFetch = (path, init = {}) => {
  const bearer =
    typeof window !== "undefined"
      ? window.sessionStorage.getItem("hey-runtime-token")
      : null;
  return fetch(apiBase() + path, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  });
};

const b64uDecode = (b64u) => {
  const pad = (4 - (b64u.length % 4)) % 4;
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// Core adoption helper. Given a 32-byte signing seed (hex) that
// derives the SAME did:key as the shared identity, prove possession
// to the server via /api/auth/unlock + set up Hey's local session
// + write the local profile from the shared record. Returns the
// profile shape useProfile() expects.
//
// Two call paths use this:
//   - passkey path: seed = identityPrf hex (from a WebAuthn assertion)
//   - recovery-key path: seed = the 64-char hex the user saved at
//     welcome signup. Both must derive the same did:key as the
//     stored shared identity, else the client-side check below
//     refuses to even attempt the server round-trip.
const adoptSharedIdentityWithAuthKey = async (shared, authKey) => {
  if (!shared?.didKey) throw new Error("No shared identity to adopt");
  if (!authKey || !/^[0-9a-f]{64}$/i.test(authKey)) {
    throw new Error("Auth key must be a 64-character hex string");
  }

  // Client-side check: does this seed derive the same did:key the
  // shared identity claims? If not, the user typed the wrong recovery
  // key (or the passkey assertion came from a different credential).
  // Catching here means no wasted server round-trip + clearer error.
  const { seed, didKey } = expandKeypair(authKey);
  if (didKey !== shared.didKey) {
    throw new Error(
      "This key doesn't match the identity on this node. Make sure you're entering the recovery key shown at signup."
    );
  }

  // Server-issued challenge → sign with the derived key → POST to
  // /api/auth/unlock. Server verifies the signature against the
  // stored didKey's pubkey and graduates the session, setting the
  // unlock-claim cookie for cross-capsule propagation.
  const challResp = await authedFetch("/api/auth/unlock/challenge", { method: "POST" });
  if (!challResp.ok) throw new Error(`unlock challenge HTTP ${challResp.status}`);
  const { challenge_id, challenge_hex } = await challResp.json();
  if (!challenge_id || !challenge_hex) throw new Error("unlock challenge response invalid");
  const challengeBytes = new Uint8Array(
    challenge_hex.match(/.{2}/g).map((h) => parseInt(h, 16))
  );
  const signatureHex = sign(challengeBytes, seed);
  const unlockResp = await authedFetch("/api/auth/unlock", {
    method: "POST",
    body: JSON.stringify({ method: "passkey", challenge_id, signature_hex: signatureHex }),
  });
  if (!unlockResp.ok) {
    throw new Error(`unlock denied (HTTP ${unlockResp.status})`);
  }

  // Session is Authenticated. Stand up Hey's session keypair + local
  // profile so the app can sign events + write storage as the same DID.
  await setSession(authKey);
  const authKeyHash = await hashAuthKey(authKey);
  const user = {
    id: crypto.randomUUID(),
    name: shared.name || "Hey user",
    authKeyHash,
    didKey,
    role: "general",
    avatar: shared.avatar || "",
    bio: shared.bio || "",
    followers: [], following: [],
    pendingFollowers: [], pendingFollowing: [],
    createdAt: shared.createdAt || new Date().toISOString(),
  };
  await storage.writeJson("profile.json", user).catch((err) =>
    console.warn("[hey] adopt: profile write failed", err)
  );
  return {
    user: {
      id: user.id,
      name: user.name,
      bio: user.bio,
      avatar: user.avatar,
      role: user.role,
      didKey,
      counts: { followers: 0, following: 0 },
    },
    authKey,
    accessToken: "capsule-session",
    refreshToken: "capsule-session",
    accessTokenUpdatedAt: new Date().toISOString(),
  };
};

// Passkey path: WebAuthn assertion → identityPrf → adopt.
const adoptSharedIdentityViaPasskey = async (shared) => {
  const allowCreds = (shared.passkeys || [])
    .map((pk) => {
      try {
        return { id: b64uDecode(pk.id), type: "public-key", transports: pk.transports || [] };
      } catch { return null; }
    })
    .filter(Boolean);
  if (allowCreds.length === 0) {
    throw new Error("Shared identity has no passkey credentials to assert");
  }
  // The assertion needs a challenge but the actual challenge bytes
  // are discarded — we re-do the server-issued challenge dance inside
  // adoptSharedIdentityWithAuthKey, since that's the one /api/auth/
  // unlock verifies. This local challenge just satisfies the
  // WebAuthn ceremony's challenge-required argument.
  const localChallenge = new Uint8Array(32);
  crypto.getRandomValues(localChallenge);
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: localChallenge,
      rpId: window.location.hostname,
      timeout: 60_000,
      userVerification: "required",
      allowCredentials: allowCreds,
      extensions: { prf: { eval: { first: ELASTOS_IDENTITY_PRF_INPUT } } },
    },
  });
  if (!assertion) throw new Error("Passkey assertion cancelled");
  const prfRaw = assertion.getClientExtensionResults?.()?.prf?.results?.first;
  const identityPrf = prfRaw ? new Uint8Array(prfRaw) : null;
  if (!identityPrf || identityPrf.length !== 32) {
    throw new Error("Passkey didn't return PRF output — can't derive identity");
  }
  return adoptSharedIdentityWithAuthKey(shared, bytesToHex(identityPrf));
};

// Recovery-key path: user types the 64-char hex shown at welcome signup.
const adoptSharedIdentityViaRecoveryKey = async (shared, recoveryHex) => {
  const cleaned = (recoveryHex || "").trim().toLowerCase();
  if (!cleaned) throw new Error("Enter your recovery key first");
  return adoptSharedIdentityWithAuthKey(shared, cleaned);
};

export const FloatingScene = () => (
  <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
    {/* Soft gradient glow blobs — closest-side keeps the colored area well inside
        the box, so the box edge stays fully transparent and nothing visible
        gets clipped by the parent's overflow-hidden. */}
    <div
      className="float-shape glow"
      style={{
        top: "6%",
        left: "8%",
        width: "420px",
        height: "420px",
        background:
          "radial-gradient(circle closest-side at center, rgba(212,184,75,0.75) 0%, rgba(212,184,75,0.30) 40%, transparent 75%)",
        filter: "blur(80px)",
      }}
    />
    <div
      className="float-shape glow"
      style={{
        bottom: "8%",
        right: "8%",
        width: "520px",
        height: "520px",
        background:
          "radial-gradient(circle closest-side at center, rgba(96,165,250,0.60) 0%, rgba(96,165,250,0.22) 40%, transparent 75%)",
        filter: "blur(90px)",
        animationDelay: "1.5s",
      }}
    />
    <div
      className="float-shape glow"
      style={{
        top: "38%",
        right: "26%",
        width: "320px",
        height: "320px",
        background:
          "radial-gradient(circle closest-side at center, rgba(244,114,182,0.50) 0%, rgba(244,114,182,0.18) 40%, transparent 75%)",
        filter: "blur(70px)",
        animationDelay: "3s",
      }}
    />

    {/* Outline circle */}
    <svg
      className="float-shape shape-a text-amber-700/40 dark:text-accent/60"
      style={{ top: "14%", right: "16%", width: 80, height: 80 }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <circle cx="12" cy="12" r="10" />
    </svg>

    {/* Triangle */}
    <svg
      className="float-shape shape-b text-sky-700/45 dark:text-sky-300/70"
      style={{ top: "22%", left: "18%", width: 70, height: 70 }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
    >
      <path d="M12 3 21 20H3z" />
    </svg>

    {/* Plus */}
    <svg
      className="float-shape shape-c text-pink-600/50 dark:text-pink-300/70"
      style={{ bottom: "26%", left: "12%", width: 56, height: 56 }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>

    {/* Sparkle / sun above the "y" in Hey */}
    <svg
      className="float-shape shape-d text-amber-600/70 dark:text-amber-200/80"
      style={{ top: "20%", left: "58%", width: 64, height: 64 }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
    >
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.5 5.5l2.8 2.8M15.7 15.7l2.8 2.8M5.5 18.5l2.8-2.8M15.7 8.3l2.8-2.8" />
    </svg>

    {/* Square outline */}
    <div
      className="float-shape shape-c"
      style={{ top: "62%", right: "8%", width: 60, height: 60, animationDelay: "0.7s" }}
    >
      <svg
        className="square-tick text-emerald-700/40 dark:text-emerald-300/60"
        style={{ width: "100%", height: "100%" }}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      >
        <rect x="3" y="3" width="18" height="18" rx="3" />
      </svg>
    </div>

    {/* Wavy line */}
    <svg
      className="float-shape shape-d text-pink-500/45 dark:text-pink-200/60"
      style={{ top: "70%", left: "22%", width: 100, height: 30, animationDelay: "2.5s" }}
      viewBox="0 0 100 30"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M2 15 Q15 2, 28 15 T54 15 T80 15 T98 15">
        <animate
          attributeName="d"
          values="
            M2 15 Q15 2, 28 15 T54 15 T80 15 T98 15;
            M2 15 Q15 28, 28 15 T54 15 T80 15 T98 15;
            M2 15 Q15 2, 28 15 T54 15 T80 15 T98 15
          "
          dur="6s"
          repeatCount="indefinite"
          calcMode="spline"
          keyTimes="0; 0.5; 1"
          keySplines="0.42 0 0.58 1; 0.42 0 0.58 1"
        />
      </path>
    </svg>
  </div>
);

export const HeyMark = () => (
  <div className="relative inline-block pb-8">
    <svg
      className="hey-underline absolute left-1/2 -translate-x-1/2 -z-10"
      style={{ bottom: "22%", width: "88%", opacity: 0.85 }}
      viewBox="0 0 240 30"
      fill="none"
      stroke="currentColor"
      strokeWidth="5"
      strokeLinecap="round"
    >
      <path d="M8 18 Q60 4, 120 14 T232 12" className="text-accent" />
    </svg>

    <svg
      viewBox="0 0 480 280"
      className="hey-wordmark relative block mx-auto w-[280px] sm:w-[420px]"
      aria-label="Hey"
    >
      <defs>
        {[
          { ch: "H", x: 110 },
          { ch: "e", x: 230 },
          { ch: "y", x: 320 },
        ].map(({ ch, x }, i) => (
          <mask id={`hey-mask-${i}`} key={ch}>
            <text
              x={x}
              y={200}
              className="hey-pencil"
              style={{
                fontFamily: "'Dancing Script', cursive",
                fontWeight: 600,
                fontSize: "200px",
                animationDelay: `${i * 0.9}s`,
              }}
            >
              {ch}
            </text>
          </mask>
        ))}
      </defs>

      {[
        { ch: "H", x: 110 },
        { ch: "e", x: 230 },
        { ch: "y", x: 320 },
      ].map(({ ch, x }, i) => (
        <text
          key={ch}
          x={x}
          y={200}
          className="hey-fill"
          mask={`url(#hey-mask-${i})`}
          style={{
            fontFamily: "'Dancing Script', cursive",
            fontWeight: 600,
            fontSize: "200px",
          }}
        >
          {ch}
        </text>
      ))}
    </svg>
  </div>
);

const ArrowCue = () => (
  <div className="absolute -top-5 right-0 hidden sm:block">
    <span className="caret-cue inline-block rounded-full bg-accent px-3 py-1 text-xs font-bold uppercase tracking-wider text-accent-text shadow-lg">
      Start here
    </span>
  </div>
);

const Landing = () => {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [generatedKey, setGeneratedKey] = useState(null);
  // Auth profile from signup, held locally until the user clicks "Continue".
  // If we wrote it to localStorage immediately, Home would react to the auth
  // change and unmount us mid-flow before the user could save the key.
  const [pendingProfile, setPendingProfile] = useState(null);
  const [copied, setCopied] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const canUsePasskey = passkeySupported();

  // Step 5f: unified-identity adoption. If the user already signed up
  // via the home-shell welcome screen, the shared identity file on the
  // node carries their did:key. Skip Hey's signup wizard and offer
  // one-tap adoption instead — passkey if the user enrolled one,
  // otherwise the recovery-key path for PIN-only welcome signups.
  const [sharedIdentity, setSharedIdentity] = useState(null);
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [recoveryKeyInput, setRecoveryKeyInput] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const shared = await readSharedIdentity().catch(() => null);
      if (cancelled) return;
      if (shared?.didKey) {
        setSharedIdentity(shared);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const sharedHasPasskey = (sharedIdentity?.passkeys || []).length > 0;

  const handleAdoptWithPasskey = async () => {
    setError(null);
    setAdoptBusy(true);
    try {
      const data = await adoptSharedIdentityViaPasskey(sharedIdentity);
      const profile = {
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      };
      setProfile(profile);
      navigate("/");
    } catch (err) {
      console.error("[hey] adopt-passkey failed", err);
      setError(err.message || "Couldn't sign in with your existing passkey.");
    } finally {
      setAdoptBusy(false);
    }
  };

  const handleAdoptWithRecoveryKey = async (event) => {
    if (event?.preventDefault) event.preventDefault();
    setError(null);
    setAdoptBusy(true);
    try {
      const data = await adoptSharedIdentityViaRecoveryKey(
        sharedIdentity,
        recoveryKeyInput
      );
      const profile = {
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      };
      setProfile(profile);
      navigate("/");
    } catch (err) {
      console.error("[hey] adopt-recovery failed", err);
      setError(err.message || "Couldn't verify your recovery key.");
    } finally {
      setAdoptBusy(false);
    }
  };

  const handlePasskeySignup = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Pick a nickname first.");
      return;
    }
    setPasskeyBusy(true);
    try {
      const data = await passkeySignup(name.trim());
      const profile = {
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      };
      setProfile(profile);
      navigate("/welcome");
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Passkey sign-up failed.");
    } finally {
      setPasskeyBusy(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Pick a nickname to continue.");
      return;
    }

    setLoading(true);
    try {
      const data = await signUp({ name: name.trim() });
      const profile = {
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      };
      setPendingProfile(profile);
      setGeneratedKey(data.authKey);
    } catch (err) {
      setError(err.response?.data?.message || "Could not create account.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!generatedKey) return;
    const ok = await copyToClipboard(generatedKey);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleContinue = () => {
    // Commit auth now that the user has had a chance to save their key.
    if (pendingProfile) setProfile(pendingProfile);
    navigate("/welcome");
  };

  return (
    <div className="relative -mt-10 flex min-h-[80vh] flex-col items-center justify-center px-4 py-10">
      <FloatingScene />

      <div className="relative z-10 mx-auto max-w-2xl text-center">
        <p
          className="mb-6 text-xs uppercase tracking-[0.4em] text-muted animate-fade-in"
          style={{ animationDelay: "0.8s" }}
        >
          Your own social media on Elastos
        </p>

        <HeyMark />

        <p
          className="mx-auto mt-4 max-w-lg text-base leading-7 text-muted animate-fade-up"
          style={{ animationDelay: "1.3s" }}
        >
          Share images, react with any emoji, repost in a tap. No email, no password.
          Just pick a nickname and we'll generate your secret key.
        </p>

        {sharedIdentity && (
          <div
            className="relative mx-auto mt-12 max-w-md animate-fade-up"
            style={{ animationDelay: "1.5s" }}
          >
            <div className="frosted-card flex flex-col gap-3 p-5 text-left">
              <p className="text-xs uppercase tracking-[0.3em] text-muted">
                Welcome back
              </p>
              <p className="text-lg font-semibold text-primary">
                {sharedIdentity.name || "Your Elastos identity is on this node"}
              </p>
              {sharedHasPasskey ? (
                <>
                  <p className="text-xs text-muted leading-5">
                    You signed up with a passkey. Tap to sign in here too —
                    no second account needed.
                  </p>
                  <button
                    type="button"
                    onClick={handleAdoptWithPasskey}
                    disabled={adoptBusy}
                    className="unfrost mt-1 inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-3 text-sm font-semibold text-accent-text shadow-lg transition hover:bg-amber-300 disabled:opacity-50"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                      <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Z" />
                    </svg>
                    {adoptBusy ? "Tap your passkey…" : "Sign in with my passkey"}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted leading-5">
                    Paste the recovery key you saved at signup (the long hex
                    string). Hey Social needs it to sign your posts &mdash;
                    the welcome screen's PIN unlocks the node but doesn't
                    give Hey the signing key.
                  </p>
                  <form
                    onSubmit={handleAdoptWithRecoveryKey}
                    className="flex flex-col gap-2"
                  >
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck="false"
                      value={recoveryKeyInput}
                      onChange={(e) => setRecoveryKeyInput(e.target.value)}
                      disabled={adoptBusy}
                      placeholder="64-character recovery key"
                      className="unfrost rounded-2xl bg-black/20 px-4 py-3 font-mono text-xs text-primary outline-none placeholder:text-muted/60 ring-1 ring-white/10 focus:ring-accent"
                    />
                    <button
                      type="submit"
                      disabled={adoptBusy || !recoveryKeyInput.trim()}
                      className="unfrost inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-3 text-sm font-semibold text-accent-text shadow-lg transition hover:bg-amber-300 disabled:opacity-50"
                    >
                      {adoptBusy ? "Verifying…" : "Sign in"}
                    </button>
                  </form>
                </>
              )}
              {error && (
                <p className="text-xs text-red-400">{error}</p>
              )}
            </div>
          </div>
        )}

        <div
          className={`relative mx-auto mt-16 max-w-md animate-fade-up ${
            sharedIdentity ? "opacity-60" : ""
          }`}
          style={{ animationDelay: "1.6s" }}
        >
          {!sharedIdentity && <ArrowCue />}

          <form
            onSubmit={handleSubmit}
            className="frosted-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-2 sm:p-2"
          >
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={loading}
              maxLength={30}
              placeholder="Pick a nickname"
              autoFocus
              className="unfrost flex-1 rounded-2xl bg-transparent px-4 py-3 text-base text-primary outline-none placeholder:text-muted sm:py-2.5"
            />
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="unfrost group inline-flex items-center justify-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-text shadow-lg shadow-slate-900/20 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50 sm:py-2.5"
            >
              {loading ? (
                "Generating..."
              ) : (
                <>
                  Generate key
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4 fill-none stroke-current stroke-[2] transition-transform duration-200 group-hover:translate-x-1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                </>
              )}
            </button>
          </form>

          {error && (
            <p className="mt-3 animate-fade-in text-sm text-red-400">{error}</p>
          )}

          {canUsePasskey && (
            <button
              type="button"
              onClick={handlePasskeySignup}
              disabled={passkeyBusy || loading || !name.trim()}
              className="unfrost mt-4 inline-flex items-center justify-center gap-2 rounded-full border border-white/20 bg-white/5 px-5 py-2 text-xs font-medium text-primary transition hover:bg-white/10 disabled:opacity-50 animate-fade-in"
              style={{ animationDelay: "1.9s" }}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Z" />
              </svg>
              {passkeyBusy ? "Waiting for passkey..." : "Sign up with a passkey instead"}
            </button>
          )}

          <p
            className="mt-6 text-xs text-muted animate-fade-in"
            style={{ animationDelay: "2s" }}
          >
            Already have a key?{" "}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("open-signin"))}
              className="unfrost text-accent transition hover:underline"
            >
              Sign in
            </button>
          </p>
        </div>
      </div>

      {generatedKey && createPortal(
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-56 animate-fade-in bg-black/35 backdrop-blur-sm">
          <div className="relative h-fit w-full max-w-md space-y-4 rounded-3xl p-6 text-left animate-pop-in backdrop-blur-[80px] bg-white/95 ring-1 ring-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_40px_-10px_rgba(0,0,0,0.45)] dark:bg-neutral-900/95 dark:ring-white/15 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_18px_40px_-10px_rgba(0,0,0,0.65)]">
            <header className="flex items-center gap-2">
              <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              <p className="text-xs uppercase tracking-wider text-emerald-600 dark:text-emerald-300">
                Welcome, {name.trim()}
              </p>
            </header>
            <p className="text-sm text-muted">
              This is your secret key. <strong className="text-primary">Save it now</strong> — it's the only way to sign back in.
            </p>
            <p className="select-all break-all rounded-lg bg-black/10 px-3 py-2 text-center font-mono text-xs text-primary/90 dark:bg-white/5">
              {generatedKey}
            </p>
            <button
              type="button"
              onClick={handleCopy}
              className="unfrost w-full rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text transition hover:bg-amber-300"
            >
              {copied ? "Copied ✓" : "Copy key"}
            </button>

            <div className="relative flex justify-center pt-2">
              <div className="relative inline-block">
                <button
                  type="button"
                  onClick={handleContinue}
                  style={{ backgroundColor: "rgb(34 197 94)" }}
                  className="group inline-flex flex-none items-center justify-center gap-1.5 rounded-full border-2 border-green-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-green-900/30 transition hover:!bg-green-600"
                >
                  Continue
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5 fill-none stroke-current stroke-[2] transition-transform duration-200 group-hover:translate-x-1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                </button>

                {/* Floating comic-style speech bubble above-and-to-the-right of the button */}
                <div className="caret-cue pointer-events-none absolute bottom-full left-full mb-1 -ml-4 whitespace-nowrap">
                  <div className="relative inline-block rounded-2xl border-2 border-slate-900 bg-accent px-3 py-1.5 text-center text-xs font-bold uppercase leading-tight tracking-wider text-accent-text shadow-[3px_3px_0_rgba(15,23,42,1)]">
                    I have
                    <br />
                    saved it!
                    {/* Tail at bottom-left of bubble pointing down-left toward the button */}
                    <svg
                      viewBox="0 0 24 24"
                      className="absolute -bottom-3 left-2 h-4 w-4"
                      aria-hidden="true"
                    >
                      <path
                        d="M4 2 L20 2 L4 22 Z"
                        fill="var(--accent)"
                        stroke="#0f172a"
                        strokeWidth="2"
                        strokeLinejoin="round"
                      />
                      <path d="M4 2 L20 2" stroke="var(--accent)" strokeWidth="2.5" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default Landing;
