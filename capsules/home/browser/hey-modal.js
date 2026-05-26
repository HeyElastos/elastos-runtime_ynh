// ─────────────────────────────────────────────────────────────────────
// hey-modal.js — frosted-glass replacements for native window.confirm /
// window.alert / window.prompt. Loaded BEFORE hey-welcome.js so any
// confirm() called from welcome flow paints the Hey style.
//
//   window.heyConfirm(msg, opts)  → Promise<boolean>
//   window.heyAlert(msg, opts)    → Promise<void>
//   window.heyPrompt(msg, opts)   → Promise<string | null>
//
// Also overrides window.confirm / .alert / .prompt to route through the
// styled versions. The override returns a SYNC value of `true`/`null`/``
// optimistically — any code that depends on the synchronous return
// should be updated to use the heyX async forms. (No third-party
// capsule code runs in this iframe scope — they get their own window.)
// ─────────────────────────────────────────────────────────────────────

(() => {
  const ROOT_ID = "hey-modal-root";

  const ensureRoot = () => {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.setAttribute("aria-live", "polite");
      document.body.appendChild(root);
    }
    return root;
  };

  // Inject styles once.
  const ensureStyles = () => {
    if (document.getElementById("hey-modal-styles")) return;
    const s = document.createElement("style");
    s.id = "hey-modal-styles";
    s.textContent = `
      #hey-modal-root {
        position: fixed; inset: 0;
        z-index: 999999;
        pointer-events: none;
      }
      .hey-modal-scrim {
        position: fixed; inset: 0;
        background: rgba(2, 9, 22, 0.55);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        opacity: 0;
        pointer-events: auto;
        animation: hey-modal-fade-in 0.18s ease-out forwards;
      }
      .hey-modal-card {
        position: fixed;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%) scale(0.96);
        max-width: 440px; min-width: 300px;
        padding: 28px 28px 22px;
        background: rgba(15, 23, 42, 0.78);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 1.25rem;
        backdrop-filter: blur(40px);
        -webkit-backdrop-filter: blur(40px);
        box-shadow:
          0 32px 80px rgba(2, 9, 22, 0.6),
          0 0 0 1px rgba(255, 255, 255, 0.04) inset;
        color: #f8fafc;
        font-family: "Inter", system-ui, sans-serif;
        opacity: 0;
        animation: hey-modal-pop-in 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      }
      .hey-modal-title {
        font-size: 16px; font-weight: 600;
        margin: 0 0 10px;
        letter-spacing: 0.01em;
      }
      .hey-modal-msg {
        margin: 0 0 22px;
        color: rgba(248, 250, 252, 0.78);
        font-size: 14px;
        line-height: 1.5;
      }
      .hey-modal-input {
        width: 100%;
        margin: 0 0 18px;
        padding: 10px 14px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 10px;
        color: #f8fafc;
        font: inherit;
        font-size: 14px;
        outline: none;
      }
      .hey-modal-input:focus {
        border-color: #d4b84b;
        box-shadow: 0 0 0 3px rgba(212, 184, 75, 0.22);
      }
      .hey-modal-actions {
        display: flex; gap: 10px; justify-content: flex-end;
      }
      .hey-modal-btn {
        padding: 9px 18px;
        border-radius: 999px;
        font: inherit; font-size: 13px; font-weight: 600;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.16);
        color: #f8fafc;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s, transform 0.1s;
      }
      .hey-modal-btn:hover {
        background: rgba(255, 255, 255, 0.12);
      }
      .hey-modal-btn:active { transform: scale(0.97); }
      .hey-modal-btn.primary {
        background: linear-gradient(135deg, #d4b84b 0%, #b4961c 100%);
        color: #020617;
        border-color: rgba(212, 184, 75, 0.85);
      }
      .hey-modal-btn.primary:hover {
        background: linear-gradient(135deg, #e3cb52 0%, #c1a223 100%);
      }
      .hey-modal-btn.danger {
        background: rgba(239, 68, 68, 0.18);
        border-color: rgba(239, 68, 68, 0.55);
        color: #fda4af;
      }
      .hey-modal-btn.danger:hover {
        background: rgba(239, 68, 68, 0.28);
      }
      @keyframes hey-modal-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      @keyframes hey-modal-pop-in {
        from { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
        to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
      .hey-modal-scrim.closing {
        animation: hey-modal-fade-in 0.16s ease-out reverse forwards;
      }
    `;
    document.head.appendChild(s);
  };

  const openModal = ({ title, message, input, confirmLabel, cancelLabel, danger }) => {
    return new Promise((resolve) => {
      ensureStyles();
      const root = ensureRoot();

      const scrim = document.createElement("div");
      scrim.className = "hey-modal-scrim";

      const card = document.createElement("div");
      card.className = "hey-modal-card";
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");

      if (title) {
        const h = document.createElement("h2");
        h.className = "hey-modal-title";
        h.textContent = title;
        card.appendChild(h);
      }
      const p = document.createElement("p");
      p.className = "hey-modal-msg";
      p.textContent = message;
      card.appendChild(p);

      let inputEl = null;
      if (input) {
        inputEl = document.createElement("input");
        inputEl.className = "hey-modal-input";
        inputEl.type = input.type || "text";
        inputEl.placeholder = input.placeholder || "";
        inputEl.value = input.default || "";
        card.appendChild(inputEl);
      }

      const actions = document.createElement("div");
      actions.className = "hey-modal-actions";

      const closeWith = (value) => {
        scrim.classList.add("closing");
        card.style.animation = "hey-modal-pop-in 0.18s ease-in reverse forwards";
        setTimeout(() => {
          scrim.remove();
          card.remove();
          resolve(value);
        }, 180);
      };

      if (cancelLabel) {
        const cancel = document.createElement("button");
        cancel.className = "hey-modal-btn";
        cancel.textContent = cancelLabel;
        cancel.addEventListener("click", () => closeWith(input ? null : false));
        actions.appendChild(cancel);
      }
      const ok = document.createElement("button");
      ok.className = "hey-modal-btn primary" + (danger ? " danger" : "");
      ok.textContent = confirmLabel || "OK";
      ok.addEventListener("click", () => closeWith(input ? inputEl.value : true));
      actions.appendChild(ok);

      card.appendChild(actions);
      root.appendChild(scrim);
      root.appendChild(card);

      // Escape closes (cancels)
      const onKey = (e) => {
        if (e.key === "Escape") closeWith(input ? null : false);
        if (e.key === "Enter" && document.activeElement === inputEl) ok.click();
      };
      document.addEventListener("keydown", onKey);
      const observer = new MutationObserver(() => {
        if (!document.body.contains(card)) {
          document.removeEventListener("keydown", onKey);
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => (inputEl || ok).focus(), 50);
      scrim.addEventListener("click", () => closeWith(input ? null : false));
    });
  };

  window.heyConfirm = (message, opts = {}) =>
    openModal({
      title: opts.title || "Confirm",
      message,
      confirmLabel: opts.confirmLabel || "OK",
      cancelLabel: opts.cancelLabel || "Cancel",
      danger: opts.danger,
    });

  window.heyAlert = (message, opts = {}) =>
    openModal({
      title: opts.title || "Notice",
      message,
      confirmLabel: opts.confirmLabel || "OK",
      cancelLabel: null,
    });

  window.heyPrompt = (message, opts = {}) =>
    openModal({
      title: opts.title || "Enter",
      message,
      input: { placeholder: opts.placeholder, default: opts.default, type: opts.type || "text" },
      confirmLabel: opts.confirmLabel || "OK",
      cancelLabel: opts.cancelLabel || "Cancel",
    });

  // Override native versions so any third-party `confirm(...)` in shell
  // code auto-uses the styled modal. These return a synchronous-looking
  // truthy value optimistically — code paths that depended on the actual
  // user choice need to be migrated to `await heyConfirm(...)`.
  // (Native iframe content gets its own window, so this only affects
  //  scripts running in the parent hey-home shell context.)
  const nativeConfirm = window.confirm;
  const nativeAlert   = window.alert;
  window.confirm = (msg) => { window.heyConfirm(msg); return true; };
  window.alert   = (msg) => { window.heyAlert(msg); };
  // Stash originals in case anything needs them
  window.__nativeConfirm = nativeConfirm;
  window.__nativeAlert   = nativeAlert;
})();
