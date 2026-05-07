"use client";

import clsx from "clsx";
import { useApp } from "@/lib/context";

/**
 * Standalone toggle for the karaoke transcript panel. Sits at the player's
 * right edge as a small circular button, only visible once an episode has
 * been selected (cued or playing). Pulls `playerExpanded` from context so
 * it slides flush with the player's current width — minimized 98px →
 * left ≈114, expanded 320px → left ≈336.
 */
export default function TranscriptButton() {
  const {
    playingEpisode,
    cuedEpisode,
    transcriptOpen,
    setTranscriptOpen,
    playerExpanded,
  } = useApp();

  const hasEpisode = (playingEpisode ?? cuedEpisode) != null;
  if (!hasEpisode) return null;

  return (
    <button
      type="button"
      data-byz-tour="transcript-button"
      onClick={() => setTranscriptOpen(!transcriptOpen)}
      aria-pressed={transcriptOpen}
      aria-label={
        transcriptOpen ? "Hide transcript" : "Show transcript"
      }
      title={
        transcriptOpen
          ? "Hide transcript"
          : "Show transcript — synced to the audio, click any line to jump"
      }
      className={clsx(
        "absolute z-30 flex items-center justify-center w-9 h-9 rounded-full border transition-colors",
        // Subtler than the search FAB: faint backdrop + thin gold ring
        // that only saturates on hover. When the panel is open, the
        // button switches to a filled gold chip so the toggle state
        // reads at a glance.
        transcriptOpen
          ? "bg-byz-goldLight border-byz-gold text-byz-ink"
          : "bg-byz-purpleDeep/55 border-byz-gold/35 text-byz-goldLight/85 hover:bg-byz-purpleDeep/85 hover:border-byz-gold/70 hover:text-byz-goldLight",
        // Position. Minimized: always 8 (left margin) + 98 (player) + 8 (gap)
        // = 114. Expanded: depends on the player's responsive width.
        //   • Mobile (< sm): the player shrinks to leave room — anchor the
        //     button to the right viewport edge with a matching 8px margin.
        //   • Desktop (>= sm): player is a fixed 320px → button at left=336.
        playerExpanded
          ? "right-2 sm:right-auto sm:left-[336px]"
          : "left-[114px]",
      )}
      // Match PLAYER_BOTTOM (112 in this branch) inside AudioPlayer so the
      // button sits on the player's vertical centerline.
      style={{ bottom: 112 + (40 - 36) / 2 }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* Document outline + transcript-style lines of varying length —
            reads as "lines of speech" without copying any one specific
            iconography too literally. */}
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </svg>
    </button>
  );
}
