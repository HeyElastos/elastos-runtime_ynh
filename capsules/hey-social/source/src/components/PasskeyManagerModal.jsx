import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { listPasskeys, removePasskey } from "../api/passkey";
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

const PasskeyManagerModal = ({ token, onClose, onAdd }) => {
  const [creds, setCreds] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = async () => {
    try {
      const data = await listPasskeys(token);
      setCreds(data.credentials || []);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Could not load passkeys.");
      setCreds([]);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape" && !busy) onClose?.();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [busy, onClose]);

  const handleRemove = async () => {
    if (!creds || creds.length === 0 || busy) return;
    // Remove the most-recently-added passkey
    const sorted = [...creds].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    const target = sorted[0];
    setBusy(true);
    setError(null);
    try {
      const data = await removePasskey(target.id, token);
      setCreds(data.credentials || []);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Could not remove passkey.");
    } finally {
      setBusy(false);
    }
  };

  const count = creds?.length ?? null;
  const status =
    count === null
      ? "Loading…"
      : count === 0
      ? "No passkeys yet."
      : count === 1
      ? "1 passkey registered."
      : `${count} passkeys registered.`;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 animate-fade-in bg-black/35 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose?.();
      }}
    >
      <div
        role="dialog"
        aria-label="Manage passkeys"
        className="relative h-fit w-full max-w-sm space-y-4 rounded-3xl p-6 animate-pop-in backdrop-blur-[80px] bg-white/95 ring-1 ring-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_40px_-10px_rgba(0,0,0,0.45)] dark:bg-neutral-900/95 dark:ring-white/15 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_18px_40px_-10px_rgba(0,0,0,0.65)]"
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-primary">Manage passkeys</h2>
            <p className="mt-1 text-xs text-muted">
              Hardware keys (Yubikey, Nitrokey) or platform passkeys (Touch ID,
              Windows Hello).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="icon-btn-ghost flex-none"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="flex items-center gap-3 rounded-2xl bg-black/5 px-4 py-3 dark:bg-white/5">
          <PasskeyIcon className="h-7 w-7 flex-none text-primary" />
          <p className="text-sm text-primary">{status}</p>
        </div>

        {error && (
          <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onAdd}
            disabled={busy}
            className="unfrost group inline-flex w-full items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text transition hover:bg-amber-300 disabled:opacity-50"
          >
            Add key
          </button>

          <button
            type="button"
            onClick={handleRemove}
            disabled={busy || !creds || creds.length === 0}
            style={
              !busy && creds && creds.length > 0
                ? { backgroundColor: "rgb(239 68 68)" }
                : undefined
            }
            className="inline-flex w-full items-center justify-center gap-2 rounded-full border-2 border-red-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-red-900/30 transition hover:!bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Removing…" : "Remove key"}
          </button>

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="unfrost mt-1 inline-flex w-full items-center justify-center rounded-full border border-black/10 bg-black/5 px-5 py-2 text-sm font-medium text-primary transition hover:bg-black/10 disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default PasskeyManagerModal;
