import { useEffect, useRef, useState } from "react";
import { HeartIcon } from "./icons";

export const DEFAULT_REACTIONS = ["❤️", "🔥", "😂", "😮", "😢", "👏", "💯", "✨"];

const formatCount = (n) => (n > 10 ? "10+" : String(n));

const ReactionPicker = ({
  onPick,
  myReactions = [],
  totalCount = 0,
  topEmojis = [],
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event) => {
      if (!wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleEnter = () => {
    if (disabled) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), 180);
  };

  const handleLeave = () => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(false), 220);
  };

  // The user's "primary" reaction — the one toggled on quick click.
  // If they've already reacted with something, clicking removes it
  // (the api treats a repeated react as a toggle). Otherwise default
  // to heart so single-click is "like" without needing the picker.
  const isLiked = myReactions.includes("❤️");
  const primary = myReactions[0] || "❤️";
  const hasReactions = topEmojis.length > 0;

  return (
    <div
      ref={wrapperRef}
      className="relative inline-flex"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <span
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && onPick?.(primary)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !disabled) {
            e.preventDefault();
            onPick?.(primary);
          }
        }}
        className={`reaction-chip cursor-pointer select-none transition-colors ${
          disabled ? "opacity-50 pointer-events-none" : ""
        }`}
        aria-label={
          myReactions.length > 0
            ? `Remove ${primary} reaction (${myReactions.length} of yours)`
            : "React"
        }
        aria-pressed={myReactions.length > 0}
      >
        {hasReactions ? (
          // Stack up to 3 most-used emojis, overlapping slightly so
          // they read as "these are the reactions on this post" — the
          // same visual pattern Teams/Discord/Slack use. The "heart
          // icon always" bug was that this whole branch didn't exist.
          <span className="inline-flex items-center -space-x-1.5">
            {topEmojis.slice(0, 3).map((emoji, i) => (
              <span
                key={`${emoji}-${i}`}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/80 dark:bg-zinc-800/80 text-[12px] ring-1 ring-zinc-200/60 dark:ring-zinc-700/60"
                style={{ zIndex: 10 - i }}
                aria-hidden="true"
              >
                {emoji}
              </span>
            ))}
          </span>
        ) : (
          // No reactions yet → heart icon as the default "tap to
          // react" affordance.
          <HeartIcon className={`h-5 w-5 ${isLiked ? "fill-current" : ""}`} />
        )}
        {totalCount > 0 && (
          <span className="text-xs font-medium">{formatCount(totalCount)}</span>
        )}
      </span>

      {open && (
        <div className="absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 flex animate-pop-in items-center gap-1 rounded-full bg-black/55 px-2 py-1.5 shadow-2xl backdrop-blur-xl">
          {DEFAULT_REACTIONS.map((emoji) => {
            const mine = myReactions.includes(emoji);
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick?.(emoji);
                }}
                className={`unfrost flex h-9 w-9 items-center justify-center rounded-full text-lg transition-transform duration-150 hover:scale-125 hover:bg-white/15 ${
                  mine ? "bg-white/20 ring-1 ring-white/30" : ""
                }`}
                aria-label={`React with ${emoji}`}
                aria-pressed={mine}
              >
                {emoji}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ReactionPicker;
