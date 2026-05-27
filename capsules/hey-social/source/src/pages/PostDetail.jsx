import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getPost } from "../api/auth";
import PostCard from "../components/PostCard";
import { useProfile } from "../hooks/useProfile";

const PostDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const profile = useProfile();
  const token = profile?.accessToken;

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await getPost(id, token);
        if (active) setPost(data.post);
      } catch (e) {
        if (active) {
          setError(e.response?.data?.message || "Post not found.");
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="unfrost inline-flex items-center gap-2 text-sm text-muted transition hover:text-primary"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
          <path d="M15.5 4.5 8 12l7.5 7.5 1.4-1.4L10.8 12l6.1-6.1z" />
        </svg>
        Back
      </button>

      {loading && (
        <div className="frosted-card overflow-hidden p-0 animate-fade-in">
          <div className="aspect-square image-skeleton" />
          <div className="space-y-2 p-4">
            <div className="h-3 w-3/4 rounded image-skeleton" />
            <div className="h-3 w-1/2 rounded image-skeleton" />
          </div>
        </div>
      )}

      {error && (
        <div className="frosted-card animate-fade-up p-8 text-center">
          <p className="text-sm text-red-400">{error}</p>
          <Link
            to="/"
            className="unfrost mt-4 inline-block rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text"
          >
            Back to feed
          </Link>
        </div>
      )}

      {post && (
        <div className="animate-fade-up">
          <PostCard
            post={post}
            currentUser={profile?.user}
            token={token}
            onChange={(updated) => setPost(updated)}
            onDelete={() => navigate("/")}
          />
        </div>
      )}
    </div>
  );
};

export default PostDetail;
