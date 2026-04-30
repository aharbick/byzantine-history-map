"use client";

import { useApp } from "@/lib/context";
import { episodesById } from "@/lib/data";

export default function EpisodeChip({ episode }: { episode: number }) {
  const { playingEpisode, playEpisode } = useApp();
  const ep = episodesById[episode];
  if (!ep) return null;
  const playing = playingEpisode === episode;

  return (
    <button
      onClick={() => playEpisode(playing ? null : episode)}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-display tracking-wider transition-colors ${
        playing
          ? "bg-byz-gold text-byz-ink border-byz-gold"
          : "border-byz-gold/60 text-byz-goldLight hover:bg-byz-gold/20"
      }`}
      title={`${playing ? "Pause" : "Play"} — ${ep.title}`}
    >
      <span>{playing ? "❚❚" : "▶"}</span>
      <span>Ep {episode}</span>
    </button>
  );
}
