import { useEffect, useRef, useState } from "react";
import { CloseIcon, PlusIcon } from "./icons";

const PHOTO_ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif", "image/gif"];
const VIDEO_ACCEPTED = ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"];

const ImageDropzone = ({ items, onChange, disabled = false, mode = "photo" }) => {
  const isVideo = mode === "video";
  const MAX_FILES = isVideo ? 1 : 12;
  const MAX_SIZE = isVideo ? 100 * 1024 * 1024 : 15 * 1024 * 1024;
  const ACCEPTED = isVideo ? VIDEO_ACCEPTED : PHOTO_ACCEPTED;
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    return () => {
      for (const item of items) {
        URL.revokeObjectURL(item.preview);
      }
    };
  }, [items]);

  const addFiles = (fileList) => {
    setError(null);
    const incoming = Array.from(fileList);
    const accepted = [];
    for (const file of incoming) {
      if (!ACCEPTED.includes(file.type)) {
        setError(`Unsupported file: ${file.name}`);
        continue;
      }
      if (file.size > MAX_SIZE) {
        setError(`${file.name} is too large`);
        continue;
      }
      accepted.push({
        id: `${file.name}-${file.lastModified}-${file.size}-${Math.random()}`,
        file,
        preview: URL.createObjectURL(file),
      });
    }

    const remaining = MAX_FILES - items.length;
    if (accepted.length > remaining) {
      setError(`Maximum ${MAX_FILES} ${isVideo ? "video" : "files"} per post`);
    }
    onChange([...items, ...accepted.slice(0, remaining)]);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragOver(false);
    if (disabled) return;
    if (event.dataTransfer.files?.length) addFiles(event.dataTransfer.files);
  };

  const remove = (id) => onChange(items.filter((item) => item.id !== id));

  const reorder = (from, to) => {
    if (from === to || from == null || to == null) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  const bringToFront = (id) => {
    const idx = items.findIndex((it) => it.id === id);
    if (idx <= 0) return;
    reorder(idx, 0);
  };

  const openPicker = () => !disabled && inputRef.current?.click();
  const canAddMore = items.length < MAX_FILES;
  const isEmpty = items.length === 0;

  // The visible top card + up to 2 photos peeking behind it.
  const stackBehind = items.slice(1, 3);

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(",")}
        multiple={!isVideo}
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = "";
        }}
        className="hidden"
      />

      {isEmpty ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={openPicker}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !disabled) {
              e.preventDefault();
              openPicker();
            }
          }}
          className={`relative flex cursor-pointer flex-col items-center justify-center rounded-[1.75rem] border-2 border-dashed p-8 text-center transition-all duration-300 ${
            dragOver
              ? "border-accent bg-accent/10 scale-[1.01]"
              : "border-surface-border bg-white/5 hover:bg-white/10"
          } ${disabled ? "pointer-events-none opacity-60" : ""}`}
        >
          <PlusIcon className="h-9 w-9 text-accent transition-transform duration-300" />
          <p className="mt-4 text-base font-semibold text-primary">
            {isVideo ? "Drop a video or click to upload" : "Drop images or click to upload"}
          </p>
          <p className="mt-1 text-sm text-muted">
            {isVideo
              ? "MP4, WebM, MOV · max 100MB"
              : `Up to ${MAX_FILES} photos · JPG, PNG, WebP, AVIF, HEIC · max 15MB each`}
          </p>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled && canAddMore) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`space-y-4 transition-all ${
            dragOver ? "rounded-2xl bg-accent/5 ring-2 ring-accent/40 p-2" : ""
          }`}
        >
          {/* iPhone-Photos-style stack preview — portrait aspect for video */}
          <div
            className={`relative mx-auto w-full max-w-[20rem] ${
              isVideo ? "aspect-[4/5]" : "aspect-square"
            }`}
          >
            {/* Back cards peeking out — rotated + offset */}
            {stackBehind.map((item, i) => {
              const depth = i + 1; // 1, 2
              const offset = depth * 10;
              const rotation = (depth % 2 === 0 ? -1 : 1) * (depth * 3);
              const scale = 1 - depth * 0.04;
              return (
                <div
                  key={item.id}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl bg-slate-800 shadow-xl ring-1 ring-black/20"
                  style={{
                    transform: `translate(${offset}px, ${offset}px) rotate(${rotation}deg) scale(${scale})`,
                    zIndex: 10 - depth,
                  }}
                >
                  {item.file.type.startsWith("video/") ? (
                    <video
                      src={item.preview}
                      className="h-full w-full object-cover"
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <img src={item.preview} alt="" className="h-full w-full object-cover" />
                  )}
                  <div className="absolute inset-0 bg-black/25" />
                </div>
              );
            })}

            {/* Top card — the active item */}
            <div
              draggable={!disabled}
              onDragStart={() => setDragIndex(0)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                reorder(dragIndex, 0);
                setDragIndex(null);
              }}
              className="group absolute inset-0 z-20 overflow-hidden rounded-3xl shadow-2xl ring-1 ring-white/10"
              style={{ zIndex: 20 }}
            >
              {items[0].file.type.startsWith("video/") ? (
                <video
                  src={items[0].preview}
                  className="h-full w-full object-contain bg-black"
                  muted
                  playsInline
                  autoPlay
                  loop
                  preload="metadata"
                  controls
                />
              ) : (
                <img
                  src={items[0].preview}
                  alt=""
                  className="h-full w-full object-cover"
                />
              )}
              {/* Count badge */}
              {items.length > 1 && (
                <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                    <path d="M4 5h12v12H4z" opacity=".5" />
                    <path d="M8 9h12v12H8z" />
                  </svg>
                  {items.length}
                </span>
              )}
              {/* Remove */}
              {!disabled && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(items[0].id);
                  }}
                  aria-label="Remove"
                  className="unfrost absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-md transition hover:bg-black/75"
                >
                  <CloseIcon className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Thumbnail strip: reorder by drag, tap to bring to front, X to remove */}
          {items.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {items.map((item, i) => (
                <button
                  key={item.id}
                  type="button"
                  draggable={!disabled}
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    reorder(dragIndex, i);
                    setDragIndex(null);
                  }}
                  onClick={() => bringToFront(item.id)}
                  className={`unfrost group relative h-14 w-14 flex-none overflow-hidden rounded-lg ring-2 transition ${
                    i === 0 ? "ring-accent" : "ring-transparent hover:ring-white/30"
                  }`}
                  title="Tap to bring to front · drag to reorder"
                >
                  {item.file.type.startsWith("video/") ? (
                    <video
                      src={item.preview}
                      className="h-full w-full object-cover"
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <img src={item.preview} alt="" className="h-full w-full object-cover" />
                  )}
                  {!disabled && (
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label="Remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(item.id);
                      }}
                      className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100"
                    >
                      <CloseIcon className="h-3 w-3" />
                    </span>
                  )}
                </button>
              ))}
              {canAddMore && !disabled && (
                <button
                  type="button"
                  onClick={openPicker}
                  aria-label="Add more"
                  className="unfrost flex h-14 w-14 flex-none items-center justify-center rounded-lg border-2 border-dashed border-surface-border bg-white/5 text-muted transition hover:border-accent hover:bg-white/10 hover:text-accent"
                >
                  <PlusIcon className="h-5 w-5" />
                </button>
              )}
              <span className="ml-1 flex-none text-xs text-muted">
                {items.length}/{MAX_FILES}
              </span>
            </div>
          )}

          {/* Single-photo "Add more" button, separate from stack */}
          {items.length === 1 && canAddMore && !disabled && (
            <button
              type="button"
              onClick={openPicker}
              className="unfrost mx-auto flex items-center gap-2 rounded-full border border-surface-border bg-white/5 px-4 py-2 text-xs font-medium text-primary transition hover:bg-white/10"
            >
              <PlusIcon className="h-4 w-4" />
              Add more
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="animate-fade-in text-sm text-red-400">{error}</p>
      )}
    </div>
  );
};

export default ImageDropzone;
