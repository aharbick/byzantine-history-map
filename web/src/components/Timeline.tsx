"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/context";
import { allEntities, entities, peopleById, timelineYear } from "@/lib/data";
import type { AnyEntity, Person } from "@/lib/types";
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
    setAudioFocusEntityIds,
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

  // Twelve-rulers ribbon — each ruler is a horizontal band spanning their
  // reign. Always rendered (regardless of kind filters); the protagonist of
  // an episode is the spine of the podcast, so the ribbon is intentionally
  // distinct from the People filter that hides supporting-cast dots.
  const rulers = useMemo(() => {
    const list: {
      ruler: Person;
      start: number;
      end: number;
    }[] = [];
    for (const id of entities.twelve_rulers) {
      const r = peopleById[id];
      if (!r || r.reign_start == null || r.reign_end == null) continue;
      list.push({ ruler: r, start: r.reign_start, end: r.reign_end });
    }
    return list;
  }, []);

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 select-none">
      {/* Mini-map: transparent histogram overlaying the map directly.
          No background — geography reads through. */}
      <TimelineMiniMap minYear={minYear} maxYear={maxYear} />

      {/* Twelve-rulers ribbon — its own band between the density mini-map
          and the main strip. Each band spans [reign_start, reign_end] in
          the timeline's coordinate system, scrolls in lockstep with the
          strip, and the ruler whose era contains currentYear pops out as a
          large pinned chip on the seam beside the year readout (handled
          inside RulerRibbon). */}
      <RulerRibbon
        rulers={rulers}
        minYear={minYear}
        translateX={translateX}
        trackWidthPx={trackWidthPx}
        currentYear={currentYear}
        onPick={(r) => {
          setCurrentYear((r.start + r.end) / 2);
          selectEntity(r.ruler);
        }}
        onDragStart={(e) => {
          // Same scrub-drag the main strip + density mini-map have. Click
          // on the background of the ribbon (NOT on a chip — chips
          // stopPropagation) starts a drag.
          (e.target as Element).setPointerCapture?.(e.pointerId);
          dragLastXRef.current = e.clientX;
          setDragging(true);
        }}
      />

      {/* Year readout straddles the seam between the ruler ribbon and the
          main strip, tying the two regions together visually. */}
      <div className="relative h-0">
        <div className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 rounded-full bg-byz-purpleDeep/95 border border-byz-gold/60 px-4 py-1 text-byz-goldLight font-display text-sm tracking-wider whitespace-nowrap shadow-card">
          {formatYear(currentYear)}
        </div>
      </div>

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

        {/* Auto-scrub lock toggle. Only meaningful while an episode is loaded —
            hidden otherwise to avoid implying a feature that has no effect.
            Locked = solid gold (clearly "engaged"); unlocked = hollow outline
            against the strip's dark background. stopPropagation prevents the
            click from also starting a strip drag. */}
        {playingEpisode != null && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const nextLocked = !autoScrubLocked;
              setAutoScrubLocked(nextLocked);
              // Engaging the lock should also drop the current "focus" marker —
              // otherwise the freeze leaves an entity glowing forever even
              // though the timeline has stopped following the audio.
              if (nextLocked) setAudioFocusEntityIds([]);
            }}
            className={`absolute left-2 top-2 z-30 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-display tracking-wider transition-colors ${
              autoScrubLocked
                ? "bg-byz-goldLight text-[#1a1006] border border-byz-gold shadow-[0_0_0_1px_rgba(26,16,6,0.4)]"
                : "bg-byz-purpleDeep/80 text-byz-goldLight border border-byz-goldLight/50 hover:border-byz-goldLight"
            }`}
            title={
              autoScrubLocked
                ? "Auto-scrub locked — timeline won't follow audio"
                : "Auto-scrub on — timeline follows audio"
            }
            aria-pressed={autoScrubLocked}
          >
            {autoScrubLocked ? (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="4" y="11" width="16" height="10" rx="2" fill="currentColor" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            ) : (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0" />
              </svg>
            )}
            <span>{autoScrubLocked ? "LOCKED" : "FOLLOW"}</span>
          </button>
        )}

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

/** Trim verbose rulers down to a chip-friendly label.
 * "Constantine the Great" -> "Constantine I", "Irene of Athens" -> "Irene",
 * "Constantine XI Palaiologos" -> "Constantine XI", "Alexios Komnenos" ->
 * "Alexios", "Isaac II Angelos" -> "Isaac II". Falls back to the full name
 * if no rule fires. */
function shortRulerName(name: string): string {
  return name
    .replace(/^Constantine the Great$/, "Constantine I")
    .replace(/ the Apostate$/, "")
    .replace(/ of Athens$/, "")
    .replace(/ Palaiologos$/, "")
    .replace(/ Komnenos$/, "")
    .replace(/ Angelos$/, "");
}

function formatYear(y: number): string {
  const r = Math.round(y);
  if (r < 0) return `${-r} BC`;
  return `${r} AD`;
}

/* ------------------------------------------------------------------------- *
 * RulerRibbon — its own row above the main strip, between the density
 * mini-map and the year readout.
 *
 * Layout: 56px tall, gold-themed slab. Inside, a horizontally-translated
 * track carries a chip per ruler at their reign position. Reigns under
 * ~12 years are too narrow for a portrait + name, so they collapse to a
 * minimum-width gold pip that just registers a presence on the timeline.
 *
 * The ruler whose era contains currentYear is also drawn as a LARGE pinned
 * portrait sitting on the seam between the ribbon and the strip — the
 * "you are here" anchor that the year readout floats next to.
 * ------------------------------------------------------------------------- */

interface RulerEntry {
  ruler: Person;
  start: number;
  end: number;
}

function RulerRibbon({
  rulers,
  minYear,
  translateX,
  trackWidthPx,
  currentYear,
  onPick,
  onDragStart,
}: {
  rulers: RulerEntry[];
  minYear: number;
  translateX: number;
  trackWidthPx: number;
  currentYear: number;
  onPick: (r: RulerEntry) => void;
  onDragStart: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  // Single-row ribbon. Each ruler's chip lives at its reign position; the
  // reign duration is shown as a colored bar UNDER the portrait+name. When
  // the cursor enters a reign, THAT ruler's chip detaches from the line
  // and snaps over the year readout pill as a big portrait + name. When
  // the cursor leaves, it snaps back to its ribbon spot. The reign bar
  // stays put — only the chip travels.
  const RIBBON_H = 56;
  const PORTRAIT_SIZE = 32;
  const PORTRAIT_TOP = 6;
  const BAR_TOP = PORTRAIT_TOP + PORTRAIT_SIZE + 2;
  const BAR_H = 4;
  // Big-portrait dimensions for the snapped-on-cursor active state.
  const ACTIVE_PORTRAIT_SIZE = 96;

  const activeIdx = rulers.findIndex(
    (r) => currentYear >= r.start - 1 && currentYear <= r.end + 1,
  );
  const activeEntry = activeIdx >= 0 ? rulers[activeIdx] : null;

  return (
    <div
      // overflow-visible so the active chip can float above the ribbon's
      // top edge. (Setting overflow-x: hidden alongside overflow-y:
      // visible would collapse both axes to "auto" per the CSS spec and
      // clip the floating chip.) Horizontal clipping is delegated to the
      // inner wrapper so the moving track doesn't bleed sideways past the
      // ribbon's bounds.
      className="relative w-full border-y border-byz-gold/40 bg-byz-purpleDeep/55 overflow-visible cursor-grab active:cursor-grabbing touch-none"
      style={{ height: RIBBON_H }}
      data-byz-strip
      onPointerDown={onDragStart}
    >
      {/* Horizontal clip for the moving track only. Vertical overflow stays
          visible at the outer ribbon level so the snapped active chip
          renders above the ribbon. */}
      <div className="absolute inset-0 overflow-x-hidden overflow-y-visible">
      {/* Inner moving track: reign bars + ribbon chips, scrolls with the
          timeline. */}
      <div
        className="absolute top-0 bottom-0 left-0 will-change-transform"
        style={{ width: trackWidthPx, transform: `translateX(${translateX}px)` }}
      >
        {rulers.map((entry, idx) => {
          const { ruler, start, end } = entry;
          const reignX = (start - minYear) * PIXELS_PER_YEAR;
          const reignW = Math.max((end - start) * PIXELS_PER_YEAR, 4);
          const isActive = idx === activeIdx;
          const ordinal = entitiesOrdinal(ruler.id);
          return (
            <div key={ruler.id}>
              {/* Reign-duration bar. Stays put even when the chip detaches
                  to fly to the cursor — the bar marks WHERE the era was
                  on the timeline. */}
              <div
                aria-hidden="true"
                className={`absolute rounded ${
                  isActive ? "bg-byz-goldLight" : "bg-byz-gold/60"
                }`}
                style={{
                  left: reignX,
                  width: reignW,
                  top: BAR_TOP,
                  height: BAR_H,
                }}
              />
              {/* In-ribbon chip. Hidden via opacity when this ruler is
                  active (the big detached chip above takes its place). */}
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onPick(entry);
                }}
                onPointerDown={(ev) => ev.stopPropagation()}
                title={`${ordinal}. ${ruler.name} (${start}–${end})`}
                aria-hidden={isActive}
                className="absolute flex items-center gap-1.5 whitespace-nowrap pr-1 transition-opacity duration-150"
                style={{
                  left: reignX - PORTRAIT_SIZE / 2,
                  top: PORTRAIT_TOP,
                  height: PORTRAIT_SIZE,
                  opacity: isActive ? 0 : 1,
                  pointerEvents: isActive ? "none" : "auto",
                  zIndex: 10,
                }}
              >
                {ruler.image_url ? (
                  <img
                    src={ruler.image_url}
                    alt=""
                    draggable={false}
                    className="rounded-full object-cover shadow-[0_2px_6px_rgba(0,0,0,0.55)] border border-byz-gold/70 grayscale"
                    style={{ width: PORTRAIT_SIZE, height: PORTRAIT_SIZE }}
                  />
                ) : (
                  <span
                    className="rounded-full grid place-items-center text-[12px] font-display font-bold text-byz-ink shadow-[0_2px_6px_rgba(0,0,0,0.55)] border border-byz-gold/70"
                    style={{
                      width: PORTRAIT_SIZE,
                      height: PORTRAIT_SIZE,
                      background:
                        "radial-gradient(circle, #fce58a 0%, #c9a227 70%, #6b4f10 100%)",
                    }}
                  >
                    {ordinal}
                  </span>
                )}
                <span className="text-[13px] font-display tracking-wider drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)] text-byz-parchment">
                  {shortRulerName(ruler.name)}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      </div>

      {/* Detached active chip. Pinned at left: 50% of the ribbon (= the
          cursor's vertical line), floats ABOVE the ribbon so it sits over
          the year readout pill. Rendered OUTSIDE the inner overflow-x
          clip so its portrait can extend above the ribbon's top edge.
          Mount animation gives the snap a tiny scale-in pop. */}
      {activeEntry && (
        <ActiveRulerChip
          key={activeEntry.ruler.id}
          entry={activeEntry}
          ordinal={entitiesOrdinal(activeEntry.ruler.id)}
          onPick={onPick}
          ribbonHeight={RIBBON_H}
          portraitSize={ACTIVE_PORTRAIT_SIZE}
        />
      )}
    </div>
  );
}

function ActiveRulerChip({
  entry,
  ordinal,
  onPick,
  ribbonHeight,
  portraitSize,
}: {
  entry: RulerEntry;
  ordinal: number;
  onPick: (r: RulerEntry) => void;
  ribbonHeight: number;
  portraitSize: number;
}) {
  const { ruler, start, end } = entry;
  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation();
        onPick(entry);
      }}
      onPointerDown={(ev) => ev.stopPropagation()}
      title={`${ordinal}. ${ruler.name} (${start}–${end})`}
      // Centered horizontally on the ribbon (= the cursor's column, since
      // the cursor is the middle of the panel). Lifted up so the portrait
      // sits comfortably above the ribbon, with the name tucked just above
      // the reign bar within the ribbon.
      className="absolute left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-1 byz-active-ruler-snap"
      style={{
        // Top is negative: the chip starts above the ribbon and spills
        // down into it. The big portrait sits above the ribbon entirely,
        // and the name aligns roughly where the in-ribbon name normally
        // would.
        top: -(portraitSize - ribbonHeight / 2 + 8),
      }}
    >
      {ruler.image_url ? (
        <img
          src={ruler.image_url}
          alt=""
          draggable={false}
          className="rounded-full object-cover border-2 border-byz-goldLight shadow-[0_6px_22px_rgba(0,0,0,0.7)]"
          style={{ width: portraitSize, height: portraitSize }}
        />
      ) : (
        <span
          className="rounded-full grid place-items-center text-2xl font-display font-bold text-byz-ink border-2 border-byz-goldLight shadow-[0_6px_22px_rgba(0,0,0,0.7)]"
          style={{
            width: portraitSize,
            height: portraitSize,
            background:
              "radial-gradient(circle, #fce58a 0%, #c9a227 70%, #6b4f10 100%)",
          }}
        >
          {ordinal}
        </span>
      )}
      <span className="text-[15px] font-display font-bold tracking-wider text-byz-goldLight drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
        {shortRulerName(ruler.name)}
      </span>
    </button>
  );
}

function entitiesOrdinal(id: string): number {
  return entities.twelve_rulers.indexOf(id) + 1;
}
