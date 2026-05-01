"use client";

import { useApp } from "@/lib/context";
import { episodesById } from "@/lib/data";

export default function EpisodeChip({
  episode,
  startProgress,
}: {
  episode: number;
  /** 0..1 fraction of the episode duration to seek to when starting from
   * this chip — the spot in the audio where this entity is first discussed.
   * Resolved by AudioPlayer once `audio.duration` is known. */
  startProgress?: number;
}) {
  const { playingEpisode, audioController } = useApp();
  const ep = episodesById[episode];
  if (!ep) return null;
  const playing = playingEpisode === episode;

  function onClick() {
    // Drive the audio element synchronously inside this click handler — iOS
    // Safari ignores play() calls that are deferred to a useEffect, so we
    // can't go through context state. AudioController.play() loads the
    // src, applies the seek hint, and calls play() in one go.
    audioController.current?.play(
      episode,
      startProgress != null
        ? { kind: "progress", value: startProgress }
        : undefined,
    );
  }

  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-display tracking-wider transition-colors ${
        playing
          ? "bg-byz-gold text-byz-ink border-byz-gold"
          : "border-byz-gold/60 text-byz-goldLight hover:bg-byz-gold/20"
      }`}
      // Once an episode is already loaded in the player, clicking the chip
      // doesn't pause — it re-jumps to the mention. Use a repeat glyph so the
      // affordance matches the action. Pausing/resuming is the player's job.
      title={`${playing ? "Replay from mention" : "Play"} — ${ep.title}`}
    >
      <span aria-hidden="true" className="inline-flex items-center justify-center">
        {playing ? (
          // Replay (circular arrow) at the same nominal size as the play
          // triangle below — both rendered as 11px-square SVGs so the chip
          // height stays steady whether or not it's the active episode.
          <svg viewBox="0 0 16 16" width="11" height="11">
            <path
              d="M3.5 8a4.5 4.5 0 1 0 1.4-3.27"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M5 2v3h3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="11" height="11">
            <path d="M4 3v10l9-5L4 3z" fill="currentColor" />
          </svg>
        )}
      </span>
      <span>Ep {episode}</span>
    </button>
  );
}
