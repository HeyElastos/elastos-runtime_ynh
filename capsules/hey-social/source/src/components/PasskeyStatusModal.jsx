import { useEffect } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";

const PasskeyIcon = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="12" r="4.5" />
    <path d="M5.7 12.6 Q8 10.4 10.3 12.6" />
    <path d="M6.2 14.1 Q8 12.3 9.8 14.1" />
    <path d="M7 11 Q8 10.1 9 11" />
    <path d="M12.5 12 H20.5" />
    <path d="M16 12 V14.6" />
    <path d="M18.8 12 V14" />
  </svg>
);

// state: "waiting" | "ok" | "error"
const PasskeyStatusModal = ({ state, message, onClose }) => {
  // Auto-close on success after a short delay
  useEffect(() => {
    if (state !== "ok") return;
    const t = setTimeout(() => onClose?.(), 1800);
    return () => clearTimeout(t);
  }, [state, onClose]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape" && state !== "waiting") onClose?.();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [state, onClose]);

  const dismissible = state !== "waiting";

  let title, subtitle, iconColor, ringClass, badge;
  if (state === "waiting") {
    title = "Tap your key";
    subtitle = "Touch your security key or biometric sensor to confirm.";
    iconColor = "text-primary";
    ringClass = "ring-2 ring-amber-400/60 animate-pulse";
    badge = null;
  } else if (state === "ok") {
    title = "Passkey added";
    subtitle = "You can now sign in with it on this device.";
    iconColor = "text-emerald-500";
    ringClass = "ring-2 ring-emerald-500/40";
    badge = (
      <span className="absolute -bottom-1 -right-1 inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-[color:var(--surface-soft)]">
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-white stroke-[3]" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12l5 5L20 7" />
        </svg>
      </span>
    );
  } else {
    title = "Couldn't add passkey";
    subtitle = message || "Try again, or use a different device.";
    iconColor = "text-red-500";
    ringClass = "ring-2 ring-red-500/40";
    badge = (
      <span className="absolute -bottom-1 -right-1 inline-flex h-7 w-7 items-center justify-center rounded-full bg-red-500 ring-2 ring-[color:var(--surface-soft)]">
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-white stroke-[3]" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 6l12 12M6 18L18 6" />
        </svg>
      </span>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 animate-fade-in bg-black/35 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && dismissible) onClose?.();
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        aria-live="polite"
        className="relative h-fit w-full max-w-sm space-y-4 rounded-3xl p-6 text-center animate-pop-in backdrop-blur-[80px] bg-white/95 ring-1 ring-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_40px_-10px_rgba(0,0,0,0.45)] dark:bg-neutral-900/95 dark:ring-white/15 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_18px_40px_-10px_rgba(0,0,0,0.65)]"
      >
        {dismissible && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="icon-btn-ghost absolute right-3 top-3"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        )}

        <div className="flex justify-center pt-2">
          <div className="relative">
            <span
              className={`flex h-20 w-20 items-center justify-center rounded-full bg-black/5 dark:bg-white/5 ${ringClass}`}
            >
              <PasskeyIcon className={`h-10 w-10 ${iconColor}`} />
            </span>
            {badge}
          </div>
        </div>

        <h2 className="text-base font-semibold text-primary">{title}</h2>
        <p className="text-xs text-muted leading-relaxed">{subtitle}</p>

        {state === "error" && (
          <button
            type="button"
            onClick={onClose}
            className="unfrost mt-2 inline-block rounded-full border border-black/10 bg-black/5 px-5 py-2 text-xs font-medium text-primary transition hover:bg-black/10 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
          >
            Close
          </button>
        )}
      </div>
    </div>,
    document.body
  );
};

export default PasskeyStatusModal;
