import { useEffect, useMemo, useRef, useState } from "react";
import { useProfile } from "../hooks/useProfile";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  addComment,
  deleteComment,
  getPost,
  reactToPost,
} from "../api/auth";
import { ChevronLeftIcon, CloseIcon, HeartIcon } from "../components/icons";
import { SafeImage } from "../components/SafeMedia";
import HeyVideoPlayer from "../components/HeyVideoPlayer";
import CommentBubble from "../components/CommentBubble";

const LIKE_EMOJI = "❤️";

const timeAgo = (iso) => {
  if (!iso) return "";
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
};

const Avatar = ({ name, avatar, small = false }) => {
  const cls = small ? "h-9 w-9" : "h-10 w-10";
  const initials = (
    <div
      className={`${cls} flex flex-none items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-amber-600 text-sm font-bold text-slate-900`}
    >
      {(name || "?").slice(0, 2).toUpperCase()}
    </div>
  );
  return (
    <SafeImage
      src={avatar}
      alt=""
      fallback={initials}
      className={`${cls} flex-none rounded-full object-cover ring-1 ring-white/20`}
    />
  );
};

const VideoPlayer = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [commentText, setCommentText] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [reactBusy, setReactBusy] = useState(false);
  const [commentFormOpen, setCommentFormOpen] = useState(false);
  const [commentsCollapsed, setCommentsCollapsed] = useState(false);
  const [replyParentId, setReplyParentId] = useState(null); // null = top-level
  const commentFormRef = useRef(null);
  const commentTextareaRef = useRef(null);

  const openCommentForm = (parentId = null) => {
    setReplyParentId(parentId);
    setCommentFormOpen(true);
    setTimeout(() => {
      commentTextareaRef.current?.focus();
      commentFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  };

  const profile = useProfile();
  const token = profile?.accessToken;
  const currentUserId = profile?.user?.id;

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const data = await getPost(id, token);
        if (active) setPost(data.post);
      } catch (e) {
        if (active) {
          setError(e.response?.data?.message || "Video not found.");
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id, token]);

  const videoItem = post?.images?.[0];
  const videoSrc = videoItem?.url;

  const likeIds = post?.reactions?.[LIKE_EMOJI] || [];
  const likeCount = likeIds.length;
  const youLiked = currentUserId ? likeIds.includes(currentUserId) : false;

  const totalReactions = useMemo(() => {
    if (!post?.reactions) return 0;
    return Object.values(post.reactions).reduce((sum, ids) => sum + ids.length, 0);
  }, [post]);

  const comments = post?.comments || [];

  const toggleLike = async () => {
    if (!token) {
      setError("Sign in to react.");
      return;
    }
    setReactBusy(true);
    try {
      const data = await reactToPost(post.id, LIKE_EMOJI, token);
      setPost(data.post);
    } catch (e) {
      setError(e.response?.data?.message || "Could not react.");
    } finally {
      setReactBusy(false);
    }
  };

  const submitComment = async (event) => {
    event.preventDefault();
    const text = commentText.trim();
    if (!text || !token) return;
    setCommentBusy(true);
    try {
      const data = await addComment(post.id, text, token, replyParentId);
      setPost(data.post);
      setCommentText("");
      setReplyParentId(null);
    } catch (e) {
      setError(e.response?.data?.message || "Could not post comment.");
    } finally {
      setCommentBusy(false);
    }
  };

  const removeComment = async (commentId) => {
    if (!token) return;
    try {
      const data = await deleteComment(post.id, commentId, token);
      setPost(data.post);
    } catch {
      /* noop */
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="aspect-video w-full image-skeleton rounded-2xl" />
        <div className="h-6 w-2/3 image-skeleton rounded" />
        <div className="h-4 w-1/3 image-skeleton rounded" />
      </div>
    );
  }

  if (error || !post) {
    return (
      <div className="mx-auto max-w-md frosted-card animate-fade-up p-8 text-center">
        <h2 className="text-xl font-bold text-primary">Video unavailable</h2>
        <p className="mt-3 text-sm text-muted">{error || "Video not found."}</p>
        <Link
          to="/videos"
          className="unfrost mt-5 inline-block rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text"
        >
          Back to videos
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="unfrost inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-primary"
      >
        <ChevronLeftIcon className="h-4 w-4" />
        Back
      </button>

      <div className="overflow-hidden rounded-2xl bg-black shadow-xl shadow-slate-950/40">
        {videoSrc ? (
          <HeyVideoPlayer
            src={videoSrc}
            title={post?.caption || "Hey video"}
            autoPlay
          />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center bg-gradient-to-br from-indigo-500 via-fuchsia-600 to-rose-500 text-white">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-black/40 ring-1 ring-white/30 backdrop-blur-sm">
              <svg viewBox="0 0 24 24" className="ml-1 h-8 w-8 fill-current">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h1 className="text-xl font-semibold leading-snug text-primary sm:text-2xl">
          {post.caption || "Untitled"}
        </h1>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            to={`/profile/${post.userId}`}
            className="unfrost flex items-center gap-3 transition hover:opacity-90"
          >
            <Avatar name={post.userName} avatar={post.userAvatar} size={10} />
            <div>
              <p className="text-sm font-semibold text-primary">
                {post.userName || "Unknown"}
              </p>
              <p className="text-xs text-muted">
                {timeAgo(post.createdAt)}
                {totalReactions > 0 && ` · ${totalReactions} reactions`}
              </p>
            </div>
          </Link>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleLike}
              disabled={reactBusy}
              className={`unfrost flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${
                youLiked
                  ? "border-rose-500/40 bg-rose-500/15 text-rose-500 dark:text-rose-400"
                  : "border-black/10 bg-black/5 text-primary hover:bg-black/10 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
              }`}
              aria-pressed={youLiked}
              aria-label={youLiked ? "Unlike" : "Like"}
            >
              <HeartIcon className={`h-5 w-5 ${youLiked ? "fill-current" : ""}`} />
              <span>{likeCount}</span>
            </button>

          </div>
        </div>
      </div>

      <section className="space-y-4 border-t border-black/10 pt-6 dark:border-white/10">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setCommentsCollapsed((v) => !v)}
            aria-expanded={!commentsCollapsed}
            className="unfrost group flex items-center gap-1.5 text-base font-semibold text-primary transition hover:text-accent"
            title={commentsCollapsed ? "Show comments" : "Hide comments"}
          >
            {comments.length} {comments.length === 1 ? "comment" : "comments"}
            <svg
              viewBox="0 0 24 24"
              className={`h-4 w-4 fill-none stroke-current stroke-[2] transition-transform duration-200 ${
                commentsCollapsed ? "" : "rotate-180"
              }`}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {token && !commentFormOpen && (
            <button
              type="button"
              onClick={() => openCommentForm(null)}
              className="unfrost rounded-full border border-black/10 bg-black/5 px-3.5 py-1.5 text-xs font-medium text-primary transition hover:bg-black/10 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
            >
              Add a comment…
            </button>
          )}
        </div>

        {!token && (
          <p className="text-sm text-muted">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("open-signin"))}
              className="unfrost text-accent hover:underline"
            >
              Sign in
            </button>{" "}
            to comment.
          </p>
        )}

        {!commentsCollapsed && (() => {
          if (comments.length === 0) {
            return (
              <p className="py-8 text-center text-sm text-muted">
                No comments yet — be the first.
              </p>
            );
          }

          const topLevel = comments
            .filter((c) => !c.parentId)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

          const repliesByParent = comments.reduce((acc, c) => {
            if (!c.parentId) return acc;
            (acc[c.parentId] = acc[c.parentId] || []).push(c);
            return acc;
          }, {});

          const renderComment = (c, isReply) => {
            const isMine = c.userId === currentUserId;
            return (
              <li
                key={c.id}
                className={`group flex items-start gap-3 rounded-2xl border border-white/15 bg-white/[0.10] p-3 backdrop-blur-xl dark:bg-white/[0.06] ${
                  isReply ? "" : ""
                }`}
                style={{ WebkitBackdropFilter: "blur(24px)" }}
              >
                <Avatar name={c.userName} avatar={c.userAvatar} small />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <Link
                      to={`/profile/${c.userId}`}
                      className="unfrost text-sm font-semibold text-primary transition hover:underline"
                    >
                      {c.userName || "Unknown"}
                    </Link>
                    <span className="text-[10px] uppercase tracking-wider text-muted">
                      {timeAgo(c.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm leading-snug text-primary">
                    {c.text}
                  </p>
                  {token && (
                    <button
                      type="button"
                      onClick={() => openCommentForm(c.id)}
                      className="unfrost mt-1 text-[11px] font-medium uppercase tracking-wider text-muted transition hover:text-accent"
                    >
                      Reply
                    </button>
                  )}
                </div>
                {isMine && (
                  <button
                    type="button"
                    onClick={() => removeComment(c.id)}
                    className="icon-btn-ghost flex-none opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Delete comment"
                  >
                    <CloseIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          };

          return (
            <ul className="space-y-5">
              {topLevel.map((c) => {
                const replies = (repliesByParent[c.id] || []).sort(
                  (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
                );
                return (
                  <li key={c.id} className="space-y-3">
                    {/* Parent comment */}
                    <ul className="space-y-4">
                      {renderComment(c, false)}
                    </ul>

                    {/* Replies — indented + left-bordered for visual grouping */}
                    {replies.length > 0 && (
                      <ul className="ml-6 space-y-4 border-l border-black/10 pl-4 dark:border-white/10">
                        {replies.map((r) => renderComment(r, true))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          );
        })()}
      </section>

      {commentFormOpen && token && (
        <CommentBubble
          user={profile?.user}
          replyToName={
            replyParentId
              ? comments.find((c) => c.id === replyParentId)?.userName || null
              : null
          }
          value={commentText}
          onChange={setCommentText}
          onSubmit={async () => {
            await submitComment({ preventDefault: () => {} });
            setCommentFormOpen(false);
          }}
          onCancel={() => {
            setCommentFormOpen(false);
            setCommentText("");
            setReplyParentId(null);
          }}
          busy={commentBusy}
          error={error}
        />
      )}
    </div>
  );
};

export default VideoPlayer;
