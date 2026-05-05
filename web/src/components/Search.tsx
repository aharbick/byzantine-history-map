"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useApp } from "@/lib/context";
import { allEntities, timelineYear } from "@/lib/data";
import type { AnyEntity } from "@/lib/types";

const KIND_COLOR: Record<AnyEntity["kind"], string> = {
  person: "#e7c873",
  place: "#3a6b8c",
  event: "#b44646",
};
const KIND_RING: Record<AnyEntity["kind"], string> = {
  person: "#876928",
  place: "#213c4f",
  event: "#5d2424",
};

const MAX_RESULTS = 12;

// Score a candidate against the query. The numbers themselves are
// arbitrary — what matters is the *order*: name-prefix beats alt-prefix
// beats name-substring beats alt-substring beats role-substring. The
// fractional max_score boost is just a tie-breaker so more important
// entities surface first when two match equally well (e.g. "John" picks
// John I Tzimiskes over a minor John).
function scoreEntity(e: AnyEntity, q: string): number {
  const name = e.name.toLowerCase();
  let s = 0;
  if (name.startsWith(q)) s = 100;
  else if (name.includes(q)) s = 60;
  for (const alt of e.alt_names ?? []) {
    const a = alt.toLowerCase();
    if (a.startsWith(q)) s = Math.max(s, 80);
    else if (a.includes(q)) s = Math.max(s, 40);
  }
  if (e.kind === "person" && e.role) {
    if (e.role.toLowerCase().includes(q)) s = Math.max(s, 20);
  }
  if (s === 0) return 0;
  return s + Math.min(e.max_score ?? 0, 100) / 1000;
}

function searchEntities(query: string): AnyEntity[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: { e: AnyEntity; s: number }[] = [];
  for (const e of allEntities) {
    const s = scoreEntity(e, q);
    if (s > 0) out.push({ e, s });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, MAX_RESULTS).map((x) => x.e);
}

function formatYear(y: number): string {
  if (y < 0) return `${-y} BC`;
  return `${y} AD`;
}

function secondaryLine(e: AnyEntity): string {
  const parts: string[] = [];
  if (e.kind === "person") {
    if (e.role) parts.push(e.role);
    const y = timelineYear(e);
    if (y != null) parts.push(formatYear(y));
  } else if (e.kind === "place") {
    if (e.modern_name) parts.push(`mod. ${e.modern_name}`);
    if (e.first_year != null) parts.push(formatYear(e.first_year));
  } else {
    if (e.category) parts.push(e.category);
    if (e.year != null) parts.push(formatYear(e.year));
  }
  return parts.join(" · ");
}

export default function Search() {
  const { setCurrentYear, selectEntity } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchEntities(q), [q]);

  // The highlighted-row index lives outside the result set, so a query
  // change can leave it pointing past the new (shorter) list. Reset on
  // every query change — top result is the natural default.
  useEffect(() => {
    setHi(0);
  }, [q]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Click-outside + Escape close the panel. We listen on the window so
  // any click on the map (which isn't a child of our container) collapses
  // search back to the FAB.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQ("");
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setQ("");
      }
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (e: AnyEntity) => {
    const y = timelineYear(e);
    if (y != null) setCurrentYear(y);
    selectEntity(e);
    setOpen(false);
    setQ("");
  };

  const onInputKey = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setHi((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setHi((i) => Math.max(i - 1, 0));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const r = results[hi];
      if (r) pick(r);
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute left-2 top-2 z-30 flex flex-col items-start gap-2"
    >
      {open ? (
        <div className="flex items-center gap-1 rounded-full border border-byz-gold/60 bg-byz-purpleDeep/95 pl-3 pr-1 py-1 shadow-card w-[320px]">
          <SearchIcon className="text-byz-goldLight shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search people, places, events…"
            className="flex-1 min-w-0 bg-transparent outline-none text-byz-parchment placeholder:text-byz-parchmentDark/60 text-sm font-display tracking-wider px-1"
          />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setQ("");
            }}
            aria-label="Close search"
            className="w-7 h-7 rounded-full text-byz-parchmentDark hover:text-byz-goldLight flex items-center justify-center"
          >
            <XIcon />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Search entities"
          title="Search people, places, events"
          className="w-11 h-11 rounded-full border border-byz-gold/60 bg-byz-purpleDeep/95 text-byz-goldLight shadow-card flex items-center justify-center hover:bg-byz-purpleDeep hover:border-byz-gold transition-colors"
        >
          <SearchIcon />
        </button>
      )}

      {open && q.trim() && (
        <div className="w-[320px] max-h-[60vh] overflow-y-auto byz-scroll rounded-2xl border border-byz-gold/60 bg-byz-purpleDeep/95 shadow-card">
          {results.length === 0 ? (
            <div className="px-3 py-3 text-byz-parchmentDark text-sm font-display tracking-wider">
              No matches.
            </div>
          ) : (
            results.map((e, idx) => (
              <button
                key={`${e.kind}-${e.id}`}
                onMouseEnter={() => setHi(idx)}
                onClick={() => pick(e)}
                className={clsx(
                  "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors border-l-2",
                  idx === hi
                    ? "bg-byz-gold/15 border-byz-goldLight"
                    : "border-transparent hover:bg-byz-gold/10",
                )}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  style={{
                    background: KIND_COLOR[e.kind],
                    boxShadow: `0 0 0 1.5px ${KIND_RING[e.kind]}`,
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-byz-parchment text-sm">
                    {e.name}
                  </span>
                  {secondaryLine(e) && (
                    <span className="block truncate text-byz-parchmentDark text-[11px]">
                      {secondaryLine(e)}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 6l12 12M18 6l-12 12" />
    </svg>
  );
}
