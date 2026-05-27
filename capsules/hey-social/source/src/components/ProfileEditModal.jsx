import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { updateProfile } from "../api/auth";
import { CameraIcon, CloseIcon } from "./icons";
import { SafeImage } from "./SafeMedia";
import { copyToClipboard } from "../utils/clipboard";

const BIO_MAX = 280;

const ProfileEditModal = ({ user, token, onClose, onSaved }) => {
  const fileInputRef = useRef(null);
  const [name, setName] = useState(user?.name || "");
  const [bio, setBio] = useState(user?.bio || "");
  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState(user?.avatar || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handler = (event) => {
      if (event.key === "Escape" && !busy) onClose?.();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [busy, onClose]);

  useEffect(() => {
    return () => {
      if (avatarFile && avatarPreview && avatarPreview.startsWith("blob:")) {
        URL.revokeObjectURL(avatarPreview);
      }
    };
  }, [avatarFile, avatarPreview]);

  const profileUrl = `${window.location.origin}/profile/${user?.id}`;

  const handlePickAvatar = () => fileInputRef.current?.click();

  const handleAvatarChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Avatar must be an image.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Avatar is over 10MB.");
      return;
    }
    setError(null);
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
    event.target.value = "";
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await updateProfile(
        { name, bio, avatar: avatarFile || undefined },
        token
      );
      onSaved?.(data.user);
      onClose?.();
    } catch (e) {
      setError(e.response?.data?.message || "Could not save profile.");
    } finally {
      setBusy(false);
    }
  };

  const handleCopyUrl = async () => {
    const ok = await copyToClipboard(profileUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const bioLen = bio.length;
  const initials = (name || user?.name || "?").slice(0, 2).toUpperCase();

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
            <h2 className="text-base font-semibold text-primary">Edit profile</h2>
            <p className="mt-1 text-xs text-muted">
              Update your photo, name, and bio. Share your QR for others to find you.
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

        {/* Avatar */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handlePickAvatar}
            disabled={busy}
            className="unfrost group relative h-20 w-20 overflow-hidden rounded-full bg-gradient-to-br from-accent to-amber-600 text-2xl font-black text-accent-text shadow-lg shadow-slate-900/30 ring-2 ring-white/20 transition hover:ring-white/40 disabled:opacity-50"
            aria-label="Upload avatar"
          >
            <SafeImage
              src={avatarPreview}
              alt=""
              fallback={
                <span className="flex h-full w-full items-center justify-center">
                  {initials}
                </span>
              }
              className="absolute inset-0 h-full w-full object-cover"
            />
            <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
              <CameraIcon className="h-6 w-6 text-white" />
            </span>
          </button>

          <div className="flex-1">
            <p className="text-sm font-medium text-primary">Profile photo</p>
            <p className="text-xs text-muted">Click the circle to upload. Square works best.</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarChange}
              className="hidden"
            />
          </div>
        </div>

        {/* Name */}
        <div className="space-y-1.5">
          <label className="text-xs uppercase tracking-wider text-muted">Display name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            maxLength={30}
            placeholder="Your name"
            className="frosted-input text-sm disabled:opacity-50"
          />
        </div>

        {/* Bio */}
        <div className="space-y-1.5">
          <label className="flex items-center justify-between text-xs uppercase tracking-wider text-muted">
            <span>Bio</span>
            <span className={bioLen > BIO_MAX ? "text-red-500 dark:text-red-400" : ""}>
              {bioLen}/{BIO_MAX}
            </span>
          </label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            disabled={busy}
            maxLength={BIO_MAX}
            rows={3}
            placeholder="Say something about yourself..."
            className="frosted-input text-sm disabled:opacity-50"
          />
        </div>

        {/* QR code */}
        <div className="rounded-2xl border border-black/10 bg-black/5 p-4 dark:border-white/15 dark:bg-white/5">
          <div className="flex items-center gap-4">
            <div className="rounded-xl bg-white p-2">
              <QRCodeSVG
                value={profileUrl}
                size={96}
                bgColor="#ffffff"
                fgColor="#0f172a"
                level="M"
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs uppercase tracking-wider text-accent">Share profile</p>
              <p className="mt-1 truncate text-xs text-muted">{profileUrl}</p>
              <button
                type="button"
                onClick={handleCopyUrl}
                disabled={busy}
                className="unfrost mt-2 rounded-full bg-black/10 px-3 py-1 text-xs text-primary transition hover:bg-black/15 disabled:opacity-50 dark:bg-white/5 dark:hover:bg-white/10"
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <p className="animate-fade-in text-sm text-red-500 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="unfrost rounded-full border border-black/10 bg-black/5 px-5 py-2 text-sm text-primary transition hover:bg-black/10 disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim() || bioLen > BIO_MAX}
            className="unfrost rounded-full bg-accent px-5 py-2 text-sm font-semibold text-accent-text shadow-lg shadow-slate-900/20 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
};

export default ProfileEditModal;
