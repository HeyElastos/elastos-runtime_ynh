import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { CloseIcon, QRIcon } from "./icons";
import { copyToClipboard } from "../utils/clipboard";

const QRBadge = ({ url, label = "Profile QR" }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const handleCopy = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`icon-btn ${open ? "is-active" : ""}`}
        aria-label={label}
        aria-expanded={open}
      >
        <QRIcon className="h-5 w-5" />
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4 animate-fade-in bg-black/35 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-label={label}
            className="h-fit w-full max-w-sm animate-pop-in space-y-4 rounded-3xl p-6 backdrop-blur-[80px] bg-white/95 ring-1 ring-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_40px_-10px_rgba(0,0,0,0.45)] dark:bg-neutral-900/95 dark:ring-white/15 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_18px_40px_-10px_rgba(0,0,0,0.65)]"
          >
            <header className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-primary">Profile QR</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="icon-btn-ghost"
                aria-label="Close"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </header>

            <div className="flex justify-center">
              <div className="rounded-2xl bg-white p-3">
                <QRCodeSVG
                  value={url}
                  size={240}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="M"
                />
              </div>
            </div>
            <p
              className="select-all break-all rounded-lg bg-black/10 px-3 py-2 text-center text-xs leading-snug text-primary/90 cursor-text dark:bg-white/5"
              onClick={(e) => {
                const range = document.createRange();
                range.selectNodeContents(e.currentTarget);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
              }}
              title="Click to select, then Ctrl+C"
            >
              {url}
            </p>
            <button
              type="button"
              onClick={handleCopy}
              className="unfrost w-full rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text transition hover:bg-amber-300"
            >
              {copied ? "Copied ✓" : "Copy link"}
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default QRBadge;
