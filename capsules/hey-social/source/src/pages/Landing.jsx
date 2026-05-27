import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { signUp } from "../api/auth";
import { passkeySignup, passkeySupported } from "../api/passkey";
import { setProfile } from "../hooks/useProfile";
import { copyToClipboard } from "../utils/clipboard";

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

        <div
          className="relative mx-auto mt-16 max-w-md animate-fade-up"
          style={{ animationDelay: "1.6s" }}
        >
          <ArrowCue />

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
