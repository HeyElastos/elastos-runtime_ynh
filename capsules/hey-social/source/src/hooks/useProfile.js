import { useEffect, useState } from "react";

const AUTH_EVENT = "auth-changed";

const readProfile = () => {
  try {
    return JSON.parse(localStorage.getItem("profile") || "null");
  } catch {
    return null;
  }
};

// Subscribe-aware profile reader. Replaces the broken `useMemo([])` pattern
// that read localStorage once at mount and never updated when signin/logout
// rewrote it — that caused stale Landing/Home rendering after passkey signin.
export const useProfile = () => {
  const [profile, setProfile] = useState(readProfile);

  useEffect(() => {
    const refresh = () => setProfile(readProfile());
    // Same-tab updates: SignInModal + logout dispatch this custom event.
    window.addEventListener(AUTH_EVENT, refresh);
    // Cross-tab updates: the storage event fires on other tabs only, but
    // including it keeps everything consistent if the user signs in/out
    // in a second window.
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(AUTH_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return profile;
};

// Mutation helpers — wrap localStorage writes so callers don't forget to
// notify subscribers.
export const setProfile = (profile) => {
  if (profile == null) {
    localStorage.removeItem("profile");
  } else {
    localStorage.setItem("profile", JSON.stringify(profile));
  }
  window.dispatchEvent(new CustomEvent(AUTH_EVENT));
};

export const clearProfile = () => setProfile(null);
