/**
 * Per-episode "what entity is being discussed at time T" lookup.
 *
 * Built from each entity's `mentions_by_episode`, which records segment-level
 * `[start, end]` seconds for every mention found in the Whisper transcript.
 *
 * Entities without a `timelineYear` (e.g. places like Egypt with no
 * `first_year`, or people with no reign/birth date) are still kept — the
 * marker still highlights when its segment plays, the timeline year just
 * doesn't shift on those activations. Skipping them entirely meant a ton of
 * legitimate mentions never highlighted at all.
 *
 * Cached on first call per episode — the data is static.
 */

import { allEntities, timelineYear } from "@/lib/data";
import type { AnyEntity, Mention } from "@/lib/types";

export interface EpisodeAnchor {
  startSeconds: number;
  endSeconds: number;
  segmentIdx: number;
  entityId: string;
  /** null when the entity has no resolvable timeline year. The marker
   * still highlights — the timeline year just doesn't shift. */
  year: number | null;
  kind: AnyEntity["kind"];
}

const cache = new Map<number, EpisodeAnchor[]>();

export function getEpisodeAnchors(ep: number): EpisodeAnchor[] {
  const cached = cache.get(ep);
  if (cached) return cached;

  const out: EpisodeAnchor[] = [];
  const epKey = String(ep);
  for (const e of allEntities) {
    const mentions: Mention[] | undefined = e.mentions_by_episode?.[epKey];
    if (!mentions || mentions.length === 0) continue;
    const year = timelineYear(e);
    for (const m of mentions) {
      out.push({
        startSeconds: m.start,
        endSeconds: m.end,
        segmentIdx: m.segment_idx,
        entityId: e.id,
        year,
        kind: e.kind,
      });
    }
  }
  out.sort((a, b) => a.startSeconds - b.startSeconds);
  cache.set(ep, out);
  return out;
}

/** The "current" anchor at time T is whichever entity range surrounds T with
 * the latest start — i.e. the most-recently-introduced entity that's still
 * in scope. Returns null in a gap with no active range. */
export function findAnchorAt(
  seconds: number,
  anchors: EpisodeAnchor[],
): EpisodeAnchor | null {
  let best: EpisodeAnchor | null = null;
  for (const a of anchors) {
    if (a.startSeconds > seconds) break; // sorted by startSeconds
    if (a.endSeconds >= seconds) {
      if (!best || a.startSeconds > best.startSeconds) best = a;
    }
  }
  return best;
}
