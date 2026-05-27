import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckIcon, LogoutIcon, UserIcon } from "./icons";
import { useProfile, clearProfile } from "../hooks/useProfile";

// Small avatar palette derived from a stable hash so each user keeps the
// same colors across the app. Mirrors Chat.jsx's paletteFor so the two
// surfaces look consistent.
const AVATAR_PALETTE = [
  ["from-amber-400", "to-pink-400"],
  ["from-indigo-400", "to-cyan-400"],
  ["from-emerald-400", "to-sky-400"],
  ["from-rose-400", "to-orange-400"],
  ["from-violet-400", "to-fuchsia-400"],
  ["from-yellow-400", "to-red-400"],
];

const paletteFor = (key) => {
  if (!key) return AVATAR_PALETTE[0];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
};

const ProfilePopover = ({ open, onClose, anchorRef }) => {
  const profile = useProfile();
  const navigate = useNavigate();
  const popoverRef = useRef(null);
  const [didCopied, setDidCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (
        popoverRef.current?.contains(e.target) ||
        anchorRef?.current?.contains(e.target)
      ) return;
      onClose?.();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !profile?.user) return null;

  const user = profile.user;
  const didKey = user.didKey || "";
  const [from, to] = paletteFor(didKey || user.name);
  const initial = (user.name || "?").charAt(0).toUpperCase();

  const handleCopy = async () => {
    if (!didKey) return;
    try {
      await navigator.clipboard.writeText(didKey);
      setDidCopied(true);
      setTimeout(() => setDidCopied(false), 2000);
    } catch { /* clipboard blocked */ }
  };

  const handleSignOut = () => {
    clearProfile();
    onClose?.();
    navigate("/");
  };

  return (
    <div
      ref={popoverRef}
      className="absolute left-0 top-full z-30 mt-2 w-72 animate-pop-in rounded-2xl border border-black/10 bg-white/95 p-4 shadow-2xl backdrop-blur-xl dark:border-white/15 dark:bg-neutral-900/95"
      style={{ originY: 0 }}
    >
      <div className="flex items-center gap-3">
        {user.avatar ? (
          <img
            src={user.avatar}
            alt={user.name}
            className="h-12 w-12 flex-none rounded-full object-cover"
          />
        ) : (
          <div
            className={`h-12 w-12 grid place-items-center flex-none rounded-full bg-gradient-to-br ${from} ${to} text-lg font-bold text-black/80`}
          >
            {initial}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-primary">{user.name}</div>
          {user.bio && (
            <div className="truncate text-xs text-muted">{user.bio}</div>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-black/5 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted">
            Your did:key
          </span>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!didKey}
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-muted transition hover:bg-black/5 hover:text-primary disabled:opacity-40 dark:hover:bg-white/10"
          >
            {didCopied ? (<><CheckIcon className="h-3 w-3" /> copied</>) : "copy"}
          </button>
        </div>
        {didKey ? (
          <div className="break-all font-mono text-[10px] leading-relaxed text-primary/70">
            {didKey}
          </div>
        ) : (
          <p className="text-[11px] text-muted">
            Sign out and back in to enable your federation identity.
          </p>
        )}
        <p className="mt-2 text-[10px] text-muted">
          Share this freely. Friends use it to start a chat with you.
        </p>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <Link
          to="/profile"
          onClick={onClose}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-primary transition hover:bg-black/5 dark:hover:bg-white/5"
        >
          <UserIcon className="h-4 w-4 text-muted" />
          <span>Open profile</span>
        </Link>
        <button
          type="button"
          onClick={handleSignOut}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-primary transition hover:bg-red-500/10 hover:text-red-500"
        >
          <LogoutIcon className="h-4 w-4 text-muted" />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
};

export default ProfilePopover;
