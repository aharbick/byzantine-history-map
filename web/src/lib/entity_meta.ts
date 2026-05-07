/**
 * Shared metadata helpers for the per-entity SSR routes (/people/[slug],
 * /places/[slug], /events/[slug]). Each route's `generateMetadata` and
 * `opengraph-image.tsx` pull from here so titles, descriptions, and OG
 * cards stay consistent across the three kinds.
 */

import type { Metadata } from "next";
import {
  entities,
  eventsById,
  peopleById,
  placesById,
} from "@/lib/data";
import type { AnyEntity, EntityKind } from "@/lib/types";

/** Production canonical URL — mirrors DEPLOY.md / README.md. Override per
 * environment via NEXT_PUBLIC_SITE_URL (Vercel preview deploys, staging). */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://byzantinehistorymap.com";

const SITE_NAME = "Twelve Byzantine Rulers";

/** Map a route segment ("people"/"places"/"events") to the bucket of entities
 * we generate static params from, so each route's `generateStaticParams`
 * stays a one-liner. */
export function entitiesForKind(kind: EntityKind): AnyEntity[] {
  if (kind === "person") return entities.people;
  if (kind === "place") return entities.places;
  return entities.events;
}

export function lookupForKind(
  kind: EntityKind,
  slug: string,
): AnyEntity | null {
  const map =
    kind === "person"
      ? peopleById
      : kind === "place"
      ? placesById
      : eventsById;
  return map[slug] ?? null;
}

export function entityRoute(entity: AnyEntity): string {
  const seg =
    entity.kind === "person"
      ? "people"
      : entity.kind === "place"
      ? "places"
      : "events";
  return `/${seg}/${entity.id}`;
}

function fmtYear(y: number | null | undefined): string | null {
  if (y == null) return null;
  if (y < 0) return `${-y} BC`;
  return String(y);
}

/** Short subtitle (kind + dates / location) for OG card + metadata. */
export function entitySubtitle(e: AnyEntity): string {
  if (e.kind === "person") {
    if (e.is_twelve_ruler) {
      const idx = entities.twelve_rulers.indexOf(e.id);
      const ordinal = idx >= 0 ? idx + 1 : null;
      const reign =
        e.reign_start != null && e.reign_end != null
          ? `reigned ${fmtYear(e.reign_start)}–${fmtYear(e.reign_end)}`
          : null;
      const parts: string[] = [];
      if (ordinal != null) parts.push(`Ruler ${ordinal} of 12`);
      if (reign) parts.push(reign);
      else if (e.role) parts.push(e.role);
      return parts.join(" · ");
    }
    if (e.role) {
      const reign =
        e.reign_start != null && e.reign_end != null
          ? `reigned ${fmtYear(e.reign_start)}–${fmtYear(e.reign_end)}`
          : e.birth_year != null && e.death_year != null
          ? `${fmtYear(e.birth_year)}–${fmtYear(e.death_year)}`
          : null;
      return reign ? `${e.role} · ${reign}` : e.role;
    }
    return "Person";
  }
  if (e.kind === "place") {
    const parts: string[] = ["Place"];
    if (e.modern_name) parts.push(`modern ${e.modern_name}`);
    if (e.modern_country) parts.push(e.modern_country);
    return parts.join(" · ");
  }
  // event
  const parts: string[] = [];
  if (e.category) parts.push(cap(e.category));
  if (e.year != null) {
    if (e.end_year != null && e.end_year !== e.year) {
      parts.push(`${fmtYear(e.year)}–${fmtYear(e.end_year)}`);
    } else {
      parts.push(fmtYear(e.year)!);
    }
  }
  return parts.join(" · ") || "Event";
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Trim summary to ~280 chars for meta description / OG body. */
function trimSummary(s: string, max = 280): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return cut.slice(0, lastSpace > max - 40 ? lastSpace : max).trimEnd() + "…";
}

/** Build the Next.js Metadata object for an entity page. */
export function buildEntityMetadata(entity: AnyEntity): Metadata {
  const subtitle = entitySubtitle(entity);
  const title = `${entity.name} — ${SITE_NAME}`;
  const description = trimSummary(
    entity.summary || entity.wikipedia_extract || subtitle,
  );
  const url = `${SITE_URL}${entityRoute(entity)}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}
