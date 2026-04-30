"use client";

import clsx from "clsx";
import { useApp } from "@/lib/context";
import type { KindFilter } from "@/lib/context";

const ROWS: { key: keyof KindFilter; color: string; label: string }[] = [
  { key: "person", color: "#e7c873", label: "People" },
  { key: "place", color: "#3a6b8c", label: "Places" },
  { key: "event", color: "#b44646", label: "Events" },
];

export default function Legend() {
  const { filters, setFilters } = useApp();
  const toggle = (key: keyof KindFilter) =>
    setFilters({ ...filters, [key]: !filters[key] });

  return (
    <div
      className="absolute left-3 sm:left-4 z-30 flex flex-col items-start gap-1 rounded-2xl border border-byz-gold/60 bg-byz-purpleDeep/90 px-3 py-2 text-sm font-display tracking-wider"
      style={{ bottom: 110 }}
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
                  "inline-block w-2.5 h-2.5 rounded-full ring-1 ring-byz-ink transition-opacity",
                  !on && "opacity-30",
                )}
                style={{ background: row.color }}
              />
              <span>{row.label}</span>
            </button>
          );
        })}
    </div>
  );
}
