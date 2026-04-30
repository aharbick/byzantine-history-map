"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/context";
import { allEntities, timelineYear } from "@/lib/data";
import type { AnyEntity } from "@/lib/types";

interface Props {
  minYear: number;
  maxYear: number;
}

const PIXELS_PER_YEAR = 4;
const TICK_MAJOR = 100;
const TICK_MINOR = 25;

const KIND_COLOR: Record<AnyEntity["kind"], string> = {
  person: "#e7c873",
  place: "#3a6b8c",
  event: "#b44646",
};

export default function Timeline({ minYear, maxYear }: Props) {
  const { currentYear, setCurrentYear, selectEntity, filters } = useApp();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragLastXRef = useRef<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const totalYears = maxYear - minYear;
  const trackWidthPx = totalYears * PIXELS_PER_YEAR;

  useEffect(() => {
    if (!trackRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const ent of entries) setContainerWidth(ent.contentRect.width);
    });
    ro.observe(trackRef.current);
    return () => ro.disconnect();
  }, []);

  // Convert currentYear into a translation: cursor stays centered in the viewport.
  const cursorOffsetPx = (currentYear - minYear) * PIXELS_PER_YEAR;
  const translateX = containerWidth / 2 - cursorOffsetPx;

  // Whole-page wheel scrubbing — vertical scroll moves the timeline cursor.
  // The map's own scroll-zoom is disabled so wheel events are unambiguous.
  // Wheel events that originate inside the entity card (or any other
  // explicitly-scrollable region) should scroll that region instead of
  // hijacking the timeline.
  useEffect(() => {
    function onWheel(e: WheelEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest("aside, audio, .byz-allow-scroll")) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setCurrentYear(
        clamp(currentYear + delta * 0.25, minYear, maxYear),
      );
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [currentYear, minYear, maxYear, setCurrentYear]);

  // Drag-to-scrub via Pointer Events — works for mouse, touch, and pen.
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: PointerEvent) {
      const last = dragLastXRef.current;
      if (last == null) {
        dragLastXRef.current = e.clientX;
        return;
      }
      const dx = last - e.clientX;
      dragLastXRef.current = e.clientX;
      if (!dx) return;
      setCurrentYear(
        clamp(currentYear + dx / PIXELS_PER_YEAR, minYear, maxYear),
      );
    }
    function onUp() {
      setDragging(false);
      dragLastXRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, currentYear, minYear, maxYear, setCurrentYear]);

  // Touch-swipe gesture anywhere on the page (besides interactive controls)
  // so mobile users can scrub even without dragging the strip itself.
  useEffect(() => {
    let lastX: number | null = null;
    let active = false;
    function isInteractive(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false;
      return !!target.closest("aside, button, .maplibregl-canvas-container");
    }
    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      if (isInteractive(e.target)) return;
      active = true;
      lastX = e.touches[0].clientX;
    }
    function onTouchMove(e: TouchEvent) {
      if (!active || e.touches.length !== 1) return;
      const x = e.touches[0].clientX;
      if (lastX == null) {
        lastX = x;
        return;
      }
      const dx = lastX - x;
      lastX = x;
      if (!dx) return;
      setCurrentYear(clamp(currentYear + dx / PIXELS_PER_YEAR, minYear, maxYear));
      e.preventDefault();
    }
    function onTouchEnd() {
      active = false;
      lastX = null;
    }
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [currentYear, minYear, maxYear, setCurrentYear]);

  const ticks = useMemo(() => {
    const list: { year: number; major: boolean }[] = [];
    const start = Math.ceil(minYear / TICK_MINOR) * TICK_MINOR;
    for (let y = start; y <= maxYear; y += TICK_MINOR) {
      list.push({ year: y, major: y % TICK_MAJOR === 0 });
    }
    return list;
  }, [minYear, maxYear]);

  const dots = useMemo(() => {
    const list: { e: AnyEntity; year: number }[] = [];
    for (const e of allEntities) {
      if (!filters[e.kind]) continue;
      const y = timelineYear(e);
      if (y == null) continue;
      list.push({ e, year: y });
    }
    return list;
  }, [filters]);

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 select-none">
      {/* Year readout, absolutely centered above the cursor line. */}
      <div className="relative h-9">
        <div className="absolute left-1/2 -translate-x-1/2 top-0 rounded-full bg-byz-purpleDeep/90 border border-byz-gold/60 px-4 py-1 text-byz-goldLight font-display text-sm tracking-wider whitespace-nowrap">
          {formatYear(currentYear)}
        </div>
      </div>

      <div
        ref={stripRef}
        className="relative h-24 bg-gradient-to-t from-byz-ink/95 via-byz-purpleDeep/80 to-transparent overflow-hidden cursor-grab active:cursor-grabbing touch-none"
        onPointerDown={(e) => {
          // capture so subsequent moves on this pointer route here even if the
          // pointer leaves the element
          (e.target as Element).setPointerCapture?.(e.pointerId);
          dragLastXRef.current = e.clientX;
          setDragging(true);
        }}
      >
        {/* Center cursor line */}
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-byz-goldLight/80 z-10 pointer-events-none" />
        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 bg-byz-goldLight z-10 pointer-events-none" />

        <div
          ref={trackRef}
          className="absolute top-0 bottom-0 left-0 right-0"
        >
          {/* Sliding track */}
          <div
            className="absolute top-0 bottom-0 left-0 will-change-transform"
            style={{
              width: trackWidthPx,
              transform: `translateX(${translateX}px)`,
            }}
          >
            {/* Tick marks + year labels */}
            {ticks.map((t) => {
              const x = (t.year - minYear) * PIXELS_PER_YEAR;
              return (
                <div
                  key={t.year}
                  className="absolute top-0 bottom-0"
                  style={{ left: x }}
                >
                  <div
                    className={`absolute left-0 ${t.major ? "h-4 w-px bg-byz-goldLight" : "h-2 w-px bg-byz-gold/50"}`}
                  />
                  {t.major && (
                    <div className="absolute -translate-x-1/2 top-5 whitespace-nowrap rounded-sm bg-byz-ink/85 px-1.5 py-0.5 text-[11px] font-bold text-byz-goldLight font-display tracking-wider leading-none">
                      {formatYear(t.year)}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Entity dots */}
            {dots.map(({ e, year }) => {
              const x = (year - minYear) * PIXELS_PER_YEAR;
              return (
                <button
                  key={`${e.kind}-${e.id}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setCurrentYear(year);
                    selectEntity(e);
                  }}
                  className="absolute -translate-x-1/2 hover:scale-150 transition-transform"
                  style={{
                    left: x,
                    // Three rows stacked below the year-label pills (label
                    // bottom is ~35px from top of the 96px-tall strip).
                    bottom:
                      e.kind === "person" ? 38 : e.kind === "place" ? 22 : 6,
                  }}
                  title={`${e.name} (${formatYear(year)})`}
                >
                  <div
                    className="w-2 h-2 rounded-full ring-1 ring-byz-ink"
                    style={{ background: KIND_COLOR[e.kind] }}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function formatYear(y: number): string {
  const r = Math.round(y);
  if (r < 0) return `${-r} BC`;
  return `${r} AD`;
}
