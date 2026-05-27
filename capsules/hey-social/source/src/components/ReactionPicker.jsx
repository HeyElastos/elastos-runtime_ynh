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

  const isLiked = myReactions.includes("❤️");

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
        onClick={() => !disabled && onPick?.("❤️")}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !disabled) {
            e.preventDefault();
            onPick?.("❤️");
          }
        }}
        className={`reaction-chip cursor-pointer select-none transition-colors ${
          disabled ? "opacity-50 pointer-events-none" : ""
        }`}
        aria-label={isLiked ? "Remove heart reaction" : "React with heart"}
        aria-pressed={isLiked}
      >
        <HeartIcon className={`h-5 w-5 ${isLiked ? "fill-current" : ""}`} />
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
