"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence } from "framer-motion";
import { AppProvider, useApp } from "@/lib/context";
import { timelineBounds, defaultStartYear } from "@/lib/data";
import Timeline from "./Timeline";
import EntityCard from "./EntityCard";
import AudioPlayer from "./AudioPlayer";
import Legend from "./Legend";
import UrlState from "./UrlState";

// Map needs window/document; load client-side only
const WorldMap = dynamic(() => import("./WorldMap"), { ssr: false });

export default function AppShell() {
  const { min, max } = timelineBounds();
  const initialYear = defaultStartYear();

  return (
    <AppProvider initialYear={initialYear}>
      <Inner minYear={min} maxYear={max} />
    </AppProvider>
  );
}

function Inner({ minYear, maxYear }: { minYear: number; maxYear: number }) {
  const { selectedEntity } = useApp();
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-byz-ink">
      <UrlState />
      <WorldMap />
      <Legend />
      <AudioPlayer />
      <AnimatePresence>
        {selectedEntity && <EntityCard entity={selectedEntity} />}
      </AnimatePresence>
      <Timeline minYear={minYear} maxYear={maxYear} />
      <Header />
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
          className={`text-[10px] uppercase tracking-[0.2em] sm:whitespace-nowrap text-byz-parchmentDark hover:text-byz-goldLight underline-offset-2 hover:underline mt-1.5 ${
            expanded ? "block" : "hidden sm:block"
          }`}
        >
          adapted from Lars Brownworth&rsquo;s podcast
        </a>
      </div>
    </div>
  );
}
