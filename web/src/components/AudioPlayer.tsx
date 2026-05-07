"use client";

import { useEffect, useRef, useState } from "react";
import { useApp, type AudioSeekHint } from "@/lib/context";
import { audioUrl, episodesById, peopleById } from "@/lib/data";
import { entities } from "@/lib/data";
import { findAnchorsAt, getEpisodeAnchors } from "@/lib/episode_anchors";

/** Persistent audio player. Always mounted, always visible. Custom UI so it
 * fits the byzantine theme rather than the chunky native <audio controls>. */
export default function AudioPlayer() {
  const {
    playingEpisode,
    playEpisode,
    audioController,
    currentYear,
    setCurrentYear,
    selectedEntity,
    autoScrubLocked,
    setAutoScrubLocked,
    audioFocusEntityIds,
    setAudioFocusEntityIds,
    playerExpanded,
    setPlayerExpanded,
    cuedEpisode,
    setCuedEpisode,
  } = useApp();
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
  // Playback rate. Lazy initializer reads localStorage so the user's
  // preferred speed survives reload without a one-frame flash at 1x.
  const [playbackRate, setPlaybackRate] = useState<number>(() =>
    typeof window === "undefined" ? 1 : readSavedRate() ?? 1,
  );
  // Compact mode: shows just episode label + play button + time. Click
  // anywhere except the play button restores the full UI. Default to
  // collapsed — the player is a peripheral surface, not the user's
  // primary task; expanding is one click away when they want to choose.
  // State lives in context so the standalone TranscriptButton can
  // position itself at the player's right edge based on width.
  const minimized = !playerExpanded;
  const setMinimized = (v: boolean) => setPlayerExpanded(!v);

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

  // Time subscribers — used by the karaoke transcript panel to follow
  // audio.currentTime without churning React state on every ~4Hz tick.
  // Set is keyed by the callback identity so consumers' cleanup just
  // removes themselves directly.
  const timeSubscribersRef = useRef<Set<(t: number) => void>>(new Set());

  // Re-apply the playback rate whenever it changes, AND whenever a new
  // episode loads — `audio.load()` may reset the rate back to 1x on
  // some browsers, so re-applying after episode change keeps the
  // user's selection sticky across track changes.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.playbackRate = playbackRate;
  }, [playbackRate, playingEpisode, cuedEpisode]);

  function cyclePlaybackRate() {
    const idx = PLAYBACK_RATES.indexOf(playbackRate);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
    writeSavedRate(next);
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
      setExpanded: (expanded: boolean) => setMinimized(!expanded),
      cueEpisode: (ep: number | null) => setCuedEpisode(ep),
      seek: (seconds: number) => {
        const a = audioRef.current;
        if (!a) return;
        if (!Number.isFinite(seconds) || seconds < 0) return;
        a.currentTime = seconds;
      },
      subscribeTime: (cb) => {
        timeSubscribersRef.current.add(cb);
        return () => {
          timeSubscribersRef.current.delete(cb);
        };
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
    const onTime = () => {
      setCurrentTime(a.currentTime);
      // Fan out to transcript subscribers (and any other subscribers) so
      // the karaoke panel can follow currentTime without us routing it
      // through React state — re-rendering the whole tree at 4Hz tanks
      // marker performance.
      const subs = timeSubscribersRef.current;
      if (subs.size > 0) {
        for (const cb of subs) cb(a.currentTime);
      }
    };
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

  // ---------- one-time snap to the episode's ruler reign ----------
  // When sync-timeline is on and an episode is loaded, jump the cursor
  // ONCE to the midpoint of the ruler's reign — that places the
  // protagonist visually in the middle of the timeline rather than at
  // the very start of their bar. The cursor stays put after that — we
  // don't follow per-mention narration (which would yank the cursor out
  // of the protagonist's era whenever the host mentions an earlier or
  // later figure). Markers still pulse from audioFocusEntityIds, and the
  // force-render mechanism makes out-of-era references show up on the
  // map for their decay window without disturbing the timeline.
  //
  // Re-snaps are gated by an episode-id key so manual scrubs after the
  // initial snap aren't fought by this effect. Toggling sync off and on
  // again re-snaps; toggling it off doesn't move the cursor.
  const snappedEpisodeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoScrubLocked) {
      snappedEpisodeKeyRef.current = null;
      return;
    }
    if (playingEpisode == null) return;
    const key = String(playingEpisode);
    if (snappedEpisodeKeyRef.current === key) return;
    const ep = episodesById[playingEpisode];
    const ruler = ep?.ruler_id ? peopleById[ep.ruler_id] : null;
    if (!ruler || ruler.reign_start == null) return;
    const target =
      ruler.reign_end != null
        ? (ruler.reign_start + ruler.reign_end) / 2
        : ruler.reign_start;
    setCurrentYear(target);
    snappedEpisodeKeyRef.current = key;
  }, [playingEpisode, autoScrubLocked, setCurrentYear]);

  // ---------- audio-driven marker focus ----------
  // Drives the WorldMap's audio-focus markers from the audio's currentTime.
  // Disabled when:
  //   - the user has a card open (they're reading something specific)
  //   - sync timeline is off (explicit override)
  //   - the audio isn't actually playing
  // Refs sidestep stale-closure problems on the timeupdate listener while
  // still letting us read the latest gating values without re-binding the
  // listener every render (timeupdate fires ~4Hz on iOS).
  const autoScrubLockedRef = useRef(autoScrubLocked);
  autoScrubLockedRef.current = autoScrubLocked;
  const selectedEntityRef = useRef(selectedEntity);
  selectedEntityRef.current = selectedEntity;
  const audioFocusEntityIdsRef = useRef(audioFocusEntityIds);
  audioFocusEntityIdsRef.current = audioFocusEntityIds;
  const currentYearRef = useRef(currentYear);
  currentYearRef.current = currentYear;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingEpisode == null) return;

    const anchors = getEpisodeAnchors(playingEpisode);
    if (anchors.length === 0) return;

    // The episode's protagonist is already prominently displayed in the
    // ruler ribbon (large pinned portrait beside the year readout), so
    // pulsing their map marker every time their name comes up — which is
    // every few seconds in a podcast about them — reads as flicker rather
    // than information. Skip the protagonist's id when populating the
    // focus set; supporting cast still lights up normally.
    const rulerId = episodesById[playingEpisode]?.ruler_id ?? null;

    // Each highlighted entity stays lit this long after its mention; new
    // mentions don't replace older ones, they pile on. Dense sequences thus
    // produce a brief constellation of glowing markers rather than a single
    // strobing one.
    const FOCUS_STALE_AFTER_SEC = 6;
    // entityId → audio.currentTime when its window expires. Driven off
    // audio.currentTime (not wall clock) so seeking + pause behave: pausing
    // freezes the windows, scrubbing forward ages older entries out.
    const focusExpiry = new Map<string, number>();
    // Per-entity-segment "have we already pulsed this one" guard: a single
    // segment that mentions multiple entities should refresh all their
    // windows once on entry, then stay quiet until the segment changes.
    // Tracks (entityId, segmentIdx) pairs so different segment-mentions of
    // the same entity each re-pulse.
    const seenAnchorKeys = new Set<string>();

    const syncFocusState = () => {
      // Cheap structural compare so we don't churn React state when nothing
      // changed (timeupdate fires ~4Hz).
      const next = Array.from(focusExpiry.keys());
      const prev = audioFocusEntityIdsRef.current;
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) {
        return;
      }
      setAudioFocusEntityIds(next);
    };

    const onTimeForScrub = () => {
      if (audio.paused) return;
      if (autoScrubLockedRef.current) return;
      if (selectedEntityRef.current) return;

      const t = audio.currentTime;

      // Prune windows that have aged out. Done first so a freshly added
      // entity below isn't immediately culled by a stale entry.
      for (const [id, expiry] of focusExpiry) {
        if (t > expiry) focusExpiry.delete(id);
      }

      // Every entity whose segment-mention covers `t`. A single Whisper
      // segment regularly references several entities ("the True Cross in
      // Jerusalem") and each should light up its own marker.
      const active = findAnchorsAt(t, anchors);

      // Open a focus window for every newly-entered (entity, segment) pair
      // — but DON'T extend an existing window for the same entity.
      // "Justinian did X, then Justinian did Y" would otherwise keep the
      // marker lit for FOCUS_STALE_AFTER_SEC after every re-mention,
      // stacking up to a noticeably-long total. Original expiry holds;
      // the marker dismisses N seconds after the FIRST mention regardless
      // of how many follow-ups come within that window.
      const liveKeys = new Set<string>();
      for (const a of active) {
        if (a.entityId === rulerId) continue;
        const key = `${a.entityId}@${a.segmentIdx}`;
        liveKeys.add(key);
        if (!seenAnchorKeys.has(key)) {
          seenAnchorKeys.add(key);
          if (!focusExpiry.has(a.entityId)) {
            focusExpiry.set(a.entityId, t + FOCUS_STALE_AFTER_SEC);
          }
        }
      }
      // Drop seen-keys whose segments are no longer active so re-entering
      // the same segment later (after a seek backwards) re-pulses.
      for (const key of seenAnchorKeys) {
        if (!liveKeys.has(key)) seenAnchorKeys.delete(key);
      }

      // The timeline cursor stays anchored to the episode's ruler reign
      // (see the snap effect below). Per-mention scrubbing was confusing —
      // ep 4 (Constantine Pt 2) mentions Arius (~325) and Battle of Tours
      // (732) in the same episode; chasing each mention pulled the cursor
      // out of Constantine's era and dropped him out of the active-ruler
      // chip mid-narration. Markers still pulse via audioFocusEntityIds,
      // and out-of-era markers force-render thanks to that focus list, so
      // the visual story is intact without yanking the cursor around.

      syncFocusState();
    };

    audio.addEventListener("timeupdate", onTimeForScrub);
    return () => {
      audio.removeEventListener("timeupdate", onTimeForScrub);
    };
  }, [playingEpisode, setCurrentYear, setAudioFocusEntityIds]);

  // When playback stops, drop the focus markers so the WorldMap goes back
  // to its normal rendering.
  useEffect(() => {
    if (!isPlaying && audioFocusEntityIds.length > 0) {
      setAudioFocusEntityIds([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

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

  // `cuedEpisode` lives in context (see lib/context.tsx) so consumers
  // outside the player — namely the TranscriptButton sitting next to it —
  // can know the moment an episode is "selected" (cued from localStorage
  // or by the welcome tour) without waiting for the user to hit play.
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

  // The strips area is now its own region below the map (see
  // STRIPS_AREA_HEIGHT_PX in AppShell). Legend + Player live INSIDE the
  // map area, so their `bottom` is measured from the map's bottom edge —
  // no longer from the screen bottom.
  // Legend.bottom = 8, height ~96 with the Territory toggle row added in
  // the empire-overlay branch. Player.bottom = 8 + 96 + 8 = 112.
  const PLAYER_BOTTOM = 112;

  // The <audio> element MUST live outside the minimized/expanded conditional.
  // Putting one inside each branch causes React to unmount/remount the
  // element when toggling, throwing away the <source> children (and thus the
  // current playback position and event listeners). Keeping a single audio
  // node in a stable sibling slot lets us flip between the two UI shells
  // without losing audio state.
  const audioEl = <audio ref={audioRef} preload="metadata" />;

  if (minimized) {
    return (
      <>
        {audioEl}
        <button
          ref={rootRef as unknown as React.RefObject<HTMLButtonElement>}
          type="button"
          onClick={() => setMinimized(false)}
          title="Expand player"
          data-byz-tour="player"
          // Same footprint as the Legend below — fixed width and matching pad
          // so the two pills stack as a uniform pair. Click anywhere except
          // the play button expands the player.
          className="absolute z-30 left-2 flex flex-col items-start gap-0.5 rounded-2xl border border-byz-gold/60 bg-byz-purpleDeep/70 px-3 py-1 shadow-card font-display tracking-wider hover:bg-byz-purpleDeep/85 transition-colors text-left w-[98px]"
          style={{ bottom: PLAYER_BOTTOM }}
        >
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
      </>
    );
  }

  return (
    <>
      {audioEl}
      <div
        ref={rootRef}
        // Same fill as the Legend so they read as a vertical pair. Width grows
        // to accommodate the dropdown + transport row. On mobile the player
        // leaves a ~3.5rem reserve on the right so the standalone
        // TranscriptButton has room to sit beside it without overlapping.
        // Desktop stays a fixed 320px (sm:w-80).
        className="absolute z-30 left-2 flex flex-col gap-1.5 rounded-2xl border border-byz-gold/60 bg-byz-purpleDeep/70 px-3 py-2 shadow-card w-[calc(100vw-4rem)] sm:w-80"
        style={{ bottom: PLAYER_BOTTOM }}
        data-byz-tour="player"
      >
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

      {/* Row 3: transport buttons on the left, follow-audio toggle in the
          middle (only meaningful while an episode is playing), time on the
          right. Transcript toggle lives OUTSIDE the player as a sibling
          button (see TranscriptButton) so the player's interior layout
          stays untouched. */}
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
          <SpeedButton
            rate={playbackRate}
            onCycle={cyclePlaybackRate}
            disabled={!hasEpisode}
          />
        </div>
        {/* Sync icon + time grouped on the right so the chain icon
            reads as "this is the audio's relationship to the
            timeline", visually paired with the elapsed/total readout. */}
        <div className="flex items-center gap-2">
          {displayedEpisode != null && (
            <FollowAudioToggle
              on={!autoScrubLocked}
              onChange={(nextOn) => {
                setAutoScrubLocked(!nextOn);
                if (!nextOn) setAudioFocusEntityIds([]);
              }}
            />
          )}
          <span className="font-display text-[10px] tracking-wider text-byz-parchmentDark whitespace-nowrap tabular-nums">
            {timeText}
          </span>
        </div>
      </div>
      </div>
    </>
  );
}

/* Sync-timeline toggle. Compact icon-only pill matching the size of the
 * IconButton transport controls so the row stays single-line at the
 * 320px expanded-player width. State is shown by fill: gold-filled
 * means "on, timeline follows audio"; outline-only means "off".
 *
 * Wraps the button in a `group` so a custom hover tooltip can fade in
 * on desktop — the chain icon needs a label for new users since it
 * isn't otherwise self-explanatory. The native `title` attribute
 * stays in place as a fallback / mobile long-press hint. */
function FollowAudioToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (nextOn: boolean) => void;
}) {
  const label = on
    ? "Timeline follows audio — click to unsync"
    : "Click to sync timeline with audio";
  return (
    <span className="relative group">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        title={label}
        className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full border transition-colors ${
          on
            ? "bg-byz-goldLight border-byz-gold text-byz-ink hover:bg-byz-gold"
            : "bg-byz-ink/60 border-byz-gold/40 text-byz-goldLight/80 hover:text-byz-goldLight hover:border-byz-gold/70"
        }`}
      >
        {/* Chain link icon — universally reads as "linked / synced". */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
        </svg>
      </button>
      {/* Themed hover tooltip — fades in only when the user can hover
          (desktop). On touch devices, the native `title` long-press
          hint takes over. Positioned above the icon with a small
          arrow tail so it points back at the chain. pointer-events-none
          so the tooltip never intercepts clicks on the button itself. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden md:block opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150 whitespace-nowrap rounded-md border border-byz-gold/60 bg-byz-purpleDeep/95 px-2 py-1 text-[10px] font-display tracking-wider uppercase text-byz-goldLight shadow-card"
      >
        {label}
      </span>
    </span>
  );
}

/* Compact pill that cycles through PLAYBACK_RATES on click. Sized to
 * match the IconButtons in the transport cluster so it feels like a
 * fourth transport control rather than a separate widget. */
function SpeedButton({
  rate,
  onCycle,
  disabled,
}: {
  rate: number;
  onCycle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onCycle}
      disabled={disabled}
      title={
        disabled
          ? "Playback speed"
          : `Playback speed (${formatRate(rate)} — click to cycle)`
      }
      aria-label={`Playback speed: ${formatRate(rate)}. Click to cycle.`}
      // Fixed width sized to the widest label ("1.25×") so the
      // surrounding row layout never reflows when the user cycles
      // through rates. tabular-nums keeps even single-digit rates
      // visually centered.
      className={`shrink-0 inline-flex items-center justify-center w-[40px] h-6 rounded-full border text-[10px] font-display tracking-wider transition-colors tabular-nums ${
        disabled
          ? "bg-byz-ink/30 border-byz-gold/15 text-byz-parchmentDark/30 cursor-not-allowed"
          : "bg-byz-ink/60 border-byz-gold/40 text-byz-goldLight hover:bg-byz-ink/80 hover:border-byz-gold/70 active:bg-byz-gold/30"
      }`}
    >
      {formatRate(rate)}
    </button>
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

/* Playback rates the speed button cycles through. Order chosen so the
 * first click goes faster (the common case — most listeners want to
 * speed up, not slow down) and the slow option lives at the end of the
 * cycle for occasional use. */
const PLAYBACK_RATES: number[] = [1, 1.25, 1.5, 2, 0.75];

function formatRate(r: number): string {
  // Trim trailing zeros so 1.0 -> "1×", 1.5 -> "1.5×".
  const s = String(r).replace(/\.?0+$/, "");
  return `${s}×`;
}

const STORAGE_KEY = "byz-audio-progress";
const LAST_EPISODE_KEY = "byz-audio-last-ep";
const RATE_KEY = "byz-audio-rate";

function readSavedRate(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RATE_KEY);
    if (!raw) return null;
    const v = Number(raw);
    // Defensive: only accept a value we'd actually cycle through, in
    // case some other code (or a future change) writes a stale rate.
    return PLAYBACK_RATES.includes(v) ? v : null;
  } catch {
    return null;
  }
}

function writeSavedRate(r: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RATE_KEY, String(r));
  } catch {
    /* ignore quota */
  }
}

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
