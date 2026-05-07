"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { useApp } from "@/lib/context";
import { episodesById } from "@/lib/data";

interface SlimSegment {
  /** start seconds */
  s: number;
  /** end seconds */
  e: number;
  /** text */
  t: string;
}

/** Cached per episode so reopening the panel doesn't re-fetch. The slim
 * segment payloads are 20–60KB each — small enough to keep all 17 in memory
 * once the user wanders into a few episodes, but we still lazy-load. */
const segmentCache = new Map<number, SlimSegment[]>();

/**
 * Karaoke transcript panel.
 *
 * Mirrors the entity card on the OPPOSITE side of the screen (left on
 * desktop, full-screen on mobile) so both can be open at once. Subscribes
 * to the audio player's currentTime via `audioController.subscribeTime`,
 * highlights the active segment, and auto-scrolls to keep it centered.
 *
 * Click any segment to seek to its start (also resumes playback if paused
 * on iOS, since the click happens inside a user gesture).
 */
export default function Transcript() {
  const {
    transcriptOpen,
    setTranscriptOpen,
    playingEpisode,
    cuedEpisode,
    audioController,
  } = useApp();
  // Mirror the audio player's "displayedEpisode" — show transcript for
  // whichever episode is loaded, even before the user hits play.
  const episode = playingEpisode ?? cuedEpisode;
  const [segments, setSegments] = useState<SlimSegment[] | null>(null);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  // User-scroll lock: if the user manually scrolls the panel, stop
  // auto-centering until they re-engage by tapping a segment or until the
  // active segment leaves the viewport. Without this, every time the user
  // scrolls back to look at an earlier line, the next tick yanks them
  // forward again.
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastIdxRef = useRef<number>(-1);

  // Cached binary-search hint — most ticks the active segment is the same
  // as last tick, or the next one. Probing those first avoids a full bsearch
  // on every 250ms timeupdate.
  const lastQueriedIdxRef = useRef<number>(0);

  // Load slim segment JSON when the episode changes.
  useEffect(() => {
    if (episode == null) {
      setSegments(null);
      setActiveIdx(-1);
      return;
    }
    const cached = segmentCache.get(episode);
    if (cached) {
      setSegments(cached);
      return;
    }
    let cancelled = false;
    fetch(`/segments/${episode}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`segments ${episode}: HTTP ${r.status}`);
        return r.json() as Promise<SlimSegment[]>;
      })
      .then((data) => {
        if (cancelled) return;
        segmentCache.set(episode, data);
        setSegments(data);
      })
      .catch(() => {
        // Silently fail — the panel will show the loading message
        // indefinitely. Nothing actionable for the user; the audio still
        // works and they can close the panel.
        if (!cancelled) setSegments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [episode]);

  // Subscribe to currentTime ticks. Find the segment whose [s, e] window
  // contains t — start the search from the last hit since the next tick is
  // almost always still in the same segment (or the next one).
  useEffect(() => {
    if (!segments || segments.length === 0) return;
    const ctrl = audioController.current;
    if (!ctrl) return;
    return ctrl.subscribeTime((t) => {
      let i = lastQueriedIdxRef.current;
      if (i < 0 || i >= segments.length) i = 0;
      // Forward scan first — common case is "still in same seg or one ahead".
      if (segments[i].s <= t && t <= segments[i].e + 0.05) {
        // already correct
      } else if (
        i + 1 < segments.length &&
        segments[i + 1].s <= t &&
        t <= segments[i + 1].e + 0.05
      ) {
        i = i + 1;
      } else {
        // Fallback: binary search.
        let lo = 0;
        let hi = segments.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (segments[mid].e + 0.05 < t) lo = mid + 1;
          else if (segments[mid].s > t) hi = mid - 1;
          else {
            i = mid;
            break;
          }
        }
        // If no exact match (gap between segments), pick the segment whose
        // start is closest to t without being after it.
        if (lo > hi) {
          i = Math.max(0, Math.min(lo, segments.length - 1));
          if (i > 0 && segments[i].s > t) i = i - 1;
        }
      }
      lastQueriedIdxRef.current = i;
      if (i !== lastIdxRef.current) {
        lastIdxRef.current = i;
        setActiveIdx(i);
      }
    });
  }, [segments, audioController]);

  // Auto-center the active segment in the panel as audio plays.
  useEffect(() => {
    if (!transcriptOpen) return;
    if (!autoScroll) return;
    if (activeIdx < 0) return;
    const el = itemRefs.current[activeIdx];
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx, transcriptOpen, autoScroll]);

  // If the user manually scrolls the list, drop auto-scroll until they
  // tap a segment (which resets autoScroll = true).
  useEffect(() => {
    if (!transcriptOpen) return;
    const list = listRef.current;
    if (!list) return;
    let userScrolled = false;
    const onWheel = () => {
      userScrolled = true;
      setAutoScroll(false);
    };
    const onTouchMove = () => {
      userScrolled = true;
      setAutoScroll(false);
    };
    list.addEventListener("wheel", onWheel, { passive: true });
    list.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      list.removeEventListener("wheel", onWheel);
      list.removeEventListener("touchmove", onTouchMove);
      void userScrolled;
    };
  }, [transcriptOpen]);

  function handleSegmentClick(seg: SlimSegment) {
    audioController.current?.seek(seg.s);
    // Tapping a line means the user wants the panel to follow audio again.
    setAutoScroll(true);
  }

  const epMeta = episode != null ? episodesById[episode] : null;
  const epTitle = epMeta
    ? epMeta.title.replace(/^Episode \d+ - /, "")
    : "";

  return (
    <AnimatePresence>
      {transcriptOpen && (
        <motion.aside
          key="transcript"
          data-byz-tour="transcript-panel"
          initial={{ x: -40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -40, opacity: 0 }}
          transition={{ type: "spring", stiffness: 200, damping: 25 }}
          className={clsx(
            "fixed z-50 overflow-hidden card-frame shadow-card !border-l-8 !border-l-[#e7c873]",
            // Mobile: full-screen overlay, same idiom as the entity card.
            "inset-0 rounded-none",
            // Desktop: pinned to the left, mirror of the entity card on
            // the right. Same vertical band so they sit at matched
            // heights when both open.
            "sm:inset-auto sm:left-4 sm:top-32 sm:rounded-xl sm:w-[480px] sm:max-w-[40vw] sm:max-h-[calc(100vh-394px)]",
            "flex flex-col",
          )}
        >
          <div className="px-4 py-3 backdrop-blur-sm border-b border-byz-gold/30 flex items-start justify-between gap-2 shrink-0">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-byz-parchmentDark">
                Transcript
                {episode != null ? ` · Episode ${episode}` : ""}
              </div>
              <h2 className="font-display text-lg text-byz-goldLight leading-tight truncate">
                {epTitle || "No episode loaded"}
              </h2>
              {!autoScroll && episode != null && (
                <button
                  type="button"
                  onClick={() => {
                    setAutoScroll(true);
                    const el = itemRefs.current[activeIdx];
                    if (el)
                      el.scrollIntoView({ block: "center", behavior: "smooth" });
                  }}
                  className="mt-1 text-[10px] font-display tracking-widest uppercase text-byz-goldLight/70 hover:text-byz-goldLight"
                >
                  ↻ Follow audio
                </button>
              )}
            </div>
            <button
              onClick={() => setTranscriptOpen(false)}
              aria-label="Close transcript"
              className="text-byz-parchmentDark hover:text-byz-goldLight shrink-0"
            >
              ✕
            </button>
          </div>

          <div
            ref={listRef}
            className="flex-1 overflow-y-auto byz-scroll byz-allow-scroll px-3 py-2 font-body text-byz-parchment leading-relaxed"
          >
            {episode == null ? (
              <p className="text-sm text-byz-parchmentDark italic px-2 py-3">
                Pick an episode in the player to see its transcript.
              </p>
            ) : segments == null ? (
              <p className="text-sm text-byz-parchmentDark italic px-2 py-3">
                Loading transcript…
              </p>
            ) : segments.length === 0 ? (
              <p className="text-sm text-byz-parchmentDark italic px-2 py-3">
                Transcript unavailable for this episode.
              </p>
            ) : (
              <ol className="space-y-1">
                {segments.map((seg, i) => {
                  const isActive = i === activeIdx;
                  return (
                    <li key={i}>
                      <button
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        type="button"
                        onClick={() => handleSegmentClick(seg)}
                        title={`Jump to ${formatSeconds(seg.s)}`}
                        className={clsx(
                          "w-full text-left rounded px-2 py-1 text-sm transition-colors",
                          isActive
                            ? "bg-byz-gold/20 text-byz-goldLight font-medium"
                            : "text-byz-parchment/85 hover:bg-byz-gold/10 hover:text-byz-parchment",
                        )}
                      >
                        <span className="text-[10px] tabular-nums text-byz-parchmentDark/70 mr-2 align-baseline font-display tracking-wider">
                          {formatSeconds(seg.s)}
                        </span>
                        {seg.t}
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
