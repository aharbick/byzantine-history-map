"use client";

import { useEffect, useRef } from "react";
import { useApp } from "@/lib/context";
import { getEntity } from "@/lib/data";

/**
 * Reflects (currentYear, selectedEntity) into the URL as ?year=&id=, and
 * restores them on mount so deep-links like /?year=330&id=constantine-the-great
 * land in exactly the right state.
 *
 * Renders nothing.
 */
export default function UrlState() {
  const { currentYear, selectedEntity, setCurrentYear, selectEntity } = useApp();
  const hasInitialized = useRef(false);

  // On mount, read URL → restore state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    const params = new URLSearchParams(window.location.search);
    const yearStr = params.get("year");
    const id = params.get("id");
    if (yearStr) {
      const y = parseFloat(yearStr);
      if (!Number.isNaN(y)) setCurrentYear(y);
    }
    if (id) {
      const e = getEntity(id);
      if (e) selectEntity(e);
    }
  }, [setCurrentYear, selectEntity]);

  // Push state → URL whenever year or selection change. We use replaceState
  // (not push) so users don't accumulate hundreds of history entries while
  // scrubbing — and we DEBOUNCE because iOS Safari rate-limits replaceState
  // (~100 calls / 30s) and will kill the tab if exceeded. During a fast drag
  // the user is firing hundreds of year updates per second; we only need the
  // URL to reflect where they ended up.
  useEffect(() => {
    if (!hasInitialized.current) return;
    if (typeof window === "undefined") return;
    const t = window.setTimeout(() => {
      const params = new URLSearchParams();
      params.set("year", String(Math.round(currentYear)));
      if (selectedEntity) params.set("id", selectedEntity.id);
      const qs = params.toString();
      const newUrl = `${window.location.pathname}?${qs}`;
      if (window.location.search !== `?${qs}`) {
        window.history.replaceState(null, "", newUrl);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [currentYear, selectedEntity]);

  return null;
}
