export type EntityKind = "person" | "place" | "event";

export interface RelatedRef {
  type: EntityKind;
  id: string;
}

export interface BaseEntity {
  id: string;
  name: string;
  alt_names: string[];
  /** Longest per-episode summary (legacy fallback). */
  summary: string;
  /** Claude-synthesized 2-3 sentence neutral summary that integrates all
   * per-episode mentions. Present when the entity appears in 2+ episodes
   * and `data/synthesize_summaries.py` has been run. Cards prefer this
   * when set; `summary` is the fallback for single-episode entities. */
  summary_synthesized?: string | null;
  summaries_by_episode: Record<string, string>;
  transcript_lines_by_episode: Record<string, [number, number][]>;
  episodes: number[];
  wikipedia_url: string | null;
  related: RelatedRef[];
}

export interface Person extends BaseEntity {
  role?: string | null;
  birth_year?: number | null;
  death_year?: number | null;
  reign_start?: number | null;
  reign_end?: number | null;
  portrait_url?: string | null;
  portrait_full_url?: string | null;
}

export interface Place extends BaseEntity {
  modern_name?: string | null;
  modern_country?: string | null;
  lat?: number | null;
  lng?: number | null;
  first_year?: number | null;
  image_url?: string | null;
  image_full_url?: string | null;
}

export interface HistoricalEvent extends BaseEntity {
  year?: number | null;
  end_year?: number | null;
  category?: string | null;
  location_id?: string | null;
  image_url?: string | null;
  image_full_url?: string | null;
}

export interface EpisodeMeta {
  episode: number;
  title: string;
  audio_file: string;
  transcript_file: string;
  total_transcript_lines: number;
}

export interface EntitiesData {
  episodes: EpisodeMeta[];
  people: Person[];
  places: Place[];
  events: HistoricalEvent[];
  stats: { people: number; places: number; events: number };
}

export type AnyEntity =
  | (Person & { kind: "person" })
  | (Place & { kind: "place" })
  | (HistoricalEvent & { kind: "event" });
