import raw from "@/data/entities.json";
import type {
  AnyEntity,
  EntitiesData,
  HistoricalEvent,
  Person,
  Place,
} from "./types";

export const entities = raw as unknown as EntitiesData;

export const peopleById: Record<string, Person> = Object.fromEntries(
  entities.people.map((p) => [p.id, p]),
);
export const placesById: Record<string, Place> = Object.fromEntries(
  entities.places.map((p) => [p.id, p]),
);
export const eventsById: Record<string, HistoricalEvent> = Object.fromEntries(
  entities.events.map((e) => [e.id, e]),
);
export const episodesById: Record<number, (typeof entities)["episodes"][number]> =
  Object.fromEntries(entities.episodes.map((ep) => [ep.episode, ep]));

/** Stable timeline year used to position an entity on the timeline & map. */
export function timelineYear(e: AnyEntity): number | null {
  switch (e.kind) {
    case "person":
      return e.reign_start ?? e.birth_year ?? null;
    case "place":
      return e.first_year ?? null;
    case "event":
      return e.year ?? null;
  }
}

/**
 * Whether to show an entity on the map at a given cursor year.
 *
 * Tight windows so the map shows the era around the cursor, not 1200 years of
 * accumulated dots.
 *
 * - Person: their lifetime (birth..death) or reign range, with small buffers.
 * - Place: ±50 from first appearance — places fade out of view long after they
 *   were introduced. Places with no first_year show only if a related person
 *   or event is currently active (i.e., the place is "in play").
 * - Event: ±50 around its year (or around its end_year for spanning events).
 */
const WINDOW = 50;

export function isActiveAt(e: AnyEntity, year: number): boolean {
  if (e.kind === "person") {
    const start = e.birth_year ?? e.reign_start;
    const end = e.death_year ?? e.reign_end;
    if (start != null && end != null) {
      return year >= start - 5 && year <= end + 10;
    }
    if (e.reign_start != null && e.reign_end != null) {
      return year >= e.reign_start - 5 && year <= e.reign_end + 10;
    }
    const y = timelineYear(e);
    return y != null && Math.abs(year - y) <= WINDOW;
  }

  if (e.kind === "place") {
    if (e.first_year != null) {
      return Math.abs(year - e.first_year) <= WINDOW;
    }
    // No date on the place — show it if any related person/event is currently active.
    return relatedAnyActive(e, year);
  }

  // event
  if (e.year == null) return false;
  if (e.end_year != null && e.end_year !== e.year) {
    return year >= e.year - 5 && year <= e.end_year + WINDOW;
  }
  return Math.abs(year - e.year) <= WINDOW;
}

function relatedAnyActive(e: AnyEntity, year: number): boolean {
  for (const r of e.related ?? []) {
    if (r.type === "person") {
      const p = peopleById[r.id];
      if (p && isActiveAt({ ...p, kind: "person" }, year)) return true;
    } else if (r.type === "event") {
      const ev = eventsById[r.id];
      if (ev && isActiveAt({ ...ev, kind: "event" }, year)) return true;
    }
  }
  return false;
}

export function tagged<T extends Person | Place | HistoricalEvent>(
  arr: T[],
  kind: AnyEntity["kind"],
): AnyEntity[] {
  return arr.map((e) => ({ ...e, kind }) as AnyEntity);
}

/** All entities tagged with their kind, sorted by timeline year (nulls last). */
export const allEntities: AnyEntity[] = [
  ...tagged(entities.people, "person"),
  ...tagged(entities.places, "place"),
  ...tagged(entities.events, "event"),
].sort((a, b) => {
  const ay = timelineYear(a);
  const by = timelineYear(b);
  if (ay == null && by == null) return 0;
  if (ay == null) return 1;
  if (by == null) return -1;
  return ay - by;
});

/** Year window the cursor can scrub through.
 *
 * We compute this from every entity that has a year, so all dots on the
 * timeline are reachable. Brownworth references some figures far outside the
 * Byzantine era (Solomon, Hannibal, even RFK) — they remain in the dataset and
 * are reachable, but are usually edge ticks rather than the focus.
 */
export function timelineBounds(): { min: number; max: number } {
  const years: number[] = [];
  for (const e of allEntities) {
    const y = timelineYear(e);
    if (y != null) years.push(y);
  }
  if (years.length === 0) return { min: 200, max: 1500 };
  return {
    min: Math.min(...years) - 10,
    max: Math.max(...years) + 10,
  };
}

/** A sensible starting year for the cursor — Diocletian, the conventional
 * starting point of the Byzantine narrative. Falls back to first emperor in
 * the dataset, then to bounds.min. */
export function defaultStartYear(): number {
  const dio = entities.people.find((p) => p.id === "diocletian");
  if (dio?.reign_start != null) return dio.reign_start;
  const emperors = entities.people.filter((p) => p.reign_start != null);
  if (emperors.length) {
    const earliestReign = Math.min(...emperors.map((p) => p.reign_start as number));
    return earliestReign;
  }
  return timelineBounds().min;
}

/** Look up an entity by id across kinds. */
export function getEntity(id: string): AnyEntity | undefined {
  if (peopleById[id]) return { ...peopleById[id], kind: "person" };
  if (placesById[id]) return { ...placesById[id], kind: "place" };
  if (eventsById[id]) return { ...eventsById[id], kind: "event" };
  return undefined;
}

/**
 * For event/person without a place, find the most relevant linked place id
 * so we can pin them on the map.
 */
export function entityPlaceId(e: AnyEntity): string | null {
  if (e.kind === "place") return e.id;
  if (e.kind === "event" && e.location_id) return e.location_id;
  const placeRef = e.related.find((r) => r.type === "place");
  return placeRef?.id ?? null;
}

export function entityCoords(e: AnyEntity): { lat: number; lng: number } | null {
  if (e.kind === "place" && e.lat != null && e.lng != null) {
    return { lat: e.lat, lng: e.lng };
  }
  const pid = entityPlaceId(e);
  if (!pid) return null;
  const place = placesById[pid];
  if (!place || place.lat == null || place.lng == null) return null;
  return { lat: place.lat, lng: place.lng };
}

/* ------------------------------------------------------------------------- *
 * Global coord groups + stable fan offsets.
 *
 * Many entities share a single lat/lng — Constantine, Hagia Sophia, Hippodrome,
 * etc. all resolve to Constantinople's coordinates. Without help the markers
 * stack on top of each other. We compute a STABLE per-entity offset (based on
 * the entity's id, not its position in the currently-active set) so that as
 * the user scrubs time, surviving markers don't shuffle around.
 *
 * Groups of size <= CLUSTER_THRESHOLD - 1 fan out individually around the
 * shared coord. Groups of size >= CLUSTER_THRESHOLD are clustered: we render
 * a single "+N" marker that the user can expand to show the spider/speed-dial.
 * ------------------------------------------------------------------------- */

export const CLUSTER_THRESHOLD = 5;
const FAN_RADIUS = 26; // all markers are now the same size disc
const SPIDER_RADIUS = 70; // when expanding a clustered group

export interface GroupMember {
  entity: AnyEntity;
  /** Stable index in the all-time group (sorted by id) */
  index: number;
  /** Total all-time entities sharing this coord (drives fan radius/spacing) */
  groupSize: number;
  /** Pixel offset to apply when rendering individually (size < threshold) */
  fanOffset: [number, number];
  /** Pixel offset when the group is expanded into a spider */
  spiderOffset: [number, number];
  /** Stable group key (rounded coord) */
  groupKey: string;
  /** Coord (resolved) */
  coords: { lat: number; lng: number };
}

const _members = new Map<string, GroupMember>(); // entity.id -> member
const _groupKeys = new Map<string, string[]>();  // groupKey -> list of entity.ids

(() => {
  // Bucket entities by rounded coord
  const buckets = new Map<string, AnyEntity[]>();
  for (const e of allEntities) {
    const c = entityCoords(e);
    if (!c) continue;
    const k = `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
    const list = buckets.get(k);
    if (list) list.push(e);
    else buckets.set(k, [e]);
  }

  for (const [groupKey, list] of buckets) {
    list.sort((a, b) => a.id.localeCompare(b.id));
    const groupSize = list.length;
    _groupKeys.set(groupKey, list.map((e) => e.id));
    list.forEach((e, i) => {
      const c = entityCoords(e)!;
      const fanOffset = computeOffset(i, groupSize, false);
      const spiderOffset = computeOffset(i, groupSize, true);
      _members.set(e.id, {
        entity: e,
        index: i,
        groupSize,
        fanOffset,
        spiderOffset,
        groupKey,
        coords: c,
      });
    });
  }
})();

function computeOffset(
  index: number,
  total: number,
  spider: boolean,
): [number, number] {
  if (total <= 1) return [0, 0];
  const radius = spider ? SPIDER_RADIUS : FAN_RADIUS;
  // Start at top, go clockwise. Spread evenly across the full circle.
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

/** Lookup the precomputed member info for an entity. */
export function memberOf(e: AnyEntity): GroupMember | null {
  return _members.get(e.id) ?? null;
}

/** Get all entity ids that share a coord group. */
export function groupMembers(groupKey: string): string[] {
  return _groupKeys.get(groupKey) ?? [];
}

/** Whether a coord group should be rendered as a cluster (count badge)
 * rather than individual markers. */
export function isClusteredGroup(groupKey: string): boolean {
  return (_groupKeys.get(groupKey)?.length ?? 0) >= CLUSTER_THRESHOLD;
}

export const AUDIO_BASE_URL = process.env.AUDIO_BASE_URL || "/audio";

export function audioUrl(episodeNum: number): string {
  const ep = episodesById[episodeNum];
  if (!ep) return "";
  let filename = ep.audio_file;
  // GitHub Releases auto-renames asset filenames, replacing spaces with dots.
  // For any other host (Cloudflare R2, S3, the local symlink) we keep the
  // canonical filenames with spaces — they're URL-safe via standard encoding.
  if (/(?:github\.com|githubusercontent\.com)/.test(AUDIO_BASE_URL)) {
    filename = filename.replace(/ /g, ".");
  }
  // Percent-encode — Chrome silently encodes when assigning to <audio>.src,
  // but iOS Safari does not, so spaces in filenames cause the audio element
  // to surface "Error" without ever loading. encodeURIComponent on the
  // filename only (not the base URL) preserves the host's path slashes.
  return `${AUDIO_BASE_URL}/${encodeURIComponent(filename)}`;
}
