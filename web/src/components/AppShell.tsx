"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence } from "framer-motion";
import { AppProvider, useApp } from "@/lib/context";
import {
  defaultStartYear,
  getEntity,
  timelineBounds,
  timelineYear,
} from "@/lib/data";
import Timeline from "./Timeline";
import TimelineMiniMap from "./TimelineMiniMap";
import EntityCard from "./EntityCard";
import AudioPlayer from "./AudioPlayer";
import Legend from "./Legend";
import Search from "./Search";
import Transcript from "./Transcript";
import TranscriptButton from "./TranscriptButton";
import UrlState from "./UrlState";
import WelcomeTour from "./WelcomeTour";

// Map needs window/document; load client-side only
const WorldMap = dynamic(() => import("./WorldMap"), { ssr: false });

export default function AppShell({
  initialEntityId,
}: {
  /** When rendered from a per-entity SSR route (/people/[slug] etc.), the
   * page passes the slug here so the card opens and the cursor lands on
   * the entity's year on first paint — matching whatever metadata Google
   * or social previewed. The home route ("/") leaves this undefined. */
  initialEntityId?: string;
}) {
  const { min, max } = timelineBounds();
  const initialEntity = initialEntityId ? getEntity(initialEntityId) ?? null : null;
  const initialYear =
    initialEntity != null
      ? timelineYear(initialEntity) ?? defaultStartYear()
      : defaultStartYear();

  return (
    <AppProvider
      initialYear={initialYear}
      initialSelectedEntity={initialEntity}
    >
      <Inner minYear={min} maxYear={max} />
    </AppProvider>
  );
}

// Height of the strips area BELOW the map (ruler ribbon 58 + main strip 70).
// The density mini-map stays inside the map area as a translucent overlay,
// per design preference — the geography reads through the bars.
export const STRIPS_AREA_HEIGHT_PX = 58 + 70;
export const DENSITY_HEIGHT_PX = 96;

function Inner({ minYear, maxYear }: { minYear: number; maxYear: number }) {
  const { selectedEntity } = useApp();
  return (
    <main className="flex flex-col h-[100dvh] w-screen overflow-hidden bg-byz-ink">
      <UrlState />

      {/* Map area: takes everything ABOVE the ruler ribbon + main strip.
          The density mini-map sits at the BOTTOM of this area as a
          translucent overlay, so the geography keeps reading through the
          density bars without the ribbon/strip eating clickable map. */}
      <div className="relative flex-1 overflow-hidden">
        <WorldMap />
        <Legend />
        <AudioPlayer />
        <TranscriptButton />
        <Search />
        <AnimatePresence>
          {selectedEntity && <EntityCard entity={selectedEntity} />}
        </AnimatePresence>
        <Transcript />
        <Header />
        {/* Density mini-map overlays the map's bottom band. It captures
            its own pointer events so drag-to-scrub works (otherwise the
            map's own pan handler eats the gesture). Markers that fall
            in this band can't be clicked through the bars; the bars are
            translucent so the map still reads through them. */}
        <div
          className="absolute left-0 right-0 bottom-0"
          style={{ height: DENSITY_HEIGHT_PX }}
        >
          <TimelineMiniMap minYear={minYear} maxYear={maxYear} />
        </div>
      </div>

      {/* Strips area: ruler ribbon + main scrub strip. Solid region (no
          map underneath) so every marker on the map above stays
          clickable. */}
      <div
        className="relative shrink-0"
        style={{ height: STRIPS_AREA_HEIGHT_PX }}
      >
        <Timeline minYear={minYear} maxYear={maxYear} />
      </div>

      <WelcomeTour />
    </main>
  );
}

function Header() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="absolute top-2 sm:top-4 left-1/2 -translate-x-1/2 z-20 max-w-[calc(100vw-1rem)]">
      <div className="rounded-lg border border-byz-gold/60 bg-byz-purpleDeep/95 px-3 sm:px-5 py-1.5 sm:py-2 text-center shadow-card">
        {/* Title — tap-to-toggle on mobile (mobile-only chevron implied by the
            cursor); on desktop the subtitle is always visible so this acts
            like static text. */}
        <h1
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="font-display text-byz-goldLight text-base sm:text-2xl tracking-wider sm:tracking-widest leading-none whitespace-nowrap cursor-pointer sm:cursor-default select-none"
        >
          Twelve Byzantine Rulers
        </h1>
        {/* Subtitle: linked to Brownworth's podcast site. Always shown on
            >= sm; on mobile, shown only when the title is tapped. */}
        <a
          href="https://12byzantinerulers.com/"
          target="_blank"
          rel="noopener noreferrer"
          className={`text-[10px] uppercase tracking-[0.2em] sm:whitespace-nowrap text-byz-parchmentDark hover:text-byz-goldLight underline underline-offset-2 mt-1.5 ${
            expanded ? "block" : "hidden sm:block"
          }`}
        >
          adapted from Lars Brownworth&rsquo;s podcast
        </a>
      </div>
    </div>
  );
}
