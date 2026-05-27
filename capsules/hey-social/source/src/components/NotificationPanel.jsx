import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  acceptFollow,
  deleteNotification,
  rejectFollow,
} from "../api/auth";
import { CheckIcon, CloseIcon } from "./icons";
import { SafeImage } from "./SafeMedia";

const timeAgo = (iso) => {
  if (!iso) return "";
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
};

const Avatar = ({ name, avatar }) => {
  const initials = (
    <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-gradient-to-br from-accent to-amber-600 text-sm font-bold text-accent-text">
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

const Row = ({ notification, token, onChange, onRemove }) => {
  const [busy, setBusy] = useState(false);

  const handleAccept = async () => {
    setBusy(true);
    try {
      await acceptFollow(notification.fromUserId, token);
      onRemove?.(notification.id);
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    try {
      await rejectFollow(notification.fromUserId, token);
      onRemove?.(notification.id);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await deleteNotification(notification.id, token);
      onRemove?.(notification.id);
    } finally {
      setBusy(false);
    }
  };

  let body = null;
  let action = null;
  let target = null;
  const { type, fromUserName, postCover, postId, emoji, commentText } = notification;

  if (type === "follow_request") {
    body = "sent you a follow request";
    action = (
      <div className="flex gap-1">
        <button
          type="button"
          onClick={handleAccept}
          disabled={busy}
          className="icon-btn-ghost !p-2 !text-emerald-500 hover:!bg-emerald-500/10"
          aria-label="Accept"
        >
          <CheckIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleReject}
          disabled={busy}
          className="icon-btn-ghost !p-2 hover:!text-red-400"
          aria-label="Reject"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
    );
    target = `/profile/${notification.fromUserId}`;
  } else if (type === "follow_accepted") {
    body = "accepted your follow request";
    target = `/profile/${notification.fromUserId}`;
  } else if (type === "reaction") {
    body = (
      <>
        reacted <span className="text-base leading-none">{emoji}</span> to your post
      </>
    );
    target = postId ? `/p/${postId}` : null;
  } else if (type === "repost") {
    body = "reposted your post";
    target = postId ? `/p/${postId}` : null;
  } else if (type === "comment") {
    body = (
      <>
        commented: <span className="text-primary">"{commentText}"</span>
      </>
    );
    target = postId ? `/p/${postId}` : null;
  }

  const inner = (
    <div className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-white/5 dark:hover:bg-white/5">
      <Avatar name={fromUserName} avatar={notification.fromUserAvatar} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-muted">
          <span className="font-semibold text-primary">{fromUserName}</span>{" "}
          {body}
        </p>
        <p className="mt-0.5 text-[10px] uppercase tracking-wider text-muted">
          {timeAgo(notification.createdAt)}
        </p>
      </div>

      {postCover && (
        <SafeImage
          src={postCover}
          alt=""
          className="h-10 w-10 flex-none rounded-md object-cover ring-1 ring-white/10"
        />
      )}

      {action}

      {!action && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy}
          className="icon-btn-ghost !p-1.5 opacity-0 transition-opacity group-hover:opacity-100"
          aria-label="Remove"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  return target ? (
    <Link to={target} onClick={() => onChange?.()} className="group block">
      {inner}
    </Link>
  ) : (
    <div className="group">{inner}</div>
  );
};

const NotificationPanel = ({ notifications, token, onClose, onChange }) => {
  const [list, setList] = useState(notifications || []);

  useEffect(() => setList(notifications || []), [notifications]);

  useEffect(() => {
    const handler = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleRemove = (id) => {
    setList((current) => current.filter((n) => n.id !== id));
    onChange?.();
  };

  const sortedList = useMemo(() => {
    return [...list].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  }, [list]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-24 animate-fade-in bg-black/35 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        role="dialog"
        aria-label="Notifications"
        className="relative h-fit w-full max-w-md animate-pop-in space-y-4 rounded-3xl p-6 backdrop-blur-[80px] bg-white/95 ring-1 ring-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_40px_-10px_rgba(0,0,0,0.45)] dark:bg-neutral-900/95 dark:ring-white/15 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_18px_40px_-10px_rgba(0,0,0,0.65)]"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-primary">Notifications</h2>
          <button
            type="button"
            onClick={onClose}
            className="icon-btn-ghost"
            aria-label="Close"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[60vh] overflow-y-auto -mx-2">
          {sortedList.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-muted">
              No notifications yet.
            </p>
          ) : (
            <div className="space-y-1">
              {sortedList.map((n) => (
                <Row
                  key={n.id}
                  notification={n}
                  token={token}
                  onChange={onChange}
                  onRemove={handleRemove}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default NotificationPanel;
