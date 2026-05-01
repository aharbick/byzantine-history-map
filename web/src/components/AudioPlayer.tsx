"use client";

import { useEffect, useRef, useState } from "react";
import { useApp, type AudioSeekHint } from "@/lib/context";
import { audioUrl, episodesById } from "@/lib/data";
import { entities } from "@/lib/data";

/** Persistent audio player. Always mounted, always visible. Custom UI so it
 * fits the byzantine theme rather than the chunky native <audio controls>. */
export default function AudioPlayer() {
  const { playingEpisode, playEpisode, audioController } = useApp();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Tracks which episode's audio is currently loaded into the <audio>
  // element. Lets us skip a destructive `a.load()` when the desired episode
  // is already there — important when promoting a "cued" episode (restored
  // from localStorage) into playback without re-fetching it.
  const loadedEpisodeRef = useRef<number | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  // Compact mode: shows just episode label + play button + time. Click
  // anywhere except the play button restores the full UI. Default to
  // collapsed — the player is a peripheral surface, not the user's
  // primary task; expanding is one click away when they want to choose.
  const [minimized, setMinimized] = useState(true);

  // Close the picker on outside click / Escape — same behavior as a native
  // <select>. Click on the player itself (including inside the listbox) is
  // ignored because the option button handler closes via onPick.
  useEffect(() => {
    if (!showPicker) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowPicker(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showPicker]);

  const episodes = entities.episodes;
  const episode = playingEpisode != null ? episodesById[playingEpisode] : null;
  const titleClean = episode
    ? episode.title.replace(/^Episode \d+ - /, "")
    : "Pick an episode";

  // Pre-roll for chip-driven seeks (line-ratio approximation tends to
  // overshoot the actual mention by 15-20s; subtracting a few seconds also
  // gives the listener context leading into the moment).
  const PROGRESS_SEEK_PREROLL_S = 20;

  // ---------- imperative audio API ----------
  // Every iOS-allowed play() must run inside the same task as a real user
  // gesture (click/touch). Going through React state -> useEffect breaks the
  // gesture chain — the effect runs in a microtask after render, by which
  // point Mobile Safari has already revoked playback authorization. So all
  // user-initiated play paths funnel through this synchronous helper, and
  // the [playingEpisode] effect below only handles the "no episode" cleanup.
  //
  // Source resolution: the GitHub Releases URL serves audio with
  // `Content-Type: application/octet-stream`, which Mobile Safari refuses to
  // play when set via `audio.src`. Adding a `<source type="audio/mpeg">`
  // child overrides the response type and lets iOS accept the bytes.
  function setAudioSource(a: HTMLAudioElement, ep: number) {
    while (a.firstChild) a.removeChild(a.firstChild);
    const src = document.createElement("source");
    src.src = audioUrl(ep);
    src.type = "audio/mpeg";
    a.appendChild(src);
    a.load();
  }

  function playNow(ep: number, seek?: AudioSeekHint) {
    const a = audioRef.current;
    if (!a) return;

    if (loadedEpisodeRef.current !== ep) {
      loadedEpisodeRef.current = ep;
      setAudioSource(a, ep);
    }

    // Try play() inline first — iOS attaches the user-gesture flag here. If
    // metadata isn't ready yet (just-set source), play() may reject; in that
    // case retry on `loadedmetadata`, which iOS treats as part of the
    // gesture chain because the load() that triggered it was gesture-init.
    const tryPlay = () => {
      const p = a.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          a.addEventListener(
            "loadedmetadata",
            () => {
              a.play().catch(() => {});
            },
            { once: true },
          );
        });
      }
    };
    tryPlay();

    if (seek) {
      const applySeek = () => {
        const target =
          seek.kind === "seconds"
            ? seek.value
            : Math.max(
                0,
                seek.value * (a.duration || 0) - PROGRESS_SEEK_PREROLL_S,
              );
        if (Number.isFinite(target) && (a.duration || 0) > 0) {
          a.currentTime = target;
        }
      };
      if ((a.duration || 0) > 0 && a.readyState >= 1) {
        applySeek();
      } else {
        a.addEventListener("loadedmetadata", applySeek, { once: true });
      }
    }

    playEpisode(ep);
    setCuedEpisode(null);
    writeLastEpisode(ep);
  }

  // Register the imperative controller for chip / external callers. Must
  // happen BEFORE any consumer uses it, so layout-effect (synchronous after
  // render) is safer than useEffect — though in practice AudioPlayer mounts
  // before EntityCard has had a chance to render an EpisodeChip.
  useEffect(() => {
    audioController.current = {
      play: playNow,
      toggle: () => {
        const a = audioRef.current;
        if (!a) return;
        if (a.paused) {
          a.play().catch(() => {});
        } else {
          a.pause();
        }
      },
    };
    return () => {
      audioController.current = null;
    };
    // playNow closes over playEpisode/audioRef which are stable refs/setters,
    // so a single registration is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- src cleanup when episode goes to null ----------
  // The src/load/play side of episode changes happens in playNow (above) so
  // it lands inside a user gesture. This effect only handles the "no episode"
  // case — pause and reset.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (playingEpisode == null) {
      a.pause();
      setIsPlaying(false);
    }
  }, [playingEpisode]);

  // ---------- restore last-saved position ----------
  // Fires from `loadedmetadata` for the currently-playing episode if there
  // was no explicit seek (chip / nav / picker callers handle their own
  // seeks inline via playNow).
  function applySeekOrRestore() {
    const a = audioRef.current;
    if (!a || playingEpisode == null) return;
    const saved = readSaved(playingEpisode);
    if (saved && Number.isFinite(saved) && saved > 1) {
      a.currentTime = saved;
    }
  }

  // (The previous pendingSeek-driven effect is gone — chip / picker / nav
  // clicks now go through `playNow` directly, which performs the seek inside
  // the user gesture instead of after a state -> effect round trip.)

  // ---------- audio element event wiring ----------
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => {
      setIsPlaying(false);
      // Persist position on pause too — the 5s interval below only writes
      // while playing, so without this the last position before a pause is
      // lost if the user closes the tab.
      if (playingEpisode != null && a.currentTime > 1) {
        writeSaved(playingEpisode, a.currentTime);
        writeLastEpisode(playingEpisode);
      }
    };
    const onTime = () => setCurrentTime(a.currentTime);
    const onMeta = () => {
      setDuration(a.duration || 0);
      applySeekOrRestore();
    };
    const onEnded = () => {
      // Continuous play: advance to the next episode in numeric order.
      // The `ended` event is gesture-equivalent on iOS, so playNow's play()
      // call here is allowed.
      if (playingEpisode == null) return;
      const next = episodes.find((e) => e.episode === playingEpisode + 1);
      if (next) {
        playNow(next.episode);
      } else {
        setIsPlaying(false);
      }
    };

    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnded);

    // If metadata already arrived BEFORE we attached the listener (cached
    // file, fast network), the loadedmetadata event won't fire again — call
    // it explicitly so duration + seek-restore still work.
    if (a.readyState >= 1 && a.duration > 0) {
      onMeta();
    }
    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("ended", onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingEpisode, episodes]);

  // ---------- localStorage persistence (every ~5s + on pagehide) ----------
  useEffect(() => {
    if (playingEpisode == null) return;
    const id = window.setInterval(() => {
      const a = audioRef.current;
      if (a && !a.paused && a.currentTime > 1) {
        writeSaved(playingEpisode, a.currentTime);
        writeLastEpisode(playingEpisode);
      }
    }, 5000);
    // pagehide is the reliable way to flush state on iOS Safari — beforeunload
    // and unload don't always fire when the user backgrounds the tab.
    const onPageHide = () => {
      const a = audioRef.current;
      if (a && a.currentTime > 1) {
        writeSaved(playingEpisode, a.currentTime);
        writeLastEpisode(playingEpisode);
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [playingEpisode]);

  // On first mount with no playing episode, default-select the most recently
  // played episode so the player has something cued without auto-playing.
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (playingEpisode != null) return;
    const last = readLastEpisode();
    if (last && episodesById[last]) {
      // Cue (don't auto-play): use <source type="audio/mpeg"> so Mobile
      // Safari accepts the GitHub Releases octet-stream response.
      const a = audioRef.current;
      if (!a) return;
      loadedEpisodeRef.current = last;
      setAudioSource(a, last);
      // With preload="metadata", duration is fetched automatically — but
      // also seed the saved time once it arrives so the scrubber lands at
      // the user's last position.
      const onLoaded = () => {
        setDuration(a.duration || 0);
        const saved = readSaved(last);
        if (saved && saved > 1) a.currentTime = saved;
        a.removeEventListener("loadedmetadata", onLoaded);
      };
      a.addEventListener("loadedmetadata", onLoaded);
      // Reflect in the title chip (we can't set playingEpisode without playing,
      // so use a local "cued episode" mirror state).
      setCuedEpisode(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Cued" — a local mirror of the episode we have loaded but aren't playing.
  // Only used when there's no playingEpisode in context (fresh load + saved
  // last episode). Once user presses play, we promote it via playEpisode().
  const [cuedEpisode, setCuedEpisode] = useState<number | null>(null);
  const displayedEpisode = playingEpisode ?? cuedEpisode;
  const displayedEp =
    displayedEpisode != null ? episodesById[displayedEpisode] : null;
  const displayedTitle = displayedEp
    ? displayedEp.title.replace(/^Episode \d+ - /, "")
    : "Pick an episode";

  // ---------- controls ----------
  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (playingEpisode == null && cuedEpisode != null) {
      // Promote cued -> playing via the imperative API (which fires play()
      // synchronously, satisfying iOS Safari's gesture rule).
      playNow(cuedEpisode);
      return;
    }
    if (a.paused) {
      a.play().catch(() => {});
    } else {
      a.pause();
    }
  }

  // <<: 1st click within ~1.5s = restart current episode; 2nd click = previous episode
  const lastBackTsRef = useRef(0);
  function onBack() {
    const a = audioRef.current;
    const ep = displayedEpisode;
    if (!a || ep == null) return;
    const now = Date.now();
    if (a.currentTime > 3 || now - lastBackTsRef.current > 1500) {
      a.currentTime = 0;
      lastBackTsRef.current = now;
      return;
    }
    const prev = episodes.find((e) => e.episode === ep - 1);
    if (prev) {
      playNow(prev.episode);
    }
  }

  function onForward() {
    const ep = displayedEpisode;
    if (ep == null) return;
    const next = episodes.find((e) => e.episode === ep + 1);
    if (next) {
      playNow(next.episode);
    }
  }

  function onScrub(fraction: number) {
    const a = audioRef.current;
    if (!a || !duration) return;
    a.currentTime = Math.max(0, Math.min(duration, fraction * duration));
  }

  // ---------- render ----------
  const progress = duration > 0 ? currentTime / duration : 0;
  const hasEpisode = displayedEpisode != null;
  const timeText = hasEpisode ? `${fmt(currentTime)} / ${fmt(duration)}` : "—";
  // Minimized-only labels. "Ep ??" + a "Select Episode" hint on the second
  // line preserves the widget silhouette while telling the user the chip is
  // a control, not a failure state.
  const epLabel = hasEpisode ? `Ep ${displayedEpisode}` : "Ep ??";
  const minimizedSubLabel = hasEpisode ? timeText : "Select Episode";

  // Stack from the bottom: timeline strip (h-24 → 96 px tall) → 8 px gap →
  // Legend (bottom: 104, ~74 px tall) → 8 px gap → player. Player.bottom =
  // legend.top + 8 = (104 + 74) + 8 = 186. Same 8 px gap above the strip,
  // between the two widgets, and (visually) above the player.
  const PLAYER_BOTTOM = 186;

  if (minimized) {
    return (
      <button
        ref={rootRef as unknown as React.RefObject<HTMLButtonElement>}
        type="button"
        onClick={() => setMinimized(false)}
        title="Expand player"
        // Same footprint as the Legend below — fixed width and matching pad
        // so the two pills stack as a uniform pair. Click anywhere except
        // the play button expands the player.
        className="absolute z-30 left-2 flex flex-col items-start gap-0.5 rounded-2xl border border-byz-gold/60 bg-byz-purpleDeep/70 px-3 py-1 shadow-card font-display tracking-wider hover:bg-byz-purpleDeep/85 transition-colors text-left w-[98px]"
        style={{ bottom: PLAYER_BOTTOM }}
      >
        <audio ref={audioRef} preload="metadata" />
        <div className="flex items-center justify-between gap-2 w-full">
          <span
            className={`text-sm ${hasEpisode ? "text-byz-goldLight" : "text-byz-parchmentDark"}`}
          >
            {epLabel}
          </span>
          <span
            // The play/pause is a nested button. stopPropagation so it
            // doesn't bubble up to the outer expand-on-click handler.
            role="button"
            aria-label={isPlaying ? "Pause" : "Play"}
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                togglePlay();
              }
            }}
            className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full border transition-colors ${
              !hasEpisode
                ? "bg-byz-ink/30 border-byz-gold/15 text-byz-parchmentDark/30 cursor-not-allowed"
                : "bg-byz-ink/60 border-byz-gold/40 text-byz-goldLight hover:bg-byz-ink/80 hover:border-byz-gold/70"
            }`}
          >
            <PlayPauseIcon playing={isPlaying} size={11} />
          </span>
        </div>
        <span
          className={`w-full text-center text-[10px] leading-none ${
            hasEpisode ? "text-byz-parchmentDark tabular-nums" : "text-byz-goldLight/80"
          }`}
        >
          {minimizedSubLabel}
        </span>
      </button>
    );
  }

  return (
    <div
      ref={rootRef}
      // Same fill as the Legend so they read as a vertical pair. Width grows
      // to accommodate the dropdown + transport row. left-3/sm:left-4 keeps
      // the expanded player flush with the Legend below at every breakpoint.
      className="absolute z-30 left-2 flex flex-col gap-1.5 rounded-2xl border border-byz-gold/60 bg-byz-purpleDeep/70 px-3 py-2 shadow-card w-[calc(100vw-1rem)] sm:w-80"
      style={{ bottom: PLAYER_BOTTOM }}
    >
      <audio ref={audioRef} preload="metadata" />

      {/* Minimize — bare ✕ glyph, no border/bg/hover. */}
      <button
        onClick={() => setMinimized(true)}
        aria-label="Minimize player"
        title="Minimize"
        className="absolute top-2 right-3 z-10 text-byz-parchmentDark text-sm leading-none"
      >
        ✕
      </button>

      {/* Row 1: dropdown spans full width — episode titles need the room.
          pr-5 reserves space so the chevron doesn't collide with the
          minimize button at the corner. */}
      <div className="relative min-w-0 pr-5">
        <button
          onClick={() => setShowPicker((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={showPicker}
          className={`w-full inline-flex items-center justify-between gap-1.5 rounded-md border border-byz-gold/40 bg-byz-ink/30 hover:bg-byz-ink/50 hover:border-byz-gold/60 transition-colors px-2 py-1.5 font-display text-sm tracking-wider text-left ${
            hasEpisode ? "text-byz-goldLight" : "text-byz-parchmentDark"
          }`}
          title="Choose episode"
        >
          <span className="truncate">
            {hasEpisode
              ? `Ep ${displayedEpisode}: ${displayedTitle}`
              : "Select episode..."}
          </span>
          <svg
            viewBox="0 0 12 12"
            width="10"
            height="10"
            aria-hidden="true"
            className={`shrink-0 transition-transform ${
              showPicker ? "rotate-180" : ""
            }`}
          >
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {showPicker && (
          <EpisodePicker
            episodes={episodes}
            current={displayedEpisode}
            onPick={(ep) => {
              setShowPicker(false);
              // Synchronous from inside the click handler so iOS counts
              // play() as gesture-initiated.
              playNow(ep);
            }}
          />
        )}
      </div>

      {/* Row 2: scrubber spans full width, inset on the left so the thumb
          at progress=0 lines up with the dropdown's left edge above. */}
      <div className="pl-1.5">
        <ProgressBar
          progress={progress}
          disabled={!hasEpisode || duration <= 0}
          onScrub={onScrub}
        />
      </div>

      {/* Row 3: transport buttons on the left, time on the right. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <IconButton
            onClick={onBack}
            disabled={!hasEpisode}
            label="Restart / previous episode"
          >
            {/* << — double chevron, distinct from the play triangle. */}
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M11 4 L7 8 L11 12 M7 4 L3 8 L7 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </IconButton>

          <IconButton
            onClick={togglePlay}
            disabled={!hasEpisode}
            label={isPlaying ? "Pause" : "Play"}
          >
            <PlayPauseIcon playing={isPlaying} size={12} />
          </IconButton>

          <IconButton
            onClick={onForward}
            disabled={!hasEpisode}
            label="Next episode"
          >
            {/* >> — double chevron. */}
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M5 4 L9 8 L5 12 M9 4 L13 8 L9 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </IconButton>
        </div>
        <span className="font-display text-[10px] tracking-wider text-byz-parchmentDark whitespace-nowrap tabular-nums">
          {timeText}
        </span>
      </div>
    </div>
  );
}

/* Tiny reusable play/pause glyph so the minimized button and the expanded
 * primary button share the same visual treatment at different sizes. */
function PlayPauseIcon({
  playing,
  size,
}: {
  playing: boolean;
  size: number;
}) {
  return playing ? (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <rect x="3" y="2" width="3.5" height="12" fill="currentColor" />
      <rect x="9.5" y="2" width="3.5" height="12" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <path d="M3 2v12l11-6L3 2z" fill="currentColor" />
    </svg>
  );
}

/* ---------- subcomponents ---------- */

function IconButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      // Dark filled surface so the gold icons read clearly. Uniform size for
      // all transport buttons — small so the dropdown stays the primary
      // control on the row.
      className={`shrink-0 flex items-center justify-center w-6 h-6 rounded-full border transition-colors ${
        disabled
          ? "bg-byz-ink/30 border-byz-gold/15 text-byz-parchmentDark/30 cursor-not-allowed"
          : "bg-byz-ink/60 border-byz-gold/40 text-byz-goldLight hover:bg-byz-ink/80 hover:border-byz-gold/70 active:bg-byz-gold/30"
      }`}
    >
      {children}
    </button>
  );
}

function ProgressBar({
  progress,
  disabled,
  onScrub,
}: {
  progress: number;
  disabled: boolean;
  onScrub: (fraction: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  function fractionFromEvent(clientX: number): number {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }

  return (
    // Wrapper extends the hit area vertically so fingers don't need to land
    // on the thin track. Visible track + thumb are kept slim.
    <div
      ref={ref}
      className={`relative h-2 flex items-center group ${
        disabled ? "opacity-40" : "cursor-pointer"
      }`}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        draggingRef.current = true;
        onScrub(fractionFromEvent(e.clientX));
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current) return;
        onScrub(fractionFromEvent(e.clientX));
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
    >
      <div className="relative w-full h-1 rounded-full bg-byz-ink/50">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-byz-goldLight"
          style={{ width: `${progress * 100}%` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-byz-goldLight ring-1 ring-byz-ink/80 shadow-sm transition-transform group-hover:scale-110"
          style={{ left: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}

function EpisodePicker({
  episodes,
  current,
  onPick,
}: {
  episodes: { episode: number; title: string }[];
  current: number | null;
  onPick: (ep: number) => void;
}) {
  return (
    // Two stacked bg layers (purpleDeep/70 outer + ink/30 on each option)
    // replicate the effective color of the select button below — so the
    // dropdown reads as a vertical extension of the same surface.
    <ul
      role="listbox"
      className="absolute bottom-full left-0 right-0 rounded-t-md border border-b-0 border-byz-gold/40 bg-byz-purpleDeep/70 shadow-card overflow-hidden max-h-64 overflow-y-auto byz-allow-scroll byz-scroll"
    >
      {episodes.map((ep) => {
        const active = ep.episode === current;
        const title = ep.title.replace(/^Episode \d+ - /, "");
        return (
          <li key={ep.episode} className="bg-byz-ink/30">
            <button
              role="option"
              aria-selected={active}
              onClick={() => onPick(ep.episode)}
              className={`w-full text-left px-2 py-1 text-xs sm:text-sm flex gap-2 items-baseline font-display tracking-wider transition-colors ${
                active
                  ? "text-byz-goldLight"
                  : "text-byz-parchment hover:bg-byz-gold/10 hover:text-byz-goldLight"
              }`}
            >
              {/* w-12 fits "Ep 10".."Ep 17" without wrapping at text-sm. */}
              <span className="w-12 shrink-0">Ep {ep.episode}</span>
              <span className="truncate">{title}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- helpers ---------- */

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const STORAGE_KEY = "byz-audio-progress";
const LAST_EPISODE_KEY = "byz-audio-last-ep";

function readSaved(ep: number): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, number>;
    const v = parsed[String(ep)];
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

function writeSaved(ep: number, t: number) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, number>;
    parsed[String(ep)] = t;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    /* ignore quota */
  }
}

function readLastEpisode(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_EPISODE_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function writeLastEpisode(ep: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_EPISODE_KEY, String(ep));
  } catch {
    /* ignore */
  }
}
