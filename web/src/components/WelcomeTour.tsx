"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "@/lib/context";
import { getEntity } from "@/lib/data";

const STORAGE_KEY = "byz-welcome-tour-v1";

type StagePayload = {
  /** Open the audio player in expanded mode while this step is active. */
  expandPlayer?: boolean;
  /** Cue (load without playing) an episode so the expanded player shows
   * the dropdown title + the Sync timeline toggle. */
  cueEpisode?: number;
  /** Open the search panel while this step is active, with `searchQuery`
   * as the input value. */
  searchQuery?: string;
  /** Select an entity (by id) so its card is open. */
  selectEntityId?: string;
  /** Open the karaoke transcript panel while this step is active. Pairs
   * with cueEpisode so the panel has segments to render. */
  openTranscript?: boolean;
};

interface Step {
  /** CSS selector for the element to spotlight. null = centered modal,
   * no spotlight (intro / outro screens). */
  selector: string | null;
  title: string;
  body: ReactNode;
  /** Side-effects to apply on entering this step (auto-open expanded
   * views the step is teaching about). */
  stage?: StagePayload;
  /** Optional rect post-processor — used when the target element's
   * bounds aren't quite the right "highlight area." The density strip
   * sits over the map as a translucent overlay; cutting a hole the
   * full element height also exposes the markers showing through its
   * empty top. Returning a clipped rect keeps the cutout to just the
   * bar zone where the bars actually paint. */
  adjustRect?: (r: DOMRect) => DOMRectInit;
}

const STEPS: Step[] = [
  {
    selector: null,
    title: "Welcome",
    body: (
      <>
        This is an interactive companion to{" "}
        <a
          href="https://12byzantinerulers.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-byz-goldLight underline underline-offset-2 hover:text-byz-gold"
        >
          Lars Brownworth&rsquo;s &ldquo;12 Byzantine Rulers&rdquo; podcast
        </a>{" "}
        which covers the little known Byzantine Empire through the study of
        twelve of its greatest rulers. This quick tour will cover the key
        features which you should try out during the tour.
      </>
    ),
  },
  {
    selector: '[data-byz-tour="ribbon"]',
    title: "The twelve rulers ribbon",
    body: "The ribbon scrolls left and right and follows the timeline. It shows the 12 key rulers in Brownworth's podcast. Try dragging it.",
    // The default HIGHLIGHT_PAD pushes the cutout's top into the
    // density mini-map (revealing bars at the top of the hole) and
    // its bottom down into the main timeline strip. Inset by PAD on
    // top and bottom so the net cutout matches the ribbon's exact
    // vertical bounds — density bars stay dimmed, bottom edge lands
    // flush on the timeline.
    adjustRect: (r) => ({
      x: r.left,
      y: r.top + 6,
      width: r.width,
      height: r.height - 12,
    }),
  },
  {
    selector: ".maplibregl-marker",
    title: "People, places, events",
    body: "Markers on the map represent a person (yellow marker), place (blue marker), or event (red marker). Click on any marker to open a details card. We will learn more about that later in the tour.",
  },
  {
    selector: '[data-byz-tour="legend"]',
    title: "Show or hide by type",
    body: "Show or hide people, places, events, or the empire's territory overlay on the map and timeline below.",
  },
  {
    selector: '[data-byz-tour="density-strip"]',
    title: "Fast forward through time",
    body: "Drag the bar chart to move quickly through the timeline watching the rulers and markers on the map change. The higher bars represent periods in time when there are more markers on the map.",
    // The strip's tallest bars reach close to the top edge — clip only
    // a small sliver off the top (where the strip is mostly empty over
    // the map) so the bars themselves stay fully inside the cutout.
    adjustRect: (r) => ({
      x: r.left,
      y: r.top + r.height * 0.1,
      width: r.width,
      height: r.height * 0.9,
    }),
  },
  {
    selector: '[data-byz-tour="player"]',
    title: "Listen along",
    body: "This is the minimized view of the player showing the current episode and times. Click the play/pause button to play/pause. Click on the widget to expand the player for more features.",
  },
  {
    selector: '[data-byz-tour="player"]',
    title: "Pick an episode and sync the timeline",
    body: "Use the drop down or chevron buttons to change episode, drag the scrubber to seek, and click the small pill to cycle playback speed (1×, 1.25×, 1.5×, 2×, 0.75×). Toggle the chain icon to make the timeline follow the audio — the cursor trails the host's narration and map markers light up as entities are mentioned.",
    stage: { expandPlayer: true, cueEpisode: 7 },
  },
  {
    selector: '[data-byz-tour="transcript-button"]',
    title: "Read along with the transcript",
    body: "Once an episode is loaded, this transcript icon appears beside the player. Click it to open the running transcript.",
    stage: { expandPlayer: true, cueEpisode: 7 },
  },
  {
    selector: '[data-byz-tour="transcript-panel"]',
    title: "Tap any line to jump",
    body: "The active line highlights in sync with the audio as it plays. Tap any line to jump straight to that moment.",
    stage: { expandPlayer: true, cueEpisode: 7, openTranscript: true },
  },
  {
    selector: '[data-byz-tour="search"]',
    title: "Search anything",
    body: "Click the search icon to reveal this panel. Type a name (Belisarius) or a role (general) and pick a result to jump straight to that entity's year and card.",
    stage: { searchQuery: "belisarius" },
  },
  {
    selector: ".card-frame",
    title: "Person, place, or event detail cards",
    body: "Each card collects the synthesized summary, the episodes that mention this entity, the relevant Wikipedia info, and links to related people, places, and events. Use the \"Mentioned in\" chips to skip straight to the moment Brownworth introduces them.",
    stage: { selectEntityId: "constantine-the-great" },
  },
  {
    selector: null,
    title: "Start learning",
    body: "Everything is reachable from the timeline, search, or details on the person, place, or event card. Enjoy learning about the 12 Byzantine Rulers by Lars Brownworth.",
  },
];

const HIGHLIGHT_PAD = 6;
const HIGHLIGHT_RADIUS = 14;
const TIP_W = 400;

// Build a CSS `clip-path: path(evenodd, ...)` that fills the full viewport
// with a rounded-rect hole punched out at the spotlight rect. evenodd lets
// the outer + inner subpaths combine into a "frame with a hole." Keeping
// it on a single element (vs. four side panels) avoids the harsh
// rectangular seams that were showing around the highlight, AND because
// pointer-event hit-testing respects clip-path, clicks in the hole pass
// through to the highlighted control while clicks anywhere else still get
// caught by the dim.
function cutoutClipPath(rect: DOMRect, pad: number, radius: number): string {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = Math.max(0, rect.left - pad);
  const y = Math.max(0, rect.top - pad);
  const w = Math.min(vw - x, rect.width + pad * 2);
  const h = Math.min(vh - y, rect.height + pad * 2);
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const outer = `M0 0H${vw}V${vh}H0Z`;
  const inner =
    `M${x + r} ${y}` +
    `H${x + w - r}` +
    `A${r} ${r} 0 0 1 ${x + w} ${y + r}` +
    `V${y + h - r}` +
    `A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
    `H${x + r}` +
    `A${r} ${r} 0 0 1 ${x} ${y + h - r}` +
    `V${y + r}` +
    `A${r} ${r} 0 0 1 ${x + r} ${y}` +
    `Z`;
  return `path(evenodd, '${outer} ${inner}')`;
}

export default function WelcomeTour() {
  const {
    audioController,
    searchController,
    selectEntity,
    setTranscriptOpen,
  } = useApp();
  const [step, setStep] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // First-load gate: read localStorage; if user hasn't seen the tour, kick
  // it off after a short delay so the WorldMap has time to render markers
  // (the map-marker step targets a marker; missing markers => no rect).
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Headless screenshot escape hatch — used by tools/og-image.sh to
    // capture the bare app for the social-card image without the tour
    // overlay covering everything.
    if (new URLSearchParams(window.location.search).has("notour")) return;
    let seen: string | null = null;
    try {
      seen = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private mode / disabled storage — just don't run the tour.
      return;
    }
    if (seen) return;
    const id = window.setTimeout(() => setStep(0), 1200);
    return () => window.clearTimeout(id);
  }, []);

  // Apply per-step stage effects (expand the player, seed a search,
  // open an entity card). Runs on step change. Cleanup undoes the
  // staging when leaving the step OR dismissing the tour.
  useEffect(() => {
    if (step == null) return;
    const stage = STEPS[step].stage;
    if (!stage) return;

    if (stage.expandPlayer) {
      audioController.current?.setExpanded(true);
    }
    if (stage.cueEpisode != null) {
      audioController.current?.cueEpisode(stage.cueEpisode);
    }
    if (stage.searchQuery != null) {
      searchController.current?.setOpen(true);
      searchController.current?.setQuery(stage.searchQuery);
    }
    if (stage.selectEntityId) {
      const ent = getEntity(stage.selectEntityId);
      if (ent) selectEntity(ent);
    }
    if (stage.openTranscript) {
      setTranscriptOpen(true);
    }

    return () => {
      // Leaving the step: undo what this step staged. Other steps may
      // re-stage on their own.
      if (stage.expandPlayer) {
        audioController.current?.setExpanded(false);
      }
      if (stage.cueEpisode != null) {
        audioController.current?.cueEpisode(null);
      }
      if (stage.searchQuery != null) {
        searchController.current?.setQuery("");
        searchController.current?.setOpen(false);
      }
      if (stage.selectEntityId) {
        selectEntity(null);
      }
      if (stage.openTranscript) {
        setTranscriptOpen(false);
      }
    };
  }, [step, audioController, searchController, selectEntity, setTranscriptOpen]);

  // Recompute the spotlight rect whenever the step or viewport changes.
  // We requery the DOM each tick so dynamically-mounted targets (the
  // expanded player, the search panel, an entity card, etc.) replace
  // their pre-stage placeholder once they render.
  useEffect(() => {
    if (step == null) return;
    const sel = STEPS[step].selector;
    const adjust = STEPS[step].adjustRect;
    function update() {
      if (!sel) {
        setRect(null);
        return;
      }
      const el = document.querySelector(sel) as HTMLElement | null;
      const raw = el ? el.getBoundingClientRect() : null;
      if (!raw) {
        setRect(null);
        return;
      }
      if (adjust) {
        const a = adjust(raw);
        setRect(
          new DOMRect(a.x ?? raw.left, a.y ?? raw.top, a.width ?? raw.width, a.height ?? raw.height),
        );
      } else {
        setRect(raw);
      }
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const intv = window.setInterval(update, 250);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.clearInterval(intv);
    };
  }, [step]);

  // Keyboard shortcuts: Esc skips, Enter / → next, ← back.
  useEffect(() => {
    if (step == null) return;
    function onKey(e: KeyboardEvent) {
      // Don't hijack typing inside the search input the tour is showing.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") dismiss("skipped");
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") prev();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function dismiss(mark: "completed" | "skipped") {
    try {
      window.localStorage.setItem(STORAGE_KEY, mark);
    } catch {
      /* ignore */
    }
    setStep(null);
  }

  function next() {
    if (step == null) return;
    if (step === STEPS.length - 1) dismiss("completed");
    else setStep(step + 1);
  }

  function prev() {
    if (step == null || step === 0) return;
    setStep(step - 1);
  }

  if (step == null) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const isFirst = step === 0;

  // Tooltip placement.
  //   * No target → centered modal.
  //   * Desktop + target is tall enough + side has room → place beside
  //     the target (preferring left, as for tall right-edge panels like
  //     the entity card or expanded player). Below/above wastes space
  //     when the target already eats most of the vertical band.
  //   * Otherwise → below if there's room, else above, else floated at
  //     the bottom (e.g. the entity card on mobile, which fills the
  //     viewport).
  const tipStyle: React.CSSProperties = {};
  if (rect) {
    const M = 16;
    const isDesktop = window.innerWidth >= 768;
    const sideGap = HIGHLIGHT_PAD + 12;
    const fitsLeft = rect.left - sideGap - M >= TIP_W;
    const fitsRight = window.innerWidth - rect.right - sideGap - M >= TIP_W;
    const tallEnough = rect.height >= 200;
    const placeSide = isDesktop && tallEnough && (fitsLeft || fitsRight);

    if (placeSide) {
      if (fitsLeft) {
        tipStyle.right = window.innerWidth - rect.left + sideGap;
      } else {
        tipStyle.left = rect.right + sideGap;
      }
      // Align top with the target's top, clamped so the tip stays in
      // the viewport. Approx tip height of 260 covers the longest
      // body copy in the tour.
      const approxTipH = 260;
      tipStyle.top = Math.max(
        M,
        Math.min(rect.top, window.innerHeight - approxTipH - M),
      );
    } else {
      const spaceBelow = window.innerHeight - rect.bottom - HIGHLIGHT_PAD;
      const spaceAbove = rect.top - HIGHLIGHT_PAD;
      if (spaceBelow > 240) {
        tipStyle.top = rect.bottom + HIGHLIGHT_PAD + 12;
      } else if (spaceAbove > 240) {
        tipStyle.bottom = window.innerHeight - rect.top + HIGHLIGHT_PAD + 12;
      } else {
        tipStyle.bottom = 16;
      }
      const centerX = rect.left + rect.width / 2;
      tipStyle.left = Math.max(
        M,
        Math.min(centerX - TIP_W / 2, window.innerWidth - TIP_W - M),
      );
    }
  } else {
    tipStyle.top = "50%";
    tipStyle.left = "50%";
    tipStyle.transform = "translate(-50%, -50%)";
  }

  // Single full-screen dim with a rounded cutout punched out via
  // clip-path. Hit-testing follows the clip, so clicks inside the hole
  // pass through to the highlighted control (the user can actually
  // drag the ribbon, scrub the density bars, etc.) while clicks
  // anywhere else are absorbed by the dim.
  return (
    <div
      data-byz-tour-overlay
      className="fixed inset-0 z-[100]"
      style={{ pointerEvents: "none" }}
    >
      <div
        className="absolute inset-0 bg-black/65 transition-[clip-path] duration-200 ease-out"
        style={{
          pointerEvents: "auto",
          clipPath: rect
            ? cutoutClipPath(rect, HIGHLIGHT_PAD, HIGHLIGHT_RADIUS)
            : undefined,
        }}
      />
      {rect && (
        <div
          aria-hidden
          className="absolute rounded-[14px] ring-1 ring-byz-goldLight/30 transition-all duration-200 ease-out"
          style={{
            top: rect.top - HIGHLIGHT_PAD,
            left: rect.left - HIGHLIGHT_PAD,
            width: rect.width + HIGHLIGHT_PAD * 2,
            height: rect.height + HIGHLIGHT_PAD * 2,
            pointerEvents: "none",
            boxShadow: "0 0 28px 4px rgba(0,0,0,0.45)",
          }}
        />
      )}

      {/* Tooltip */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="byz-tour-title"
        className="absolute rounded-2xl border border-byz-gold/60 bg-byz-purpleDeep px-5 py-4 shadow-card"
        style={{
          width: TIP_W,
          maxWidth: "calc(100vw - 2rem)",
          pointerEvents: "auto",
          ...tipStyle,
        }}
      >
        <h2
          id="byz-tour-title"
          className="font-display text-byz-goldLight text-base tracking-wider mb-1.5"
        >
          {current.title}
        </h2>
        <p className="text-byz-parchment text-sm leading-relaxed">
          {current.body}
        </p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-byz-parchmentDark text-[10px] font-display tracking-widest uppercase">
            {step + 1} / {STEPS.length}
          </span>
          <div className="flex items-center gap-2">
            {!isFirst && (
              <button
                type="button"
                onClick={prev}
                className="text-byz-parchmentDark hover:text-byz-goldLight text-xs font-display tracking-wider px-2 py-1"
              >
                Back
              </button>
            )}
            {!isLast && (
              <button
                type="button"
                onClick={() => dismiss("skipped")}
                className="text-byz-parchmentDark hover:text-byz-goldLight text-xs font-display tracking-wider px-2 py-1"
              >
                Skip
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="bg-byz-goldLight text-byz-ink hover:bg-byz-gold rounded-full px-4 py-1.5 text-xs font-display font-semibold tracking-wider transition-colors"
            >
              {isLast ? "Got it" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
