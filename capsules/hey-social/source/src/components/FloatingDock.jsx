import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  listNotifications,
  markNotificationsRead,
} from "../api/auth";
import {
  BellIcon,
  ChatIcon,
  HomeIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
} from "./icons";
import NotificationPanel from "./NotificationPanel";
import SearchModal from "./SearchModal";
import { useProfile } from "../hooks/useProfile";

const FloatingDock = ({ onClose }) => {
  const profile = useProfile();
  const token = profile?.accessToken;
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mode, setMode] = useState(
    () => localStorage.getItem("mode") || "photo"
  );

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === "mode" && e.newValue) setMode(e.newValue);
    };
    const onModeChange = (e) => {
      if (e.detail) setMode(e.detail);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("modechange", onModeChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("modechange", onModeChange);
    };
  }, []);

  const feedPath = mode === "video" ? "/videos" : "/";

  const [tokenRejected, setTokenRejected] = useState(false);

  const fetchNotifs = useCallback(async () => {
    if (!token) return "skip";
    try {
      const data = await listNotifications(token);
      setNotifications(data.notifications || []);
      return "ok";
    } catch (err) {
      if (err?.response?.status === 401 || err?.response?.status === 403) {
        setTokenRejected(true);
        return "stop";
      }
      return "error";
    }
  }, [token]);

  useEffect(() => {
    if (!token || tokenRejected) return;
    let cancelled = false;
    let interval;
    (async () => {
      const result = await fetchNotifs();
      if (cancelled || result === "stop") return;
      interval = setInterval(fetchNotifs, 30000);
    })();
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [token, tokenRejected, fetchNotifs]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  );

  const handleOpen = async () => {
    setOpen(true);
    if (unreadCount > 0 && token) {
      try {
        await markNotificationsRead(token);
        setNotifications((current) =>
          current.map((n) => ({ ...n, read: true }))
        );
      } catch {
        /* noop */
      }
    }
  };

  return (
    <>
      <aside className="floating-dock rounded-[2rem] shadow-2xl shadow-slate-950/40">
        <nav className="flex flex-col items-stretch gap-1 p-2">
          <Link
            to={feedPath}
            onClick={onClose}
            className="icon-btn h-12 w-12 mx-auto"
            title={mode === "video" ? "Video feed" : "Photo feed"}
            aria-label={mode === "video" ? "Video feed" : "Photo feed"}
          >
            <HomeIcon className="h-6 w-6" />
          </Link>

          <Link
            to="/posts"
            onClick={onClose}
            className="icon-btn h-12 w-12 mx-auto"
            title="New post"
            aria-label="New post"
          >
            <PlusIcon className="h-6 w-6" />
          </Link>

          <Link
            to="/chat"
            onClick={onClose}
            className="icon-btn h-12 w-12 mx-auto"
            title="Chat"
            aria-label="Chat"
          >
            <ChatIcon className="h-6 w-6" />
          </Link>

          <Link
            to="/profile"
            onClick={onClose}
            className="icon-btn h-12 w-12 mx-auto"
            title="Profile"
            aria-label="Profile"
          >
            <UserIcon className="h-6 w-6" />
          </Link>

          <button
            type="button"
            onClick={handleOpen}
            className="icon-btn relative h-12 w-12 mx-auto"
            title="Notifications"
            aria-label={
              unreadCount > 0
                ? `Notifications (${unreadCount} unread)`
                : "Notifications"
            }
          >
            <BellIcon className="h-6 w-6" />
            {unreadCount > 0 && (
              <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-[color:var(--body-bg)]">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="icon-btn h-12 w-12 mx-auto"
            title="Find user"
            aria-label="Find user"
          >
            <SearchIcon className="h-6 w-6" />
          </button>
        </nav>
      </aside>

      {open && (
        <NotificationPanel
          notifications={notifications}
          token={token}
          onClose={() => setOpen(false)}
          onChange={fetchNotifs}
        />
      )}

      {searchOpen && (
        <SearchModal token={token} onClose={() => setSearchOpen(false)} />
      )}
    </>
  );
};

export default FloatingDock;
