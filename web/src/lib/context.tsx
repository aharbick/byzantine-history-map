"use client";

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { AnyEntity } from "./types";

/** Optional seek hint passed when starting an episode. Either an absolute
 * seconds value or a 0..1 fraction of the episode's duration (resolved when
 * the audio element reports `loadedmetadata`). */
export type AudioSeekHint =
  | { kind: "seconds"; value: number }
  | { kind: "progress"; value: number };

/** Imperative API exposed by AudioPlayer through context. Calling these
 * synchronously from a click handler keeps audio.play() inside the user-
 * gesture window — required by iOS Safari to actually start playback.
 *
 * Going through the previous "set state, let the effect call play() later"
 * path silently failed on iPhone because the gesture window had already
 * closed by the time the effect ran. */
export interface AudioController {
  /** Load `ep` (if not already loaded), apply optional seek, and start
   * playback. Must be invoked synchronously from a user gesture. */
  play(ep: number, seek?: AudioSeekHint): void;
  /** Pause/resume the current track without changing episode. */
  toggle(): void;
  /** Open or collapse the expanded player UI. Used by the welcome tour
   * to stage the expanded view for the relevant tour step. */
  setExpanded(expanded: boolean): void;
  /** Load an episode into the player without starting playback (so the
   * tour can demonstrate the expanded view + the Sync timeline toggle
   * without auto-playing audio). */
  cueEpisode(ep: number | null): void;
  /** Seek the current track to absolute seconds. No-op if no episode is
   * loaded. Used by the karaoke transcript panel to jump to a tapped
   * segment without disturbing playback state otherwise. */
  seek(seconds: number): void;
  /** Subscribe to ~4Hz currentTime ticks. Returns an unsubscribe fn.
   * The transcript panel uses this to find the active segment without
   * routing audio.currentTime through React state (which would cause the
   * whole tree to re-render on every tick). */
  subscribeTime(cb: (t: number) => void): () => void;
}

/** Imperative handle the Search component registers with context. The
 * welcome tour uses it to open the panel and seed a sample query so
 * the user can see the search workflow without leaving the tour. */
export interface SearchController {
  setOpen(open: boolean): void;
  setQuery(query: string): void;
}

interface AppState {
  currentYear: number;
  setCurrentYear: (y: number) => void;
  selectedEntity: AnyEntity | null;
  selectEntity: (e: AnyEntity | null) => void;
  playingEpisode: number | null;
  /** Set/clear the playing episode. `seek` is consumed by the AudioPlayer
   * once on the next load — undefined means "resume wherever you were".
   * NOTE: prefer `audioController.current.play(ep, seek)` from inside a
   * click handler — that path actually starts audio on iOS. This setter
   * only updates state. */
  playEpisode: (n: number | null, seek?: AudioSeekHint) => void;
  /** One-shot seek hint for the current episode (consumed by the player). */
  pendingSeek: AudioSeekHint | null;
  consumePendingSeek: () => AudioSeekHint | null;
  /** Imperative audio handle. AudioPlayer assigns this on mount; consumers
   * (chip, picker option, prev/next button, play button) call
   * `.current?.play(ep, seek)` from inside their click handler. */
  audioController: MutableRefObject<AudioController | null>;
  /** Imperative search handle. Search registers itself on mount; the
   * welcome tour uses it to programmatically open the panel and seed a
   * query during the search step. */
  searchController: MutableRefObject<SearchController | null>;
  /** Auto-scrub lock — when true, audio playback won't drive the timeline
   * year. Toggled from the lock button in the timeline strip. */
  autoScrubLocked: boolean;
  setAutoScrubLocked: (b: boolean) => void;
  /** Entities currently being highlighted from playback. Each entry stays
   * for ~10s after its mention before the AudioPlayer prunes it; new
   * mentions are appended (not replacing), so dense sequences leave several
   * markers lit at once. WorldMap renders the union as emphasized markers.
   * Order = insertion (oldest → newest); the *last* entry is what drives
   * the timeline year and cluster expansion. */
  audioFocusEntityIds: string[];
  setAudioFocusEntityIds: (ids: string[]) => void;
  filters: KindFilter;
  setFilters: (f: KindFilter) => void;
  /** Whether the karaoke transcript panel is open. Toggled from the
   * standalone TranscriptButton sitting next to the player; the panel
   * fetches its episode-segment JSON from /segments/{ep}.json on demand. */
  transcriptOpen: boolean;
  setTranscriptOpen: (b: boolean) => void;
  /** Whether the audio player is showing its expanded UI vs. the
   * compact minimized chip. Hoisted into context so the standalone
   * TranscriptButton next to the player can position itself flush with
   * the player's current right edge (98px minimized vs. 320px expanded). */
  playerExpanded: boolean;
  setPlayerExpanded: (b: boolean) => void;
  /** Episode loaded into the audio player but not yet playing — set on
   * mount from the last-played localStorage entry, and replaced when
   * the welcome tour cues an episode. Hoisted alongside `playingEpisode`
   * so the TranscriptButton can show as soon as an episode is *selected*
   * (not just playing). */
  cuedEpisode: number | null;
  setCuedEpisode: (n: number | null) => void;
  /** Whether to render the Byzantine territory fill layer on the map.
   * Off by default while the feature is on a preview branch — this is
   * a "show me what's possible" demo, not a production feature yet. */
  empireOverlayOn: boolean;
  setEmpireOverlayOn: (b: boolean) => void;
}

export interface KindFilter {
  person: boolean;
  place: boolean;
  event: boolean;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({
  children,
  initialYear,
  initialSelectedEntity = null,
}: {
  children: ReactNode;
  initialYear: number;
  /** Pre-selected entity (e.g. when landing on /people/justinian-i so the
   * card opens immediately and the SSR'd metadata matches what the user
   * sees). UrlState's `?id=` restoration runs after mount and overrides
   * this if a query param is present, so deep-link query params win. */
  initialSelectedEntity?: AnyEntity | null;
}) {
  const [currentYear, setCurrentYear] = useState(initialYear);
  const [selectedEntity, selectEntity] = useState<AnyEntity | null>(
    initialSelectedEntity,
  );
  const [playingEpisode, _setPlayingEpisode] = useState<number | null>(null);
  const [pendingSeek, setPendingSeek] = useState<AudioSeekHint | null>(null);
  const audioController = useRef<AudioController | null>(null);
  const searchController = useRef<SearchController | null>(null);
  const [autoScrubLocked, setAutoScrubLocked] = useState(false);
  const [audioFocusEntityIds, setAudioFocusEntityIds] = useState<string[]>([]);
  const [filters, setFilters] = useState<KindFilter>({
    person: true,
    place: true,
    event: true,
  });
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [playerExpanded, setPlayerExpanded] = useState(false);
  const [cuedEpisode, setCuedEpisode] = useState<number | null>(null);
  const [empireOverlayOn, setEmpireOverlayOn] = useState(false);

  const playEpisode = (n: number | null, seek?: AudioSeekHint) => {
    _setPlayingEpisode(n);
    setPendingSeek(seek ?? null);
  };
  const consumePendingSeek = () => {
    const s = pendingSeek;
    if (s) setPendingSeek(null);
    return s;
  };

  const value = useMemo<AppState>(
    () => ({
      currentYear,
      setCurrentYear,
      selectedEntity,
      selectEntity,
      playingEpisode,
      playEpisode,
      pendingSeek,
      consumePendingSeek,
      audioController,
      searchController,
      autoScrubLocked,
      setAutoScrubLocked,
      audioFocusEntityIds,
      setAudioFocusEntityIds,
      filters,
      setFilters,
      transcriptOpen,
      setTranscriptOpen,
      playerExpanded,
      setPlayerExpanded,
      cuedEpisode,
      setCuedEpisode,
      empireOverlayOn,
      setEmpireOverlayOn,
    }),
    [
      currentYear,
      selectedEntity,
      playingEpisode,
      pendingSeek,
      autoScrubLocked,
      audioFocusEntityIds,
      filters,
      transcriptOpen,
      playerExpanded,
      cuedEpisode,
      empireOverlayOn,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}
