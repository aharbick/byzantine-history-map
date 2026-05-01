"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AnyEntity } from "./types";

/** Optional seek hint passed when starting an episode. Either an absolute
 * seconds value or a 0..1 fraction of the episode's duration (resolved when
 * the audio element reports `loadedmetadata`). */
export type AudioSeekHint =
  | { kind: "seconds"; value: number }
  | { kind: "progress"; value: number };

interface AppState {
  currentYear: number;
  setCurrentYear: (y: number) => void;
  selectedEntity: AnyEntity | null;
  selectEntity: (e: AnyEntity | null) => void;
  playingEpisode: number | null;
  /** Set/clear the playing episode. `seek` is consumed by the AudioPlayer
   * once on the next load — undefined means "resume wherever you were". */
  playEpisode: (n: number | null, seek?: AudioSeekHint) => void;
  /** One-shot seek hint for the current episode (consumed by the player). */
  pendingSeek: AudioSeekHint | null;
  consumePendingSeek: () => AudioSeekHint | null;
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
