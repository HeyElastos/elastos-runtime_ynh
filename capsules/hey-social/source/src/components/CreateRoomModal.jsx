import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";
import { createGroup } from "../api/chat";

const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

const CreateRoomModal = ({ token, onClose, onCreated }) => {
  const [name, setName] = useState("");
  const [memberInput, setMemberInput] = useState("");
  const [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape" && !busy) onClose?.();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [busy, onClose]);

  const addMember = () => {
    const did = memberInput.trim();
    if (!DID_RE.test(did)) {
      setError("Not a valid did:key string.");
      return;
    }
    if (members.includes(did)) {
      setError("That did is already on the list.");
      return;
    }
    setMembers((prev) => [...prev, did]);
    setMemberInput("");
    setError(null);
  };

  const removeMember = (idx) => {
    setMembers((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Pick a name for the group.");
      return;
    }
    if (members.length === 0) {
      setError("Add at least one member did:key.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // DID-keyed group: topic is sha256(sorted DIDs). No room IDs,
      // no admins, no invite handshake — anyone with the same DID set
      // computes the same conversation.
      const group = await createGroup(token, name.trim(), members);
      onCreated?.(group);
    } catch (err) {
      setError(err.message || err.response?.data?.message || "Could not create group.");
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
            <h2 className="text-base font-semibold text-primary">New group</h2>
            <p className="mt-1 text-xs text-muted">
              Give it a name and invite friends by their did:key. You can add more later.
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

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">
            Group name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Photo trip"
            disabled={busy}
            maxLength={60}
            className="frosted-input w-full disabled:opacity-50"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">
            Invite members
          </label>
          <div className="flex gap-2">
            <input
              value={memberInput}
              onChange={(e) => setMemberInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addMember();
                }
              }}
              placeholder="did:key:z6Mk..."
              disabled={busy}
              className="frosted-input flex-1 font-mono text-xs disabled:opacity-50"
            />
            <button
              type="button"
              onClick={addMember}
              disabled={busy || !memberInput.trim()}
              className="rounded-full bg-accent/15 px-4 py-2 text-xs font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-40"
            >
              Add
            </button>
          </div>
          {members.length > 0 && (
            <ul className="mt-2 space-y-1">
              {members.map((did, idx) => (
                <li
                  key={idx}
                  className="flex items-center gap-2 rounded-lg bg-black/5 px-3 py-1.5 text-[11px] dark:bg-white/5"
                >
                  <span className="flex-1 truncate font-mono text-primary/80">{did}</span>
                  <button
                    type="button"
                    onClick={() => removeMember(idx)}
                    className="text-muted hover:text-red-500"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-muted">
            {members.length === 0 ? "Just you for now — add at least one friend or the room is solo." : `${members.length + 1} member${members.length === 0 ? "" : "s"} including you`}
          </p>
        </div>

        {error && (
          <p className="animate-fade-in text-sm text-red-500 dark:text-red-400">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="unfrost w-full rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Creating..." : "Create group"}
        </button>
      </form>
    </div>,
    document.body
  );
};

export default CreateRoomModal;
