import { useState } from "react";
import { MediaPlayer, MediaProvider } from "@vidstack/react";
import {
  defaultLayoutIcons,
  DefaultVideoLayout,
} from "@vidstack/react/player/layouts/default";

import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";

// Hey's main video player — Vidstack with the default video layout. Falls
// back to a placeholder if the source fails to load (same UX as SafeVideo).
const HeyVideoPlayer = ({ src, title, autoPlay = false, className = "" }) => {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className="flex aspect-video w-full items-center justify-center bg-gradient-to-br from-indigo-500 via-fuchsia-600 to-rose-500 text-sm text-white">
        Video unavailable
      </div>
    );
  }

  return (
    <MediaPlayer
      key={src}
      src={{ src, type: "video/mp4" }}
      title={title}
      autoPlay={autoPlay}
      playsInline
      onError={() => setFailed(true)}
      className={`vds-player aspect-video w-full bg-black ${className}`}
    >
      <MediaProvider />
      <DefaultVideoLayout icons={defaultLayoutIcons} />
    </MediaPlayer>
  );
};

export default HeyVideoPlayer;
