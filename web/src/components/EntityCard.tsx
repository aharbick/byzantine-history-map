"use client";

import { motion } from "framer-motion";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/context";
import { getEntity } from "@/lib/data";
import type { AnyEntity, Person, Place, HistoricalEvent } from "@/lib/types";
import EpisodeChip from "./EpisodeChip";
import { episodesById } from "@/lib/data";

interface Props {
  entity: AnyEntity;
}

const KIND_LABEL: Record<AnyEntity["kind"], string> = {
  person: "Person",
  place: "Place",
  event: "Event",
};

export default function EntityCard({ entity }: Props) {
  const { selectEntity } = useApp();
  const heroUrl = entityHeroUrl(entity);
  const cardRef = useRef<HTMLElement | null>(null);

  // Desktop only — clicking outside the card closes it. Skip on mobile,
  // where the card is a full-screen overlay (everywhere is "inside"). Marker
  // and cluster clicks are excluded so tapping a different entity switches
  // selection instead of closing the card.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 639px)").matches) return;

    function onDown(e: MouseEvent) {
      const card = cardRef.current;
      if (!card) return;
      const target = e.target as Element | null;
      if (!target || card.contains(target)) return;
      if (target.closest(".byz-marker, .byz-cluster")) return;
      selectEntity(null);
    }

    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [selectEntity]);

  return (
    <motion.aside
      key={entity.id}
      ref={cardRef}
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: "spring", stiffness: 200, damping: 25 }}
      className={clsx(
        // Highest z-index in the app — sits above the audio player, legend,
        // and timeline. Mobile uses a full-bleed fixed overlay; desktop
        // restores the side-panel rounded card.
        // byz-scroll = thin gold scrollbar on a transparent track, so the
        // scrollbar doesn't expose a square track corner against the card's
        // rounded edge.
        "fixed z-50 overflow-y-auto byz-scroll card-frame shadow-card border-l-4",
        // Mobile (< sm): cover the whole screen so the card is the only
        // surface the user interacts with — no rounded corners at the
        // viewport edges.
        "inset-0 rounded-none",
        // Desktop: ~1.5× wider than before (570px), top-pushed below the
        // map navigation buttons. Use max-height (not a fixed height or a
        // bottom anchor) so the card hugs short content and only grows up
        // to the cap — once it would otherwise extend past 200 px above the
        // screen bottom (i.e., onto the mini-map) it stops growing and
        // overflow-y-auto kicks in. Cap = 100vh − top(128) − bottom(200) = 100vh − 328px.
        "sm:inset-auto sm:right-4 sm:top-32 sm:rounded-xl sm:w-[570px] sm:max-w-[45vw] sm:max-h-[calc(100vh-328px)]",
        entity.kind === "person" && "card-person !border-l-byz-goldLight",
        entity.kind === "place" && "card-place !border-l-byz-mosaic",
        entity.kind === "event" && "card-event !border-l-red-500",
      )}
    >
      {/* Hero image — MTG-style card art. We use a backdrop of the same image
          (blurred) behind a contain-fitted foreground so portraits with a tall
          head/face never get cropped. */}
      {heroUrl && (
        <div className="relative w-full h-56 overflow-hidden border-b border-byz-gold/40 bg-byz-ink">
          <img
            src={heroUrl}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover scale-110 blur-md opacity-40"
          />
          <img
            src={heroUrl}
            alt={entity.name}
            className="relative w-full h-full object-contain"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-byz-purpleDeep/90 via-transparent to-transparent pointer-events-none" />
          <button
            onClick={() => selectEntity(null)}
            aria-label="Close"
            className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-byz-ink/70 backdrop-blur-sm text-byz-parchmentDark hover:text-byz-goldLight flex items-center justify-center"
          >
            ✕
          </button>
        </div>
      )}

      <div
        className={clsx(
          "card-frame px-4 py-3 backdrop-blur-sm border-b border-byz-gold/30",
          !heroUrl && "sticky top-0 z-10",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-byz-parchmentDark">
              {KIND_LABEL[entity.kind]}
              {entity.kind === "person" && entity.role ? ` · ${entity.role}` : null}
              {entity.kind === "event" && entity.category ? ` · ${entity.category}` : null}
            </div>
            <h2 className="font-display text-2xl text-byz-goldLight leading-tight">
              {entity.name}
            </h2>
            <SubtitleLine entity={entity} />
          </div>
          {!heroUrl && (
            <button
              onClick={() => selectEntity(null)}
              aria-label="Close"
              className="text-byz-parchmentDark hover:text-byz-goldLight"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-3 space-y-4 font-body text-byz-parchment leading-relaxed">
        {/* Prefer the LLM-synthesized neutral summary when present (entities
            with 2+ episode mentions); fall back to the longest per-episode
            summary otherwise. */}
        <p className="text-sm">{entity.summary_synthesized || entity.summary}</p>

        {entity.alt_names && entity.alt_names.length > 0 && (
          <div className="text-xs text-byz-parchmentDark italic">
            Also known as: {entity.alt_names.join(" · ")}
          </div>
        )}

        {/* Episode links */}
        <div>
          <div className="text-[10px] uppercase tracking-widest text-byz-goldLight/80 mb-1">
            Mentioned in
          </div>
          <div className="flex flex-wrap gap-1">
            {entity.episodes.map((ep) => {
              // Estimate where in the episode this entity is first mentioned,
              // by line ratio. The audio player resolves this against the
              // episode's actual duration once metadata loads.
              const lines = entity.transcript_lines_by_episode?.[String(ep)];
              const firstLine = lines?.[0]?.[0];
              const totalLines =
                episodesById[ep]?.total_transcript_lines ?? 0;
              const startProgress =
                firstLine != null && totalLines > 0
                  ? Math.max(0, Math.min(1, firstLine / totalLines))
                  : undefined;
              return (
                <EpisodeChip
                  key={ep}
                  episode={ep}
                  startProgress={startProgress}
                />
              );
            })}
          </div>
        </div>

        {/* Per-episode summaries */}
        <details className="text-sm">
          <summary className="cursor-pointer text-byz-goldLight/80 font-display tracking-wider text-xs uppercase">
            What each episode says
          </summary>
          <div className="mt-2 space-y-3">
            {Object.entries(entity.summaries_by_episode)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([ep, text]) => (
                <div key={ep} className="border-l-2 border-byz-gold/40 pl-3">
                  <div className="text-[10px] uppercase tracking-widest text-byz-parchmentDark mb-1">
                    Episode {ep}
                  </div>
                  <p className="text-sm">{text}</p>
                </div>
              ))}
          </div>
        </details>

        {/* Related entities */}
        {entity.related && entity.related.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-widest text-byz-goldLight/80 mb-2">
              Related
            </div>
            <div className="flex flex-wrap gap-1">
              {entity.related.map((r, i) => {
                const rel = getEntity(r.id);
                if (!rel) {
                  // Fallback if not yet a canonical entity
                  return (
                    <span
                      key={i}
                      className="text-xs text-byz-parchmentDark border border-byz-purple/60 rounded-full px-2 py-0.5"
                    >
                      {r.id}
                    </span>
                  );
                }
                return (
                  <button
                    key={i}
                    onClick={() => selectEntity(rel)}
                    className={clsx(
                      "text-xs rounded-full px-2 py-0.5 border transition-colors",
                      rel.kind === "person" &&
                        "border-byz-goldLight/60 text-byz-goldLight hover:bg-byz-gold/20",
                      rel.kind === "place" &&
                        "border-byz-mosaic text-byz-mosaic hover:bg-byz-mosaic/20",
                      rel.kind === "event" &&
                        "border-red-400/60 text-red-300 hover:bg-red-400/20",
                    )}
                  >
                    {rel.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer: external link + share */}
        <div className="flex items-center gap-3 mt-2 pt-2 border-t border-byz-gold/20">
          {entity.wikipedia_url && (
            <a
              href={entity.wikipedia_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-byz-goldLight underline-offset-2 hover:underline text-sm"
            >
              Read on Wikipedia ↗
            </a>
          )}
          <ShareButton entityId={entity.id} />
        </div>
      </div>
    </motion.aside>
  );
}

function ShareButton({ entityId }: { entityId: string }) {
  const [copied, setCopied] = useState(false);

  function onShare() {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    // Make sure id is in URL even if UrlState sync hasn't fired this tick
    const params = new URLSearchParams(window.location.search);
    params.set("id", entityId);
    const fullUrl = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    navigator.clipboard.writeText(fullUrl).catch(() => {
      // Fallback: select-and-copy via a temp input
      const input = document.createElement("input");
      input.value = fullUrl;
      document.body.appendChild(input);
      input.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(input);
    });
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
    void url;
  }

  return (
    <button
      onClick={onShare}
      className="ml-auto text-xs uppercase tracking-widest font-display text-byz-goldLight/80 hover:text-byz-goldLight transition-colors flex items-center gap-1"
      title="Copy a sharable link to this card at this moment in time"
    >
      <span>{copied ? "Copied!" : "Share"}</span>
      <span aria-hidden>{copied ? "✓" : "🔗"}</span>
    </button>
  );
}

function SubtitleLine({ entity }: { entity: AnyEntity }) {
  if (entity.kind === "person") {
    return <PersonDates p={entity as Person} />;
  }
  if (entity.kind === "place") {
    return <PlaceLine p={entity as Place} />;
  }
  if (entity.kind === "event") {
    return <EventLine e={entity as HistoricalEvent} />;
  }
  return null;
}

function PersonDates({ p }: { p: Person }) {
  const parts: string[] = [];
  if (p.reign_start || p.reign_end) {
    parts.push(`reigned ${fmt(p.reign_start)}–${fmt(p.reign_end)}`);
  }
  if (p.birth_year || p.death_year) {
    parts.push(`b. ${fmt(p.birth_year)} · d. ${fmt(p.death_year)}`);
  }
  if (!parts.length) return null;
  return <div className="text-sm text-byz-parchmentDark mt-1">{parts.join(" · ")}</div>;
}

function PlaceLine({ p }: { p: Place }) {
  const parts: string[] = [];
  if (p.modern_name) parts.push(`Modern: ${p.modern_name}`);
  if (p.modern_country) parts.push(p.modern_country);
  if (!parts.length) return null;
  return <div className="text-sm text-byz-parchmentDark mt-1">{parts.join(" · ")}</div>;
}

function EventLine({ e }: { e: HistoricalEvent }) {
  if (!e.year) return null;
  const range = e.end_year && e.end_year !== e.year ? `${fmt(e.year)}–${fmt(e.end_year)}` : fmt(e.year);
  return <div className="text-sm text-byz-parchmentDark mt-1">{range}</div>;
}

function fmt(y: number | null | undefined): string {
  if (y == null) return "?";
  if (y < 0) return `${-y} BC`;
  return `${y}`;
}

function entityHeroUrl(e: AnyEntity): string | null {
  if (e.kind === "person") {
    return e.portrait_url ?? null;
  }
  if (e.kind === "place" || e.kind === "event") {
    return e.image_url ?? null;
  }
  return null;
}

