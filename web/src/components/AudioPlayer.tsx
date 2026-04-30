"use client";

import { useEffect, useRef } from "react";
import { useApp } from "@/lib/context";
import { audioUrl, episodesById } from "@/lib/data";

export default function AudioPlayer() {
  const { playingEpisode, playEpisode } = useApp();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (playingEpisode == null) {
      a.pause();
      return;
    }
    // The <source> child carries the URL declaratively; calling load() makes
    // the audio element re-read its children. Using <source type="audio/mpeg">
    // (instead of setting a.src directly) gives iOS Safari an explicit format
    // hint — it can refuse sources whose response Content-Type doesn't match
    // a known audio MIME, but a typed <source> sometimes nudges it into
    // playing octet-stream responses (e.g. GitHub Releases assets).
    a.load();
    a.play().catch(() => {
      /* autoplay can fail before user gesture; ignore */
    });
  }, [playingEpisode]);

  if (playingEpisode == null) return null;
  const ep = episodesById[playingEpisode];
  const src = audioUrl(playingEpisode);

  return (
    <div
      // Sits at the bottom-left, just to the right of the Legend pill, with
      // the same vertical anchor + roughly matching height.
      className="absolute z-30 flex flex-col gap-1.5 rounded-2xl border border-byz-gold/60 bg-byz-purpleDeep/95 px-3 py-2 shadow-card max-w-[calc(100vw-1.5rem)]"
      style={{ bottom: 110, left: 120 }}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="font-display text-xs sm:text-sm text-byz-goldLight tracking-wider truncate">
          Ep {ep.episode}: {ep.title.replace(/^Episode \d+ - /, "")}
        </div>
        <button
          onClick={() => playEpisode(null)}
          className="text-byz-parchmentDark hover:text-byz-goldLight shrink-0"
          aria-label="Close player"
        >
          ✕
        </button>
      </div>
      <audio
        ref={audioRef}
        controls
        preload="none"
        className="w-64 sm:w-72 h-8"
      >
        <source src={src} type="audio/mpeg" />
      </audio>
    </div>
  );
}
