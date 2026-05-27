import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { deletePost, getPosts } from "../api/auth";
import { TrashIcon } from "../components/icons";
import { SafeImage, SafeVideo } from "../components/SafeMedia";
import { useProfile } from "../hooks/useProfile";

const PlayBadge = () => (
  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/45 ring-1 ring-white/30 backdrop-blur-sm transition group-hover:scale-110">
      <svg viewBox="0 0 24 24" className="ml-0.5 h-6 w-6 fill-current text-white">
        <path d="M8 5v14l11-7z" />
      </svg>
    </div>
  </div>
);

const initials = (name) => (name || "?").slice(0, 2).toUpperCase();

const VideoCard = ({ post, currentUserId, token, onDeleted }) => {
  const cover = post.images?.[0];
  const isMine = currentUserId && post.userId === currentUserId;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleDelete = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Drop the legacy `!token` guard — capsule-mode deletePost auths
    // server-side via the caller's DID. Keeping isMine + busy.
    if (!isMine || busy) return;
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setBusy(true);
    try {
      await deletePost(post.id, token);
      onDeleted?.(post.id);
    } catch {
      setBusy(false);
    }
  };

  return (
    <Link
      to={`/v/${post.id}`}
      className="unfrost group block overflow-hidden rounded-[2rem] bg-transparent shadow-sm transition hover:-translate-y-1 hover:shadow-xl"
    >
      <div className="relative aspect-[4/5] overflow-hidden bg-black">
        {cover?.url ? (
          <SafeVideo
            src={cover.url}
            muted
            playsInline
            preload="metadata"
            fallback={
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-500 via-fuchsia-600 to-rose-500" />
            }
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-500 via-fuchsia-600 to-rose-500" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent" />
        <PlayBadge />

        {isMine && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            aria-label={confirming ? "Tap again to confirm delete" : "Delete video"}
            title={confirming ? "Tap again to delete" : "Delete video"}
            className={`absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border backdrop-blur-2xl transition disabled:opacity-50 ${
              confirming
                ? "border-red-500/60 bg-red-500/85 px-3 py-1.5 text-xs font-semibold text-white"
                : "border-white/25 bg-black/45 p-2 text-white opacity-0 group-hover:opacity-100"
            }`}
            style={{ WebkitBackdropFilter: "blur(24px)" }}
          >
            <TrashIcon className="h-4 w-4" />
            {confirming && <span>Confirm</span>}
          </button>
        )}
      </div>
      {/* Frosted-glass info panel — sits visually distinct under the video */}
      <div
        className="space-y-3 border-t border-white/10 bg-white/10 p-6 text-primary backdrop-blur-2xl dark:bg-white/[0.06]"
        style={{ WebkitBackdropFilter: "blur(28px)" }}
      >
        <div className="flex items-center gap-3">
          <SafeImage
            src={post.userAvatar}
            alt=""
            fallback={
              <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-amber-600 text-xs font-bold text-slate-900">
                {initials(post.userName)}
              </div>
            }
            className="h-8 w-8 flex-none rounded-full object-cover ring-1 ring-white/15"
          />
          <p className="text-sm uppercase tracking-[0.2em] text-muted">
            {post.userName || "Unknown"}
          </p>
        </div>
        <h3 className="line-clamp-2 text-base font-semibold leading-snug text-primary">
          {post.caption || "Untitled"}
        </h3>
        <span className="block w-full rounded-full bg-accent px-5 py-3 text-center text-sm font-semibold text-accent-text transition group-hover:bg-amber-300">
          Watch
        </span>
      </div>
    </Link>
  );
};

const Videos = () => {
  const profile = useProfile();
  const token = profile?.accessToken;
  const currentUserId = profile?.user?.id;

  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await getPosts(token);
        if (active) setPosts(data.posts || []);
      } catch {
        if (active) setError("Unable to load videos.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  const videos = useMemo(
    () => posts.filter((p) => p.images?.[0]?.type === "video"),
    [posts]
  );

  const handleDeleted = (id) => setPosts((cur) => cur.filter((p) => p.id !== id));

  if (loading) {
    return (
      <div className="grid gap-6 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="overflow-hidden rounded-[2rem] frosted-card shadow-sm"
          >
            <div className="aspect-[4/5] image-skeleton" />
            <div className="space-y-3 p-6">
              <div className="h-3 w-1/2 image-skeleton rounded" />
              <div className="h-4 w-3/4 image-skeleton rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="frosted-card p-8 text-center text-sm text-red-400">
        {error}
      </div>
    );
  }

  if (videos.length === 0) {
    return (
      <div className="frosted-card mx-auto max-w-md animate-fade-up p-10 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-white/10 text-accent">
          <svg viewBox="0 0 24 24" className="h-7 w-7 fill-current">
            <path d="M4 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm17 1.5-3 2.25v4.5l3 2.25V7.5Z" />
          </svg>
        </div>
        <p className="mt-4 text-lg font-semibold text-primary">No videos yet</p>
        <p className="mt-1 text-sm text-muted">
          Be the first to share a clip from your day.
        </p>
        {token && (
          <Link
            to="/posts"
            className="unfrost mt-5 inline-block rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text transition hover:bg-amber-300"
          >
            Share your first video
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        {videos.map((post) => (
          <VideoCard
            key={post.id}
            post={post}
            currentUserId={currentUserId}
            token={token}
            onDeleted={handleDeleted}
          />
        ))}
      </div>
    </div>
  );
};

export default Videos;
