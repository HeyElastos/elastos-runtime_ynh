import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";
import { SafeImage } from "./SafeMedia";

const Avatar = ({ name, avatar }) => {
  const initials = (
    <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-amber-600 text-sm font-bold text-slate-900">
      {(name || "?").slice(0, 2).toUpperCase()}
    </div>
  );
  return (
    <SafeImage
      src={avatar}
      alt=""
      fallback={initials}
      className="h-10 w-10 flex-none rounded-full object-cover ring-1 ring-white/20"
    />
  );
};

const CommentBubble = ({
  user,
  replyToName, // string or null
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  error,
}) => {
  const textareaRef = useRef(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape" && !busy) onCancel?.();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [busy, onCancel]);

  const canSubmit = !busy && value.trim().length > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 animate-fade-in bg-black/30 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel?.();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit?.();
        }}
        role="dialog"
        aria-label={replyToName ? `Reply to ${replyToName}` : "Add a comment"}
        className="relative h-fit w-full max-w-md animate-pop-in"
      >
        {/* Speech-bubble tail pinned to the top-right, pointing up-right.
            Drawn behind the card via z-index so the seam disappears. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 32 32"
          className="absolute -top-3 right-8 z-0 h-6 w-6 drop-shadow-[0_8px_20px_rgba(15,23,42,0.35)]"
        >
          <path
            d="M4 28 L18 4 L28 24 Z"
            className="fill-white/[0.85] dark:fill-neutral-900/90"
          />
        </svg>

        <div
          className="relative z-10 space-y-3 rounded-3xl p-5 backdrop-blur-[80px] bg-white/[0.85] ring-1 ring-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_40px_-10px_rgba(0,0,0,0.45)] dark:bg-neutral-900/90 dark:ring-white/15 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_18px_40px_-10px_rgba(0,0,0,0.65)]"
          style={{ WebkitBackdropFilter: "blur(40px)" }}
        >
          <header className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-primary">
                {replyToName ? `Reply to ${replyToName}` : "Add a comment"}
              </h2>
              <p className="mt-0.5 text-[11px] text-muted">
                Press <kbd className="rounded bg-black/10 px-1 py-0.5 text-[10px] font-mono dark:bg-white/10">Esc</kbd> to cancel · <kbd className="rounded bg-black/10 px-1 py-0.5 text-[10px] font-mono dark:bg-white/10">⌘↩</kbd> to send
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              aria-label="Cancel"
              className="icon-btn-ghost flex-none"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </header>

          <div className="flex items-start gap-3">
            <Avatar name={user?.name} avatar={user?.avatar} />
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onChange?.(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
                  e.preventDefault();
                  onSubmit?.();
                }
              }}
              maxLength={500}
              disabled={busy}
              rows={3}
              placeholder={replyToName ? "Write a reply…" : "Say something…"}
              className="frosted-input w-full text-sm disabled:opacity-50"
            />
          </div>

          {error && (
            <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-[10px] text-muted">
              {value.length}/500
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="unfrost rounded-full border border-black/10 bg-black/5 px-4 py-1.5 text-xs text-primary transition hover:bg-black/10 disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="unfrost rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-accent-text transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Posting…" : replyToName ? "Reply" : "Comment"}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>,
    document.body
  );
};

export default CommentBubble;
