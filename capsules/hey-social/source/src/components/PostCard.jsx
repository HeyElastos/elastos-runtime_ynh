import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import ImageCarousel from "./ImageCarousel";
import ReactionPicker from "./ReactionPicker";
import { useReveal } from "../hooks/useReveal";
import { CloseIcon, CommentIcon, HeartIcon, PaperPlaneIcon, RepostIcon, SmileIcon, TrashIcon } from "./icons";
import {
  addComment as apiAddComment,
  deleteComment as apiDeleteComment,
  deletePost as apiDeletePost,
  editPost as apiEditPost,
  reactToComment as apiReactComment,
  reactToPost as apiReact,
  repostPost as apiRepost,
} from "../api/auth";

const formatCount = (n) => (n > 10 ? "10+" : String(n));

const timeAgo = (iso) => {
  if (!iso) return "";
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
};

const Avatar = ({ name, avatar }) => {
  const [failed, setFailed] = useState(false);
  if (avatar && !failed) {
    return (
      <img
        src={avatar}
        alt=""
        onError={() => setFailed(true)}
        className="h-12 w-12 flex-none rounded-full object-cover ring-1 ring-white/15 shadow-sm"
      />
    );
  }
  return (
    <div className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-gradient-to-br from-accent to-amber-600 text-base font-bold text-accent-text shadow-sm">
      {(name || "?").slice(0, 2).toUpperCase()}
    </div>
  );
};

const CommentAvatar = ({ name, avatar }) => {
  const [failed, setFailed] = useState(false);
  if (avatar && !failed) {
    return (
      <img
        src={avatar}
        alt={name}
        onError={() => setFailed(true)}
        className="h-8 w-8 rounded-full object-cover ring-1 ring-white/15 shadow-sm"
      />
    );
  }
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-amber-600 text-xs font-bold text-slate-900 shadow-sm">
      {(name || "?").slice(0, 2).toUpperCase()}
    </span>
  );
};

const PostCard = ({ post, currentUser, token, onChange, onDelete }) => {
  const { ref, visible } = useReveal();
  const [commentText, setCommentText] = useState("");
  const [showAllComments, setShowAllComments] = useState(false);
  const [showCommentForm, setShowCommentForm] = useState(false);
  const [replyParentId, setReplyParentId] = useState(null);
  const [hiddenCommentIds, setHiddenCommentIds] = useState(() => new Set());

  const hideComment = (id) =>
    setHiddenCommentIds((s) => {
      const n = new Set(s);
      n.add(id);
      return n;
    });
  const restoreHiddenComments = () => setHiddenCommentIds(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const commentInputRef = useRef(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiWrapRef = useRef(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmDeleteRef = useRef(null);
  // Three-dot menu state on the post card (owner-only). Replaces the
  // old hover trash button with Edit + Delete options.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  // Inline caption editor — visible when the user picks "Edit post"
  // from the menu. Mirrors post.caption into a local string so cancel
  // restores cleanly.
  const [editingCaption, setEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState(post.caption || "");
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => {
    if (showCommentForm) {
      commentInputRef.current?.focus();
    } else {
      setEmojiOpen(false);
    }
  }, [showCommentForm]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  useEffect(() => {
    if (!emojiOpen) return;
    const handler = (event) => {
      if (!emojiWrapRef.current?.contains(event.target)) setEmojiOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [emojiOpen]);

  useEffect(() => {
    if (!confirmDelete) return;
    const handler = (event) => {
      if (!confirmDeleteRef.current?.contains(event.target)) setConfirmDelete(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [confirmDelete]);

  const insertEmoji = (emoji) => {
    const input = commentInputRef.current;
    if (!input) {
      setCommentText((current) => current + emoji);
      return;
    }
    const start = input.selectionStart ?? commentText.length;
    const end = input.selectionEnd ?? commentText.length;
    const next = commentText.slice(0, start) + emoji + commentText.slice(end);
    setCommentText(next);
    requestAnimationFrame(() => {
      input.focus();
      const caret = start + emoji.length;
      input.setSelectionRange(caret, caret);
    });
    setEmojiOpen(false);
  };

  const COMMENT_EMOJIS = ["😂", "❤️", "🔥", "😍", "😮", "👏", "🙏", "😢", "💯", "✨", "👀", "🎉"];

  const isOwner = currentUser?.id === post.userId;
  const myReactions = useMemo(() => {
    const list = [];
    for (const [emoji, ids] of Object.entries(post.reactions || {})) {
      if (ids.includes(currentUser?.id)) list.push(emoji);
    }
    return list;
  }, [post.reactions, currentUser]);

  const reactionEntries = useMemo(() => {
    const entries = Object.entries(post.reactions || {});
    entries.sort((a, b) => b[1].length - a[1].length);
    return entries;
  }, [post.reactions]);

  const topReactionEmojis = useMemo(
    () => reactionEntries.slice(0, 3).map(([emoji]) => emoji),
    [reactionEntries]
  );

  const totalReactions = useMemo(
    () => reactionEntries.reduce((sum, [, ids]) => sum + ids.length, 0),
    [reactionEntries]
  );

  const didRepost = useMemo(
    () => (post.reposts || []).some((r) => r.userId === currentUser?.id),
    [post.reposts, currentUser]
  );

  const captionWithTags = useMemo(() => {
    if (!post.caption) return null;
    return post.caption.split(/(\s+)/).map((part, i) => {
      if (/^#[\p{L}\p{N}_]+/u.test(part)) {
        return (
          <span key={i} className="text-accent">
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  }, [post.caption]);

  const runReact = async (emoji) => {
    if (!token) {
      setError("Sign in to react.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const data = await apiReact(post.id, emoji, token);
      onChange?.(data.post);
    } catch (e) {
      setError(e.response?.data?.message || "Could not react.");
    } finally {
      setBusy(false);
    }
  };

  const runRepost = async () => {
    if (!token) {
      setError("Sign in to repost.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const data = await apiRepost(post.id, token);
      onChange?.(data.post);
    } catch (e) {
      setError(e.response?.data?.message || "Could not repost.");
    } finally {
      setBusy(false);
    }
  };

  const submitComment = async (event) => {
    event.preventDefault();
    if (!commentText.trim() || !token) return;
    setError(null);
    setBusy(true);
    try {
      const data = await apiAddComment(
        post.id,
        commentText.trim(),
        token,
        replyParentId
      );
      onChange?.(data.post);
      setCommentText("");
      setReplyParentId(null);
    } catch (e) {
      setError(e.response?.data?.message || "Could not comment.");
    } finally {
      setBusy(false);
    }
  };

  const reactComment = async (commentId, emoji = "❤️") => {
    if (!token) {
      setError("Sign in to react.");
      return;
    }
    setBusy(true);
    try {
      const data = await apiReactComment(post.id, commentId, emoji, token);
      onChange?.(data.post);
    } catch (e) {
      setError(e.response?.data?.message || "Could not react.");
    } finally {
      setBusy(false);
    }
  };

  const openReplyTo = (commentId) => {
    setReplyParentId(commentId);
    setShowCommentForm(true);
    setTimeout(() => commentInputRef.current?.focus(), 0);
  };

  const removeComment = async (commentId) => {
    setBusy(true);
    try {
      const data = await apiDeleteComment(post.id, commentId, token);
      onChange?.(data.post);
    } catch (e) {
      setError(e.response?.data?.message || e.message || "Could not delete comment.");
    } finally {
      setBusy(false);
    }
  };

  // Capsule-mode delete authenticates server-side via the caller's DID
  // (see api/auth.js deletePost) — the legacy !token guard belongs to
  // the old server-mode auth flow and was silently swallowing every tap
  // when profile.accessToken happened to be missing in localStorage.
  const removePost = async () => {
    if (!isOwner) return;
    setConfirmDelete(false);
    setMenuOpen(false);
    setBusy(true);
    try {
      await apiDeletePost(post.id, token);
      onDelete?.(post.id);
    } catch (e) {
      setError(e.response?.data?.message || e.message || "Could not delete.");
      setBusy(false);
    }
  };

  const openEditor = () => {
    setCaptionDraft(post.caption || "");
    setEditingCaption(true);
    setMenuOpen(false);
  };

  const cancelEdit = () => {
    setEditingCaption(false);
    setCaptionDraft(post.caption || "");
  };

  const saveEdit = async () => {
    if (!isOwner) return;
    const trimmed = captionDraft.trim();
    if (trimmed === (post.caption || "").trim()) {
      // No change → just close the editor; no need to write.
      setEditingCaption(false);
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await apiEditPost(post.id, { caption: trimmed });
      onChange?.(updated);
      setEditingCaption(false);
    } catch (e) {
      setError(e.response?.data?.message || e.message || "Could not save edit.");
    } finally {
      setSavingEdit(false);
    }
  };

  const visibleComments = showAllComments
    ? post.comments
    : (post.comments || []).slice(-2);

  return (
    <article
      ref={ref}
      className={`frosted-card overflow-hidden p-0 reveal ${visible ? "is-visible" : ""}`}
    >
      {(post.reposts || []).length > 0 && (
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-2.5 text-xs uppercase tracking-wider text-muted">
          <RepostIcon className="h-3.5 w-3.5" />
          <span>
            Reposted by {post.reposts[post.reposts.length - 1].userName}
            {post.reposts.length > 1 && ` +${post.reposts.length - 1}`}
          </span>
        </div>
      )}

      <header className="flex items-start gap-3 px-5 pt-4 pb-2">
        <Link to={`/profile/${post.userId}`} className="flex-none">
          <Avatar name={post.userName} avatar={post.userAvatar} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <Link
              to={`/profile/${post.userId}`}
              className="font-semibold text-primary hover:text-accent transition-colors"
            >
              {post.userName}
            </Link>
            <span className="text-xs text-muted">·</span>
            <span className="text-xs text-muted">
              {timeAgo(post.createdAt)}
              {post.editedAt && post.editedAt > post.createdAt && (
                <span className="ml-1 text-muted/70" title="Edited">(edited)</span>
              )}
            </span>
          </div>
          {/* Caption: render-mode shows tagged text; edit-mode swaps
              in a textarea with Save/Cancel. Inline edit is owner-only;
              the menu is the only way to enter this mode. */}
          {editingCaption ? (
            <div className="mt-2 space-y-2">
              <textarea
                value={captionDraft}
                onChange={(e) => setCaptionDraft(e.target.value)}
                disabled={savingEdit}
                rows={3}
                autoFocus
                className="w-full rounded-lg bg-zinc-100/70 dark:bg-zinc-800/60 border border-zinc-200/60 dark:border-zinc-700/60 px-3 py-2 text-sm text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={savingEdit}
                  className="rounded-full px-3 py-1 text-xs text-muted hover:text-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={savingEdit}
                  className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-text hover:bg-amber-300 disabled:opacity-50"
                >
                  {savingEdit ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ) : (
            captionWithTags && (
              <p className="mt-1 whitespace-pre-line text-sm leading-6 text-primary">
                {captionWithTags}
              </p>
            )
          )}
        </div>

        {/* Three-dot owner menu. Replaces the v0.2 hover trash button.
            Opens a small popover with Edit + Delete; closes on
            outside-click via the menuOpen useEffect above. */}
        {isOwner && (
          <div ref={menuRef} className="relative flex-none">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Post actions"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="rounded-full p-1.5 text-muted hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-primary transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1 z-20 min-w-[140px] rounded-lg border border-zinc-200/60 dark:border-zinc-700/60 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl shadow-xl py-1"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={openEditor}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-primary hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                  Edit post
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (busy) return;
                    if (!confirmDelete) {
                      setConfirmDelete(true);
                      setTimeout(() => setConfirmDelete(false), 3000);
                      return;
                    }
                    removePost();
                  }}
                  disabled={busy}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                    confirmDelete
                      ? "bg-red-500/90 text-white font-semibold"
                      : "text-red-600 dark:text-red-400 hover:bg-red-500/10"
                  }`}
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                  {confirmDelete ? "Tap to confirm" : "Delete post"}
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {post.images?.length > 0 && (
        <div className="relative px-1 pb-1">
          <ImageCarousel images={post.images} />
        </div>
      )}

      <div className="px-5 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <ReactionPicker
            onPick={runReact}
            myReactions={myReactions}
            totalCount={totalReactions}
            topEmojis={topReactionEmojis}
            disabled={busy}
          />

          <button
            type="button"
            onClick={runRepost}
            disabled={busy}
            className={`unfrost reaction-chip ${didRepost ? "is-active" : ""}`}
            aria-label={didRepost ? "Undo repost" : "Repost"}
          >
            <RepostIcon className="h-5 w-5" />
            {(post.reposts?.length || 0) > 0 && (
              <span className="text-xs font-medium">{formatCount(post.reposts.length)}</span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setShowCommentForm((current) => !current)}
            className={`unfrost reaction-chip ${showCommentForm ? "is-active" : ""}`}
            aria-label="Comment"
            aria-expanded={showCommentForm}
          >
            <CommentIcon className="h-5 w-5" />
            {(post.comments?.length || 0) > 0 && (
              <span className="text-xs font-medium">{formatCount(post.comments.length)}</span>
            )}
          </button>
        </div>

      </div>

      <div className="px-5 pb-4 pt-3">
        {(post.comments?.length || 0) > 2 && !showAllComments && (
          <button
            type="button"
            onClick={() => setShowAllComments(true)}
            className="unfrost text-xs text-muted hover:text-primary"
          >
            View all {post.comments.length} comments
          </button>
        )}

        {(() => {
          // Group visibleComments by parentId for threaded display, dropping
          // any locally-hidden comments + their replies.
          const topLevel = (visibleComments || []).filter(
            (c) => !c.parentId && !hiddenCommentIds.has(c.id)
          );
          const repliesByParent = (post.comments || [])
            .filter((c) => !hiddenCommentIds.has(c.id))
            .reduce((acc, c) => {
              if (!c.parentId) return acc;
              (acc[c.parentId] = acc[c.parentId] || []).push(c);
              return acc;
            }, {});

          const renderComment = (comment) => {
            const canDelete = comment.userId === currentUser?.id || isOwner;
            const reactionCount = Object.values(comment.reactions || {}).reduce(
              (sum, ids) => sum + ids.length,
              0
            );
            const youReactedHeart = (comment.reactions?.["❤️"] || []).includes(
              currentUser?.id
            );
            return (
              <li
                key={comment.id}
                className="group flex items-start gap-3 rounded-2xl border border-white/15 bg-white/[0.10] p-3 backdrop-blur-xl dark:bg-white/[0.06]"
                style={{ WebkitBackdropFilter: "blur(24px)" }}
              >
                <span
                  title={comment.userName}
                  aria-label={comment.userName}
                  className="flex-none"
                >
                  <CommentAvatar name={comment.userName} avatar={comment.userAvatar} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <Link
                      to={`/profile/${comment.userId}`}
                      className="unfrost text-sm font-semibold text-primary transition hover:underline"
                    >
                      {comment.userName || "Unknown"}
                    </Link>
                    <span className="text-[10px] uppercase tracking-wider text-muted">
                      {timeAgo(comment.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-base leading-7 text-primary">
                    {comment.text}
                  </p>
                  <div className="mt-1 flex items-center gap-3">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={() => !busy && reactComment(comment.id, "❤️")}
                      onKeyDown={(e) => {
                        if ((e.key === "Enter" || e.key === " ") && !busy) {
                          e.preventDefault();
                          reactComment(comment.id, "❤️");
                        }
                      }}
                      aria-label={youReactedHeart ? "Unreact" : "React"}
                      aria-pressed={youReactedHeart}
                      className={`inline-flex cursor-pointer select-none items-center gap-1 text-xs text-muted transition-colors hover:text-primary ${
                        busy ? "opacity-50 pointer-events-none" : ""
                      }`}
                    >
                      <HeartIcon
                        className={`h-4 w-4 ${youReactedHeart ? "fill-current" : ""}`}
                      />
                      {reactionCount > 0 && <span>{reactionCount}</span>}
                    </span>
                    {token && (
                      <button
                        type="button"
                        onClick={() => openReplyTo(comment.parentId || comment.id)}
                        className="unfrost text-[11px] font-medium uppercase tracking-wider text-muted transition hover:text-accent"
                      >
                        Reply
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex flex-none flex-col items-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => hideComment(comment.id)}
                    className="unfrost text-[10px] uppercase tracking-wider text-muted transition hover:text-primary"
                    aria-label="Hide this comment"
                    title="Hide this comment from your view"
                  >
                    Hide
                  </button>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => removeComment(comment.id)}
                      className="unfrost text-xs text-muted transition hover:text-red-400"
                      aria-label="Delete comment"
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </li>
            );
          };

          return (
            <>
              <ul className="mt-2 space-y-3">
                {topLevel.map((comment) => {
                  const replies = (repliesByParent[comment.id] || []).sort(
                    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
                  );
                  return (
                    <li key={comment.id} className="space-y-2">
                      <ul className="space-y-2">{renderComment(comment)}</ul>
                      {replies.length > 0 && (
                        <ul className="ml-6 space-y-2 border-l border-white/10 pl-3">
                          {replies.map(renderComment)}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
              {hiddenCommentIds.size > 0 && (
                <button
                  type="button"
                  onClick={restoreHiddenComments}
                  className="unfrost mt-2 text-xs text-muted transition hover:text-accent"
                >
                  Show {hiddenCommentIds.size} hidden
                  {hiddenCommentIds.size === 1 ? " comment" : " comments"}
                </button>
              )}
            </>
          );
        })()}

        {token && showCommentForm && (
          <form
            onSubmit={submitComment}
            className="mt-3 animate-fade-up space-y-2"
          >
            {replyParentId && (() => {
              const parent = post.comments?.find((c) => c.id === replyParentId);
              return parent ? (
                <p className="text-xs text-muted">
                  Replying to{" "}
                  <span className="font-semibold text-primary">
                    {parent.userName || "Unknown"}
                  </span>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => setReplyParentId(null)}
                    className="unfrost text-accent transition hover:underline"
                  >
                    cancel
                  </button>
                </p>
              ) : null;
            })()}
            <div className="flex items-center gap-2">
            <div
              ref={emojiWrapRef}
              className="relative flex-1"
            >
              <input
                ref={commentInputRef}
                type="text"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Add a comment..."
                maxLength={500}
                className="frosted-input w-full !rounded-full !py-2 !pr-10 text-sm"
              />
              <button
                type="button"
                onClick={() => setEmojiOpen((current) => !current)}
                className="icon-btn-ghost absolute right-1 inset-y-1"
                aria-label="Insert emoji"
                aria-expanded={emojiOpen}
              >
                <SmileIcon className="h-4 w-4" />
              </button>

              {emojiOpen && (
                <div className="absolute bottom-full right-0 z-20 mb-2 flex animate-pop-in flex-wrap gap-1 rounded-2xl bg-black/65 p-2 shadow-2xl backdrop-blur-xl w-56">
                  {COMMENT_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => insertEmoji(emoji)}
                      className="unfrost flex h-8 w-8 items-center justify-center rounded-full text-lg transition-transform duration-150 hover:scale-125 hover:bg-white/15"
                      aria-label={`Insert ${emoji}`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={!commentText.trim() || busy}
              aria-label="Post comment"
              className="unfrost flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-accent-text shadow-sm transition disabled:opacity-50 hover:bg-amber-300"
            >
              <PaperPlaneIcon className="h-4 w-4 -translate-x-0.5 translate-y-0.5" />
            </button>
            </div>
          </form>
        )}
        {!token && (
          <p className="mt-3 text-xs text-muted">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("open-signin"))}
              className="unfrost text-accent hover:underline"
            >
              Sign in
            </button>{" "}
            to react or comment.
          </p>
        )}

        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
    </article>
  );
};

export default PostCard;
