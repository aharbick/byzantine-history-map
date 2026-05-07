/**
 * Shared OG-card renderer for the per-entity SSR routes. Returns an
 * ImageResponse so each route's opengraph-image.tsx is a thin wrapper that
 * just looks up the entity by slug and delegates here.
 *
 * Style mirrors the in-app theme (deep purple/ink with gold accents) so a
 * shared link on Twitter/Slack/iMessage feels of-a-piece with the site.
 * Text-only by design — no Wikipedia fetch — so OG generation is fast and
 * never hits a network failure mode.
 */

import { ImageResponse } from "next/og";
import type { AnyEntity } from "@/lib/types";
import { entitySubtitle } from "@/lib/entity_meta";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

const KIND_COLOR: Record<AnyEntity["kind"], string> = {
  person: "#e7c873",
  place: "#3a6b8c",
  event: "#b44646",
};
const KIND_LABEL: Record<AnyEntity["kind"], string> = {
  person: "PERSON",
  place: "PLACE",
  event: "EVENT",
};

function trim(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return cut.slice(0, lastSpace > max - 40 ? lastSpace : max).trimEnd() + "…";
}

export function renderEntityOg(entity: AnyEntity): ImageResponse {
  const accent = KIND_COLOR[entity.kind];
  const summary = trim(
    entity.summary || entity.wikipedia_extract || "",
    260,
  );
  const subtitle = entitySubtitle(entity);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: "60px 70px",
          background:
            "linear-gradient(135deg, #2a0f24 0%, #1a1006 100%)",
          color: "#f4e9cf",
          fontFamily: "serif",
          borderLeft: `14px solid ${accent}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 22,
            letterSpacing: 6,
            color: "#e7c873",
            textTransform: "uppercase",
          }}
        >
          <span>Twelve Byzantine Rulers</span>
          <span
            style={{
              padding: "6px 14px",
              border: `1.5px solid ${accent}`,
              borderRadius: 999,
              fontSize: 16,
              letterSpacing: 4,
              color: accent,
            }}
          >
            {KIND_LABEL[entity.kind]}
          </span>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 70,
            flex: 1,
          }}
        >
          <div
            style={{
              fontSize: entity.name.length > 28 ? 76 : 96,
              lineHeight: 1.05,
              color: "#fce58a",
              fontWeight: 600,
              letterSpacing: 1,
            }}
          >
            {entity.name}
          </div>
          {subtitle && (
            <div
              style={{
                marginTop: 18,
                fontSize: 28,
                color: "#d9c79c",
                fontStyle: "italic",
              }}
            >
              {subtitle}
            </div>
          )}
          {summary && (
            <div
              style={{
                marginTop: 36,
                fontSize: 26,
                lineHeight: 1.45,
                color: "#f4e9cf",
                maxWidth: 1000,
                display: "-webkit-box",
                WebkitLineClamp: 4,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {summary}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 18,
            letterSpacing: 4,
            color: "#a99474",
            textTransform: "uppercase",
          }}
        >
          <span>byzantinehistorymap.com</span>
          <span>Adapted from Lars Brownworth&rsquo;s podcast</span>
        </div>
      </div>
    ),
    OG_SIZE,
  );
}
