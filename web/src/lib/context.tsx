"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AnyEntity } from "./types";

interface AppState {
  currentYear: number;
  setCurrentYear: (y: number) => void;
  selectedEntity: AnyEntity | null;
  selectEntity: (e: AnyEntity | null) => void;
  playingEpisode: number | null;
  playEpisode: (n: number | null) => void;
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
  const [playingEpisode, playEpisode] = useState<number | null>(null);
  const [filters, setFilters] = useState<KindFilter>({
    person: true,
    place: true,
    event: true,
  });

  const value = useMemo<AppState>(
    () => ({
      currentYear,
      setCurrentYear,
      selectedEntity,
      selectEntity,
      playingEpisode,
      playEpisode,
      filters,
      setFilters,
    }),
    [currentYear, selectedEntity, playingEpisode, filters],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}
