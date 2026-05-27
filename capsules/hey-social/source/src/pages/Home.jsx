import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getPosts } from "../api/auth";
import PostCard from "../components/PostCard";
import { CameraIcon, ImageIcon } from "../components/icons";
import { useProfile } from "../hooks/useProfile";
import Landing from "./Landing";

const Home = () => {
  const profile = useProfile();
  const token = profile?.accessToken;

  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!profile) {
      setLoading(false);
      return;
    }
    let active = true;
    (async () => {
      try {
        const data = await getPosts(token);
        if (active) setPosts(data.posts || []);
      } catch (e) {
        if (active) setError("Unable to load feed.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [profile]);

  if (!profile) {
    return <Landing />;
  }

  const handleChange = (updated) => {
    setPosts((current) =>
      current.map((p) => (p.id === updated.id ? updated : p))
    );
  };

  const handleDelete = (id) => {
    setPosts((current) => current.filter((p) => p.id !== id));
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {loading && (
        <div className="space-y-6">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="frosted-card overflow-hidden p-0 animate-fade-in"
              style={{ animationDelay: `${i * 100}ms` }}
            >
              <div className="flex items-center gap-3 p-4">
                <div className="h-10 w-10 rounded-full image-skeleton" />
                <div className="space-y-2">
                  <div className="h-3 w-32 rounded image-skeleton" />
                  <div className="h-2 w-16 rounded image-skeleton" />
                </div>
              </div>
              <div className="aspect-square image-skeleton" />
              <div className="space-y-2 p-4">
                <div className="h-3 w-3/4 rounded image-skeleton" />
                <div className="h-3 w-1/2 rounded image-skeleton" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="frosted-card animate-fade-in p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {(() => {
        const photoPosts = posts.filter((post) => post.images?.[0]?.type !== "video");
        if (loading || error || photoPosts.length > 0) return null;
        return (
          <div className="frosted-card relative overflow-hidden animate-fade-up p-10 text-center">
            <div
              className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 bg-white/10 shadow-lg shadow-slate-900/20 backdrop-blur-xl dark:bg-white/[0.06]"
              style={{ WebkitBackdropFilter: "blur(20px)" }}
            >
              <CameraIcon className="h-7 w-7 text-accent" />
            </div>

            <h2 className="mt-5 logo-handwritten text-3xl text-primary sm:text-4xl">
              Your feed is empty
            </h2>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted">
              {token
                ? "Be the first to drop a photo. A view from your window, your morning coffee — anything counts. Your followers' feeds start with you."
                : "Sign in to see what your friends are sharing, and post your first photo to start your story."}
            </p>

            <div className="relative mt-6 inline-block">
              {/* Comic speech bubble cue */}
              <span
                aria-hidden="true"
                className="caret-cue absolute -top-3 -right-4 sm:-right-6 rounded-full border-2 border-slate-900 bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent-text shadow-[2px_2px_0_rgba(15,23,42,1)]"
              >
                Start here
              </span>
              <Link
                to={token ? "/posts" : "/signup"}
                style={{ backgroundColor: "rgb(34 197 94)" }}
                className="group inline-flex items-center gap-2 rounded-full border-2 border-green-600 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-green-900/30 transition hover:!bg-green-600"
              >
                {token ? "Share your first photo" : "Get started"}
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4 fill-none stroke-current stroke-[2] transition-transform duration-200 group-hover:translate-x-1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14M13 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          </div>
        );
      })()}

      {posts
        .filter((post) => post.images?.[0]?.type !== "video")
        .map((post, i) => (
          <div
            key={post.id}
            className="animate-fade-up"
            style={{ animationDelay: `${Math.min(i * 60, 360)}ms` }}
          >
            <PostCard
              post={post}
              currentUser={profile?.user}
              token={token}
              onChange={handleChange}
              onDelete={handleDelete}
            />
          </div>
        ))}
    </div>
  );
};

export default Home;
