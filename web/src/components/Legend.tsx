"use client";

import clsx from "clsx";
import { useApp } from "@/lib/context";
import type { KindFilter } from "@/lib/context";

const ROWS: {
  key: keyof KindFilter;
  color: string;
  ringColor: string;
  label: string;
}[] = [
  { key: "person", color: "#e7c873", ringColor: "#876928", label: "People" },
  { key: "place", color: "#3a6b8c", ringColor: "#213c4f", label: "Places" },
  { key: "event", color: "#b44646", ringColor: "#5d2424", label: "Events" },
];

export default function Legend() {
  const { filters, setFilters, empireOverlayOn, setEmpireOverlayOn } = useApp();
  const toggle = (key: keyof KindFilter) =>
    setFilters({ ...filters, [key]: !filters[key] });

  return (
    <div
      // Tight padding + gap so the Legend reads as a sibling of the
      // (compact) minimized player above. Same fixed width so they stack
      // as a uniform pair, and the gap to the timeline above matches the
      // gap between the two widgets.
      // Asymmetric padding: pl-2 (instead of pl-3) shifts the dot+label
      // block ~4px left so the content visually centers in the chip.
      // The longer "Territory" label needs the full pr-3 on the right
      // edge to avoid kissing the border.
      className="absolute left-2 z-30 flex flex-col items-start gap-0.5 rounded-2xl border border-byz-gold/60 bg-byz-purpleDeep/70 pl-2 pr-3 py-1 text-sm font-display tracking-wider w-[98px]"
      style={{ bottom: 8 }}
      data-byz-tour="legend"
    >
        {ROWS.map((row) => {
          const on = filters[row.key];
          return (
            <button
              key={row.key}
              onClick={() => toggle(row.key)}
              className={clsx(
                "flex items-center gap-1.5 rounded-full px-1 transition-colors",
                on ? "text-byz-parchment" : "text-byz-parchmentDark/50 line-through",
                "hover:bg-byz-gold/10",
              )}
              aria-pressed={on}
            >
              <span
                className={clsx(
                  "inline-block w-2.5 h-2.5 rounded-full transition-opacity",
                  !on && "opacity-30",
                )}
                style={{
                  background: row.color,
                  boxShadow: `0 0 0 1.5px ${row.ringColor}`,
                }}
              />
              <span>{row.label}</span>
            </button>
          );
        })}
        {/* Territory overlay — same row geometry as the kind filters above
            (no extra mt/pt/border) so the chip reads as a single,
            consistently-spaced layer toggle list. The swatch is an
            irregular polygon outline rather than a dot/checkbox so it
            reads as "an area on the map" instead of "another marker
            kind". */}
        <button
          onClick={() => setEmpireOverlayOn(!empireOverlayOn)}
          aria-pressed={empireOverlayOn}
          title={
            empireOverlayOn
              ? "Hide Byzantine territory overlay"
              : "Show Byzantine territory overlay (preview)"
          }
          className={clsx(
            "flex items-center gap-1.5 rounded-full px-1 transition-colors",
            empireOverlayOn
              ? "text-byz-parchment"
              : "text-byz-parchmentDark/50 line-through",
            "hover:bg-byz-gold/10",
          )}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 12 12"
            className={clsx(
              "shrink-0 transition-opacity",
              !empireOverlayOn && "opacity-30",
            )}
            aria-hidden="true"
          >
            {/* Irregular polygon — evokes a country / region outline at
                a glance, mirrors the fill+stroke treatment used on the
                actual map layer. */}
            <polygon
              points="1.5,4 4,1.5 8,1 11,3.5 10.5,8 7,11 3,10 1,7"
              fill="rgba(231, 200, 115, 0.35)"
              stroke="#c9a227"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
          <span>Territory</span>
        </button>
    </div>
  );
}
