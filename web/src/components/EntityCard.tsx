"use client";

import { motion } from "framer-motion";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/context";
import { entities, getEntity } from "@/lib/data";
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
  const heroUrl = entity.image_url ?? null;
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
      // Welcome tour stages an open card during its "Entity card" step —
      // its tooltip lives outside the card, but clicking "Next" should
      // not deselect the entity.
      if (target.closest("[data-byz-tour-overlay]")) return;
      selectEntity(null);
    }

    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [selectEntity]);

  // 12-ruler badge: only meaningful for the protagonist of one of the 12
  // ruler-titled episodes. We surface their podcast ordinal (Ruler N of 12)
  // and their reign years instead of a generic "Twelve Rulers" label.
  const isTwelveRuler =
    entity.kind === "person" && entity.is_twelve_ruler === true;
  const rulerBadge =
    isTwelveRuler && entity.kind === "person"
      ? buildRulerBadge(entity as Person)
      : null;

  return (
    <motion.aside
      key={entity.id}
      ref={cardRef}
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: "spring", stiffness: 200, damping: 25 }}
      className={clsx(
        "fixed z-50 overflow-y-auto byz-scroll card-frame shadow-card !border-l-8",
        "inset-0 rounded-none",
        "sm:inset-auto sm:right-4 sm:top-32 sm:rounded-xl sm:w-[570px] sm:max-w-[45vw] sm:max-h-[calc(100vh-394px)]",
        // Match the marker hex for each kind exactly so the card's left
        // bar reads as the same color family as the dot you clicked on.
        // 12-rulers get a brighter gold to mark them as the headline figures.
        entity.kind === "person" && !isTwelveRuler && "card-person !border-l-[#e7c873]",
        entity.kind === "person" && isTwelveRuler && "card-person !border-l-[#fce58a]",
        entity.kind === "place" && "card-place !border-l-[#3a6b8c]",
        entity.kind === "event" && "card-event !border-l-[#b44646]",
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
          {rulerBadge && (
            <div
              className="absolute top-2 left-2 z-10 rounded-full bg-byz-purpleDeep/85 border border-[#fce58a] text-[#fce58a] text-[10px] font-display tracking-widest px-2 py-0.5 uppercase"
              title={`Number ${rulerBadge.ordinal} of the twelve Byzantine rulers featured in the podcast`}
            >
              ★ {rulerBadge.text}
            </div>
          )}
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
              {!heroUrl && rulerBadge && (
                <span
                  className="ml-2 align-middle inline-block rounded-full border border-[#fce58a] text-[#fce58a] text-[9px] tracking-widest px-1.5 py-0.5 uppercase"
                  title={`Number ${rulerBadge.ordinal} of the twelve Byzantine rulers featured in the podcast`}
                >
                  ★ {rulerBadge.text}
                </span>
              )}
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
        <p className="text-sm">{entity.summary}</p>

        {entity.alt_names && entity.alt_names.length > 0 && (
          <div className="text-xs text-byz-parchmentDark italic">
            Also known as: {entity.alt_names.join(" · ")}
          </div>
        )}

        {/* Episode links — chips seek to the entity's first segment-level
            mention in the episode (absolute seconds, not a line approximation).
            entity.episodes can include episodes the data pipeline associated
            with the entity (e.g. via Wikipedia or related-entity links) but
            where Whisper found zero transcript mentions. Those blocks have
            score 0 / mention_count 0 / first_mention null, and produce
            chips that either do nothing or restart the episode at 0 — both
            user-confusing. Filter to chips with at least one real mention. */}
        {(() => {
          const playable = entity.episodes
            .map((ep) => ({
              ep,
              block: entity.summaries_by_episode?.[String(ep)],
            }))
            .filter(
              ({ block }) =>
                block &&
                (block.mention_count ?? 0) > 0 &&
                block.first_mention_seconds != null,
            );
          if (playable.length === 0) return null;
          return (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-byz-goldLight/80 mb-1">
                Mentioned in
              </div>
              <div className="flex flex-wrap gap-1">
                {playable.map(({ ep, block }) => (
                  <EpisodeChip
                    key={ep}
                    episode={ep}
                    startSeconds={block!.first_mention_seconds}
                  />
                ))}
              </div>
            </div>
          );
        })()}

        {/* Per-episode commentary — pairs the LLM's summary with verbatim
            transcript excerpts pulled straight from the segment-level Whisper
            output. The excerpts give the user actual Brownworth, while the
            summary frames it. */}
        <details className="text-sm">
          <summary className="cursor-pointer text-byz-goldLight/80 font-display tracking-wider text-xs uppercase">
            What each episode says
          </summary>
          <div className="mt-2 space-y-3">
            {Object.entries(entity.summaries_by_episode)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([ep, block]) => {
                const excerpts = entity.excerpts_by_episode?.[ep] ?? [];
                return (
                  <div key={ep} className="border-l-2 border-byz-gold/40 pl-3">
                    <div className="text-[10px] uppercase tracking-widest text-byz-parchmentDark mb-1">
                      <span>Episode {ep}</span>
                      {block.mention_count > 0 && (
                        <span className="text-byz-parchmentDark/60 normal-case tracking-normal text-[10px]">
                          {" "}
                          ({block.mention_count} mention{block.mention_count === 1 ? "" : "s"})
                        </span>
                      )}
                    </div>
                    {block.summary && (
                      <p className="text-sm">{block.summary}</p>
                    )}
                    {excerpts.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {excerpts.map((ex, i) => (
                          <blockquote
                            key={i}
                            className="text-[12px] italic text-byz-parchmentDark/90 border-l border-byz-gold/30 pl-2"
                            title={`segment @ ${formatSeconds(ex.start)}`}
                          >
                            &ldquo;{ex.text}&rdquo;
                          </blockquote>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
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
    const params = new URLSearchParams(window.location.search);
    params.set("id", entityId);
    const fullUrl = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    navigator.clipboard.writeText(fullUrl).catch(() => {
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

/** Builds the "Ruler N: reigned X-Y" pill text for a 12-rulers person.
 * Returns null if we can't determine an ordinal. */
function buildRulerBadge(p: Person): { ordinal: number; text: string } | null {
  const idx = entities.twelve_rulers.indexOf(p.id);
  if (idx < 0) return null;
  const ordinal = idx + 1;
  const reign =
    p.reign_start && p.reign_end
      ? `reigned ${formatYearShort(p.reign_start)}–${formatYearShort(p.reign_end)}`
      : p.reign_start
        ? `reigned from ${formatYearShort(p.reign_start)}`
        : null;
  return {
    ordinal,
    text: reign ? `Ruler ${ordinal}: ${reign}` : `Ruler ${ordinal} of 12`,
  };
}

function formatYearShort(y: number | null | undefined): string {
  if (y == null) return "?";
  if (y < 0) return `${-y} BC`;
  return `${y}`;
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

function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

void episodesById;
