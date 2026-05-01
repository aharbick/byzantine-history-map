"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/context";
import { allEntities, isActiveAt } from "@/lib/data";

interface Props {
  minYear: number;
  maxYear: number;
}

// 25-year bins line up with the existing timeline minor ticks and produce
// readable bars on phone (~3-4px wide) without losing burst detail like the
// 1071 / 1204 spikes. Decade bins were too noisy on mobile.
const BIN_SIZE = 25;

export default function TimelineMiniMap({ minYear, maxYear }: Props) {
  const { currentYear, setCurrentYear, filters } = useApp();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const totalYears = maxYear - minYear;

  // Density: count entities active at the center year of each bin. "Active"
  // (not just "primary year falls in bin") gives a better feel for "where is
  // stuff happening" — a 30-year reign contributes to multiple bins, which
  // matches how the user perceives the era.
  const bins = useMemo(() => {
    const n = Math.ceil(totalYears / BIN_SIZE);
    const counts: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const center = minYear + i * BIN_SIZE + BIN_SIZE / 2;
      let c = 0;
      for (const e of allEntities) {
        if (!filters[e.kind]) continue;
        if (isActiveAt(e, center)) c++;
      }
      counts[i] = c;
    }
    return counts;
  }, [minYear, maxYear, totalYears, filters]);

  const maxCount = Math.max(1, ...bins);

  const clientXToYear = useCallback(
    (clientX: number): number => {
      const el = containerRef.current;
      if (!el) return currentYear;
      const r = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return minYear + ratio * totalYears;
    },
    [minYear, totalYears, currentYear],
  );

  const cursorPct = ((currentYear - minYear) / totalYears) * 100;

  return (
    <div
      ref={containerRef}
      data-byz-strip
      // Fully transparent — bars overlay the map directly so the geography
      // shows through. Picks a non-entity hue (people=gold, places=blue,
      // events=red) so the histogram never reads as another category.
      className="relative h-24 w-full select-none touch-none cursor-pointer"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        setCurrentYear(clientXToYear(e.clientX));
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        setCurrentYear(clientXToYear(e.clientX));
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      aria-label="Timeline density overview — tap to jump"
    >
      <svg
        className="absolute inset-0 w-full h-full"
        viewBox={`0 0 ${bins.length} 1`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {bins.map((c, i) => {
          const h = c / maxCount;
          if (h <= 0) return null;
          return (
            <rect
              key={i}
              x={i + 0.08}
              y={1 - h}
              width={0.84}
              height={h}
              fill="rgb(165 145 195 / 0.45)"
            />
          );
        })}
      </svg>
      {/* Current-year cursor */}
      <div
        className="absolute top-0 bottom-0 w-px bg-byz-goldLight pointer-events-none"
        style={{ left: `${cursorPct}%` }}
      />
      <div
        className="absolute -translate-x-1/2 top-0 w-2 h-2 rotate-45 bg-byz-goldLight pointer-events-none"
        style={{ left: `${cursorPct}%` }}
      />
    </div>
  );
}
