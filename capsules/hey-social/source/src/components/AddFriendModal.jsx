import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";
import { followPeer } from "../api/chat";

const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

const AddFriendModal = ({ token, onClose, onAdded }) => {
  const [did, setDid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const handler = (event) => {
      if (event.key === "Escape" && !busy) onClose?.();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [busy, onClose]);

  const trimmed = did.trim();
  const looksValid = DID_RE.test(trimmed);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!looksValid) {
      setError("That doesn't look like a did:key string.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const peer = await followPeer(token, trimmed);
      onAdded?.(peer);
    } catch (err) {
      setError(err.response?.data?.message || "Could not add friend.");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 animate-fade-in bg-black/35 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose?.();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="relative h-fit w-full max-w-md space-y-4 rounded-3xl p-6 text-left animate-pop-in backdrop-blur-[80px] bg-white/95 ring-1 ring-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_40px_-10px_rgba(0,0,0,0.45)] dark:bg-neutral-900/95 dark:ring-white/15 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_18px_40px_-10px_rgba(0,0,0,0.65)]"
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-primary">Add a friend</h2>
            <p className="mt-1 text-xs text-muted">
              Paste their did:key. They'll show up in your chat once they message you back.
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

        <textarea
          value={did}
          onChange={(e) => setDid(e.target.value)}
          rows={3}
          placeholder="did:key:z6Mk..."
          disabled={busy}
          className="frosted-input w-full font-mono text-xs disabled:opacity-50"
        />

        {error && (
          <p className="animate-fade-in text-sm text-red-500 dark:text-red-400">
            {error}
          </p>
        )}

        <p className="text-[11px] text-muted">
          Hint: you can find your own did:key on your profile page. Send it to a friend any way you like — chat, paper, QR.
        </p>

        <button
          type="submit"
          disabled={busy || !looksValid}
          className="unfrost w-full rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Adding..." : "Add friend"}
        </button>
      </form>
    </div>,
    document.body
  );
};

export default AddFriendModal;
