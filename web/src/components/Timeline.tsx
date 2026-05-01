"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/context";
import { allEntities, timelineYear } from "@/lib/data";
import type { AnyEntity } from "@/lib/types";
import TimelineMiniMap from "./TimelineMiniMap";

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

// Darker shade of each kind, used as the dot's outline so the ring reads as
// "the same color, deepened" rather than a generic black border. Same hue,
// roughly half the lightness.
const KIND_COLOR_DARK: Record<AnyEntity["kind"], string> = {
  person: "#876928",
  place: "#213c4f",
  event: "#5d2424",
};

export default function Timeline({ minYear, maxYear }: Props) {
  const {
    currentYear,
    setCurrentYear,
    selectEntity,
    filters,
    autoScrubLocked,
    setAutoScrubLocked,
    playingEpisode,
  } = useApp();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragLastXRef = useRef<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const totalYears = maxYear - minYear;
  const trackWidthPx = totalYears * PIXELS_PER_YEAR;

  // Mirror currentYear into a ref so event handlers can read the latest value
  // without listing it as a dep (which would otherwise tear down + re-bind
  // every listener on every year change — 60+ times/sec during a drag).
  const currentYearRef = useRef(currentYear);
  currentYearRef.current = currentYear;

  // rAF-coalesced delta accumulator: many input events per frame collapse into
  // a single React state update. We accumulate deltas (not absolute years) so
  // multiple events between frames don't clobber each other — each event adds
  // to the pending year rather than overwriting it.
  const pendingYearRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const queueYearDelta = useCallback(
    (deltaYears: number) => {
      const base = pendingYearRef.current ?? currentYearRef.current;
      pendingYearRef.current = clamp(base + deltaYears, minYear, maxYear);
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const y = pendingYearRef.current;
        pendingYearRef.current = null;
        if (y != null) setCurrentYear(y);
      });
    },
    [minYear, maxYear, setCurrentYear],
  );
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

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
      queueYearDelta(delta * 0.25);
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [queueYearDelta]);

  // Drag-to-scrub via Pointer Events — works for mouse, touch, and pen.
  // On iOS Safari, pointer events are emulated from touch, so this single
  // handler covers both mouse drags and finger drags on the strip.
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
      queueYearDelta(dx / PIXELS_PER_YEAR);
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
  }, [dragging, queueYearDelta]);

  // Touch-swipe gesture anywhere on the page (besides interactive controls or
  // the timeline strip itself — those are already covered by the pointer
  // handler above; running both would double-fire on iOS).
  useEffect(() => {
    let lastX: number | null = null;
    let active = false;
    function isInteractive(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false;
      // Strip is handled by pointer events; map canvas pans the map; aside &
      // buttons are interactive UI.
      return !!target.closest(
        "aside, button, .maplibregl-canvas-container, [data-byz-strip]",
      );
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
      queueYearDelta(dx / PIXELS_PER_YEAR);
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
  }, [queueYearDelta]);

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
      {/* Mini-map: transparent histogram overlaying the map directly.
          No background — geography reads through. */}
      <TimelineMiniMap minYear={minYear} maxYear={maxYear} />

      {/* Year readout straddles the seam between mini-map and main strip,
          tying the two regions together visually. */}
      <div className="relative h-0">
        <div className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 rounded-full bg-byz-purpleDeep/95 border border-byz-gold/60 px-4 py-1 text-byz-goldLight font-display text-sm tracking-wider whitespace-nowrap shadow-card">
          {formatYear(currentYear)}
        </div>
      </div>

      {/* Auto-scrub lock — when an episode is active, surface a small toggle
          so the user can stop the audio from yanking the timeline year while
          they manually scrub. */}
      {playingEpisode != null && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setAutoScrubLocked(!autoScrubLocked);
          }}
          aria-pressed={autoScrubLocked}
          aria-label={
            autoScrubLocked
              ? "Unlock timeline (let audio drive the year)"
              : "Lock timeline (stop audio from driving the year)"
          }
          title={
            autoScrubLocked
              ? "Timeline locked — audio won't change the year. Tap to unlock."
              : "Timeline follows audio. Tap to lock."
          }
          className={`absolute right-2 -top-7 z-30 inline-flex items-center justify-center w-7 h-7 rounded-full border shadow-card transition-colors ${
            autoScrubLocked
              ? "bg-byz-gold/90 border-byz-goldLight text-byz-ink"
              : "bg-byz-purpleDeep/90 border-byz-gold/50 text-byz-goldLight hover:bg-byz-purpleDeep"
          }`}
        >
          {autoScrubLocked ? (
            // Closed padlock
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M5 7V5a3 3 0 0 1 6 0v2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <rect
                x="3"
                y="7"
                width="10"
                height="7"
                rx="1.5"
                fill="currentColor"
              />
            </svg>
          ) : (
            // Open padlock
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M5 7V5a3 3 0 0 1 6 0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <rect
                x="3"
                y="7"
                width="10"
                height="7"
                rx="1.5"
                fill="currentColor"
              />
            </svg>
          )}
        </button>
      )}

      <div
        ref={stripRef}
        data-byz-strip
        // Flat surface (no gradient), but at moderate alpha so the map still
        // reads through faintly — keeps the strip distinct from the fully
        // transparent mini-map above without feeling like a heavy slab.
        className="relative h-24 bg-byz-purpleDeep/70 overflow-hidden cursor-grab active:cursor-grabbing touch-none"
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
                  {t.major &&
                    (() => {
                      // Proximity drives a "suck-up + scale-up" animation: as
                      // a major-year pill approaches the cursor, it grows and
                      // climbs toward the current-year readout, then tucks
                      // behind it (the readout's z-30 hides it at the peak).
                      // Past the cursor, the same curve plays in reverse.
                      const PROXIMITY_RANGE_YEARS = 35;
                      const dy = Math.abs(t.year - currentYear);
                      const p = Math.max(
                        0,
                        1 - dy / PROXIMITY_RANGE_YEARS,
                      );
                      // p² (ease-in) so the pill stays put until very close
                      // to the cursor, then snaps up and fades behind the
                      // current-year readout. Keeps the motion concentrated.
                      const eased = p * p;
                      const scale = 1 + eased * 0.35;
                      const translateY = -eased * 32; // px upward toward pill
                      const opacity = 1 - eased * 0.85;
                      return (
                        <div
                          className="absolute top-5 whitespace-nowrap rounded-full bg-byz-purpleDeep/85 border border-byz-gold/30 px-2 py-0.5 text-[11px] text-byz-goldLight font-display tracking-wider leading-none"
                          style={{
                            transform: `translate(-50%, ${translateY}px) scale(${scale})`,
                            transformOrigin: "center bottom",
                            opacity,
                          }}
                        >
                          {formatYear(t.year)}
                        </div>
                      );
                    })()}
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
                  // Tap target is the full 12x12 button; visual dot inside
                  // stays small. Doubles touch area without crowding the row.
                  className="absolute -translate-x-1/2 w-3 h-3 flex items-center justify-center hover:scale-150 transition-transform"
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
                    className="w-2.5 h-2.5 rounded-full"
                    style={{
                      background: KIND_COLOR[e.kind],
                      // box-shadow trick replaces the old black ring with a
                      // 1.5px outline in the kind's own darker shade.
                      boxShadow: `0 0 0 1.5px ${KIND_COLOR_DARK[e.kind]}`,
                    }}
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
