/**
 * Per-episode "what entity is being discussed at line N" lookup.
 *
 * Built from `entity.transcript_lines_by_episode`, which already records
 * the [start, end] line ranges for each entity in each episode. We flatten
 * those into a single sorted list per episode, keep only entities with a
 * known timeline year, and provide `findAnchorAt(line)` for the audio-
 * driven scrub.
 *
 * Cached on first call per episode — the data is static, so we never
 * rebuild.
 */

import { allEntities, timelineYear } from "@/lib/data";
import type { AnyEntity } from "@/lib/types";

export interface EpisodeAnchor {
  startLine: number;
  endLine: number;
  entityId: string;
  year: number;
  kind: AnyEntity["kind"];
}

const cache = new Map<number, EpisodeAnchor[]>();

export function getEpisodeAnchors(ep: number): EpisodeAnchor[] {
  const cached = cache.get(ep);
  if (cached) return cached;

  const out: EpisodeAnchor[] = [];
  const epKey = String(ep);
  for (const e of allEntities) {
    const ranges = e.transcript_lines_by_episode?.[epKey];
    if (!ranges || ranges.length === 0) continue;
    const year = timelineYear(e);
    if (year == null) continue;
    for (const [start, end] of ranges) {
      out.push({
        startLine: start,
        endLine: end,
        entityId: e.id,
        year,
        kind: e.kind,
      });
    }
  }
  out.sort((a, b) => a.startLine - b.startLine);
  cache.set(ep, out);
  return out;
}

/** The "current" anchor at line `L` is whichever entity range surrounds L
 * with the latest start — i.e. the most-recently-introduced entity that's
 * still in scope. Returns null if `L` falls in a gap with no active range. */
export function findAnchorAt(
  line: number,
  anchors: EpisodeAnchor[],
): EpisodeAnchor | null {
  let best: EpisodeAnchor | null = null;
  for (const a of anchors) {
    if (a.startLine > line) break; // sorted by startLine
    if (a.endLine >= line) {
      if (!best || a.startLine > best.startLine) best = a;
    }
  }
  return best;
}
