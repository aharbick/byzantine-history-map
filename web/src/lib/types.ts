export type EntityKind = "person" | "place" | "event";

export interface RelatedRef {
  type: EntityKind;
  id: string;
}

/** Per-episode summary block: per-episode portrait + importance score +
 * timing for the entity's first mention in the episode. */
export interface EpisodeSummary {
  summary: string;
  score: number;
  mention_count: number;
  first_mention_seconds: number | null;
}

/** A single segment-level mention of an entity in a Whisper-segmented
 * transcript. `start`/`end` are seconds into the audio. */
export interface Mention {
  segment_idx: number;
  start: number;
  end: number;
  matched: string;
}

/** A representative verbatim excerpt taken from a mentioning segment. */
export interface Excerpt {
  segment_idx: number;
  start: number;
  end: number;
  text: string;
}

export interface BaseEntity {
  id: string;
  kind: EntityKind;
  name: string;
  alt_names: string[];
  wikipedia_url: string | null;
  wikipedia_extract?: string | null;
  image_url?: string | null;
  image_full_url?: string | null;

  /** Cross-episode synthesized 2-3 sentence summary. Falls back to the
   * longest per-episode summary if synthesis hasn't run yet. */
  summary: string;
  summaries_by_episode: Record<string, EpisodeSummary>;
  excerpts_by_episode?: Record<string, Excerpt[]>;
  mentions_by_episode?: Record<string, Mention[]>;

  episodes: number[];
  /** Highest per-episode score; useful for global filtering. */
  max_score: number;
  related: RelatedRef[];
}

export interface Person extends BaseEntity {
  kind: "person";
  /** True for the 12 podcast-titled rulers. */
  is_twelve_ruler?: boolean;
  /** Episode number that features this person as the protagonist
   * (e.g. Diocletian → 2). Only set on `is_twelve_ruler` rulers. */
  ruler_episode?: number;
  role?: string | null;
  birth_year?: number | null;
  death_year?: number | null;
  reign_start?: number | null;
  reign_end?: number | null;
}

export interface Place extends BaseEntity {
  kind: "place";
  modern_name?: string | null;
  modern_country?: string | null;
  lat?: number | null;
  lng?: number | null;
  first_year?: number | null;
}

export interface HistoricalEvent extends BaseEntity {
  kind: "event";
  year?: number | null;
  end_year?: number | null;
  category?: string | null;
  location_id?: string | null;
}

export interface EpisodeMeta {
  episode: number;
  title: string;
  audio_file: string;
  transcript_file: string;
  segments_file: string;
  duration_seconds: number;
  /** Set on the 12 ruler-focused episodes (e.g. ep 2 → "diocletian").
   * Continuation episodes inherit the same ruler_id (eps 4, 8, 9). */
  ruler_id: string | null;
}

export interface EntitiesData {
  version: number;
  episodes: EpisodeMeta[];
  /** Ordered ids of the 12 Byzantine rulers, by episode. */
  twelve_rulers: string[];
  people: Person[];
  places: Place[];
  events: HistoricalEvent[];
  stats: {
    people: number;
    places: number;
    events: number;
    with_wikipedia: number;
    with_image: number;
    with_synthesized_summary: number;
  };
}

export type AnyEntity = Person | Place | HistoricalEvent;
