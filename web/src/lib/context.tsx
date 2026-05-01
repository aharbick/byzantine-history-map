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
  filters: KindFilter;
  setFilters: (f: KindFilter) => void;
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
}: {
  children: ReactNode;
  initialYear: number;
}) {
  const [currentYear, setCurrentYear] = useState(initialYear);
  const [selectedEntity, selectEntity] = useState<AnyEntity | null>(null);
  const [playingEpisode, _setPlayingEpisode] = useState<number | null>(null);
  const [pendingSeek, setPendingSeek] = useState<AudioSeekHint | null>(null);
  const audioController = useRef<AudioController | null>(null);
  const [filters, setFilters] = useState<KindFilter>({
    person: true,
    place: true,
    event: true,
  });

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
      filters,
      setFilters,
    }),
    [currentYear, selectedEntity, playingEpisode, pendingSeek, filters],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}
