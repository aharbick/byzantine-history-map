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
  const { filters, setFilters } = useApp();
  const toggle = (key: keyof KindFilter) =>
    setFilters({ ...filters, [key]: !filters[key] });

  return (
    <div
      // Tight padding + gap so the Legend reads as a sibling of the
      // (compact) minimized player above. Same fixed width so they stack
      // as a uniform pair, and the gap to the timeline above matches the
      // gap between the two widgets.
      className="absolute left-2 z-30 flex flex-col items-start gap-0.5 rounded-2xl border border-byz-gold/60 bg-byz-purpleDeep/70 px-3 py-1 text-sm font-display tracking-wider w-[98px]"
      style={{ bottom: 104 }}
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
    </div>
  );
}
