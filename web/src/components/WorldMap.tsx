"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { Map as MlMap, Marker } from "maplibre-gl";
import { useApp } from "@/lib/context";
import {
  entityCoords,
  allEntities,
  isActiveAt,
  memberOf,
  CLUSTER_THRESHOLD,
  defaultStartYear,
} from "@/lib/data";
import type { AnyEntity } from "@/lib/types";

// "voyager-nolabels" strips all modern country borders and city names — perfect
// for a historical map where Istanbul should read as "Constantinople" via our
// own place markers. Coastlines, rivers, and shaded relief remain.
const STYLE = "https://basemaps.cartocdn.com/gl/voyager-nolabels-gl-style/style.json";
// Lng anchored on Constantinople — the empire's capital and the visual
// center for east-west balance. Lat is data-driven (see initialView): we
// pick zoom so every marker's latitude is on-screen, even if that means
// some markers fall off the map's east/west edges. Vertical truncation
// hides the UK / Roman Britain entirely; horizontal truncation just clips
// the easternmost edge of Persia, which is acceptable.
const INITIAL_LNG = 28.949;
// Pixel padding kept above/below the northernmost/southernmost marker so
// the marker glyphs themselves (≈40–50px tall) don't get clipped at the
// top/bottom edges. This is in addition to whatever space the timeline
// strip already takes from the map container.
const INITIAL_PADDING_PX = 36;

const KIND_COLOR: Record<AnyEntity["kind"], string> = {
  person: "#e7c873",
  place: "#3a6b8c",
  event: "#b44646",
};

// Cached lat extent of every entity that has resolvable coordinates.
// Static across the session (entity data doesn't change at runtime), so we
// compute it lazily on first use.
let MARKER_LAT_RANGE: { south: number; north: number } | null = null;
function getMarkerLatRange(): { south: number; north: number } {
  if (MARKER_LAT_RANGE) return MARKER_LAT_RANGE;
  let south = Infinity;
  let north = -Infinity;
  for (const e of allEntities) {
    const c = entityCoords(e);
    if (!c) continue;
    if (c.lat < south) south = c.lat;
    if (c.lat > north) north = c.lat;
  }
  MARKER_LAT_RANGE = { south, north };
  return MARKER_LAT_RANGE;
}

// Solve for the zoom level that makes [latS, latN] span exactly heightPx
// pixels in MapLibre's Mercator projection. Each zoom step doubles tile
// pixel size, so we solve algebraically rather than letting fitBounds work
// it out — fitBounds also constrains horizontally, but the user explicitly
// wants vertical fit even if markers fall off the east/west edges.
function zoomForLatRange(latS: number, latN: number, heightPx: number): number {
  const TILE = 512;
  const yNorm = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return 0.5 - Math.asinh(Math.tan(r)) / (2 * Math.PI);
  };
  const dy = Math.abs(yNorm(latS) - yNorm(latN));
  if (dy <= 0 || heightPx <= 0) return 4;
  return Math.log2(heightPx / (dy * TILE));
}

// Compute the initial map view (center + zoom) so every marker's latitude
// is visible inside the container. Lng stays anchored on Constantinople;
// lat-center is the midpoint of the marker lat extent so the fit is
// symmetric north and south.
function initialView(container: HTMLElement): {
  center: [number, number];
  zoom: number;
} {
  const { south, north } = getMarkerLatRange();
  const usable = Math.max(container.clientHeight - 2 * INITIAL_PADDING_PX, 1);
  const zoom = zoomForLatRange(south, north, usable);
  return { center: [INITIAL_LNG, (south + north) / 2], zoom };
}

export default function WorldMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map()); // entity-key -> marker
  const clustersRef = useRef<Map<string, Marker>>(new Map()); // groupKey -> marker
  const [mapReady, setMapReady] = useState(0);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  // Saved map view to restore when a card closes (so the user gets back the
  // map they were looking at before opening the card).
  const prePanRef = useRef<{ center: maplibregl.LngLat; zoom: number } | null>(null);
  const {
    currentYear,
    selectedEntity,
    selectEntity,
    setCurrentYear,
    filters,
    audioFocusEntityIds,
    territoryOverlayOn,
  } = useApp();
  // Mirror selectedEntity into a ref so the marker click handlers (created
  // once at marker construction) can read the *current* value without stale
  // closures — needed for click-to-toggle behavior.
  const selectedRef = useRef<AnyEntity | null>(null);
  selectedRef.current = selectedEntity;

  // Init map once per mount
  useEffect(() => {
    if (!containerRef.current) return;
    const initial = initialView(containerRef.current);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: initial.center,
      zoom: initial.zoom,
      attributionControl: { compact: true },
    });
    map.addControl(
      new maplibregl.NavigationControl({
        showZoom: true,
        showCompass: false,
        visualizePitch: false,
      }),
      "top-right",
    );
    // Custom reset control sits in its own group right below the zoom group,
    // styled by MapLibre so it visually matches.
    map.addControl(
      new ResetControl(() => {
        setCurrentYear(defaultStartYear());
        selectEntity(null);
        const v = initialView(containerRef.current!);
        map.easeTo({
          center: v.center,
          zoom: v.zoom,
          bearing: 0,
          pitch: 0,
          duration: 700,
        });
        prePanRef.current = null;
      }),
      "top-right",
    );
    map.scrollZoom.disable();

    // MapLibre's `compact: true` uses the compact UI but the panel still
    // renders OPEN on first load — credits cover the bottom-right corner
    // until the user clicks them away. Strip the open-state class once
    // the control has been added so the attribution starts as just the
    // small [i] icon. The control attaches during `load`; remove the
    // class then.
    map.once("load", () => {
      const attribEl = containerRef.current?.querySelector(
        ".maplibregl-ctrl-attrib.maplibregl-compact",
      );
      if (attribEl) attribEl.classList.remove("maplibregl-compact-show");
    });

    mapRef.current = map;
    setMapReady((n) => n + 1);

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      for (const m of markersRef.current.values()) m.remove();
      markersRef.current.clear();
      for (const m of clustersRef.current.values()) m.remove();
      clustersRef.current.clear();
      map.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
  }, []);

  // Sync markers + clusters for entities active at currentYear.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Audio-focused entities are forced into the rendered set even when
    // they fall outside `isActiveAt(currentYear)`. Otherwise, when an
    // anchor for a place (Jerusalem at first_year=312) and an event (True
    // Cross at year=630) overlap in the same Whisper segment, the
    // auto-scrub picks one year and the other entity's marker disappears
    // — there's nothing on the map to apply the focus class to.
    const focusForce = new Set(audioFocusEntityIds);

    // Pre-compute which coord groups have 2+ focused entities currently
    // lit. Those groups need a wider per-marker offset so the enlarged
    // discs ("True Cross" + "Jerusalem" both at Jerusalem coord) don't
    // overlap into a single mush.
    const focusGroupCounts = new Map<string, number>();
    for (const id of audioFocusEntityIds) {
      const ent = allEntities.find((x) => x.id === id);
      const m = ent ? memberOf(ent) : null;
      if (!m) continue;
      focusGroupCounts.set(m.groupKey, (focusGroupCounts.get(m.groupKey) ?? 0) + 1);
    }

    // Group entities by coord. Track active vs. forced separately so the
    // clustering decision uses only the active count: forced entities push
    // a few markers into the rendered set without triggering cluster mode
    // for the whole group.
    type Bucket = {
      coords: { lat: number; lng: number };
      active: AnyEntity[];
      forced: AnyEntity[];
    };
    const activeByGroup = new Map<string, Bucket>();

    for (const e of allEntities) {
      if (!filters[e.kind]) continue;
      const isActive = isActiveAt(e, currentYear);
      const isForced = focusForce.has(e.id);
      if (!isActive && !isForced) continue;
      const m = memberOf(e);
      if (!m) continue;
      let bucket = activeByGroup.get(m.groupKey);
      if (!bucket) {
        bucket = { coords: m.coords, active: [], forced: [] };
        activeByGroup.set(m.groupKey, bucket);
      }
      // An entity active in the current year takes the active slot; forced-
      // only entities go to the forced slot. (Both flags set means active —
      // forced is a strict superset.)
      if (isActive) bucket.active.push(e);
      else bucket.forced.push(e);
    }

    const wantedMarkerKeys = new Set<string>();
    const wantedClusterKeys = new Set<string>();

    for (const [groupKey, bucket] of activeByGroup) {
      // Clustering is gated by the ACTIVE count only. Forced entities are
      // always rendered as individual markers so their focus class can land
      // on a real DOM element, even if the cluster pin also covers the spot.
      const clustered = bucket.active.length >= CLUSTER_THRESHOLD;
      const isExpanded = expandedGroup === groupKey;

      if (clustered && !isExpanded) {
        wantedClusterKeys.add(groupKey);
        const dominantKind = pickDominantKind(bucket.active);
        if (!clustersRef.current.has(groupKey)) {
          const el = buildClusterElement(
            bucket.active.length,
            dominantKind,
            () => setExpandedGroup(groupKey),
          );
          el.dataset.groupKey = groupKey;
          const m = new maplibregl.Marker({ element: el, anchor: "center" })
            .setLngLat([bucket.coords.lng, bucket.coords.lat])
            .addTo(map);
          clustersRef.current.set(groupKey, m);
        } else {
          const existing = clustersRef.current.get(groupKey)!;
          updateCluster(existing.getElement(), bucket.active.length, dominantKind);
        }
        // Still render any forced-only entities as individual markers on
        // top of the cluster, so the focus pulse has something to land on.
        for (const e of bucket.forced) {
          renderIndividual(e, isExpanded, bucket.coords);
        }
        continue;
      }

      // Not clustered — render every entity (active + forced) individually.
      for (const e of bucket.active) renderIndividual(e, isExpanded, bucket.coords);
      for (const e of bucket.forced) renderIndividual(e, isExpanded, bucket.coords);
    }

    function renderIndividual(
      e: AnyEntity,
      isExpanded: boolean,
      coords: { lat: number; lng: number },
    ) {
      const member = memberOf(e)!;
      // When the marker is part of a multi-focus burst (2+ audio-focused
      // entities at this coord), use the wider spider offset so the
      // enlarged focus discs don't pile on top of each other.
      const focusedHere = (focusGroupCounts.get(member.groupKey) ?? 0) >= 2;
      const useSpider = isExpanded || (focusForce.has(e.id) && focusedHere);
      const offset = useSpider ? member.spiderOffset : member.fanOffset;
      const key = `${e.kind}:${e.id}`;
      wantedMarkerKeys.add(key);
      const existing = markersRef.current.get(key);
      if (existing) {
        existing.setOffset(offset);
      } else {
        const el = buildMarkerElement(e, () => {
          if (selectedRef.current?.id === e.id) selectEntity(null);
          else selectEntity(e);
        });
        el.dataset.entityKey = key;
        const m = new maplibregl.Marker({ element: el, anchor: "center", offset })
          .setLngLat([coords.lng, coords.lat])
          .addTo(map!);
        markersRef.current.set(key, m);
      }
    }

    // Remove markers/clusters that are no longer wanted
    for (const [key, marker] of markersRef.current) {
      if (!wantedMarkerKeys.has(key)) {
        marker.remove();
        markersRef.current.delete(key);
      }
    }
    for (const [key, marker] of clustersRef.current) {
      if (!wantedClusterKeys.has(key)) {
        marker.remove();
        clustersRef.current.delete(key);
      }
    }
  }, [currentYear, selectEntity, filters, mapReady, expandedGroup, audioFocusEntityIds]);

  // Apply selected styling to the matching marker
  useEffect(() => {
    const selectedKey = selectedEntity ? `${selectedEntity.kind}:${selectedEntity.id}` : null;
    for (const [key, m] of markersRef.current) {
      const el = m.getElement();
      if (key === selectedKey) {
        el.classList.add("byz-marker-selected");
      } else {
        el.classList.remove("byz-marker-selected");
      }
    }
  }, [selectedEntity, currentYear, mapReady, expandedGroup]);

  // Apply audio-focus styling — every entity currently in the focus set
  // gets `byz-marker-focus` so its marker renders larger / on top. Multiple
  // recent mentions can be lit at once; each ages out independently.
  // If the latest focused entity sits inside a clustered group, expand that
  // group so an individual marker exists to receive the class. (Older
  // focuses already in clusters may be obscured by their cluster pin — a
  // tradeoff against constantly re-expanding every group as audio progresses.)
  useEffect(() => {
    const focusSet = new Set(audioFocusEntityIds);
    const newest = audioFocusEntityIds[audioFocusEntityIds.length - 1];
    if (newest) {
      const entity = allEntities.find((e) => e.id === newest);
      const member = entity ? memberOf(entity) : null;
      if (member && expandedGroup !== member.groupKey) {
        let activeInGroup = 0;
        for (const o of allEntities) {
          if (!filters[o.kind]) continue;
          if (!isActiveAt(o, currentYear)) continue;
          const om = memberOf(o);
          if (om?.groupKey === member.groupKey) activeInGroup++;
        }
        if (activeInGroup >= CLUSTER_THRESHOLD) {
          setExpandedGroup(member.groupKey);
        }
      }
    }

    for (const [key, m] of markersRef.current) {
      const el = m.getElement();
      const id = key.split(":")[1];
      if (focusSet.has(id)) {
        el.classList.add("byz-marker-focus");
      } else {
        el.classList.remove("byz-marker-focus");
      }
    }
  }, [audioFocusEntityIds, currentYear, mapReady, expandedGroup, filters]);

  // Selection effect: expand clustered groups when needed; pan ONLY if the
  // selected dot is genuinely offscreen; restore the prior map view on close.
  // Skipped entirely on mobile — the card covers the whole viewport there,
  // so panning the map underneath is wasted motion the user can't see.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // sm breakpoint = 640px; below that the card is a full-screen overlay.
    const isMobile =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 639px)").matches;

    if (!selectedEntity) {
      setExpandedGroup(null);
      // Restore the map view we saved before panning, if any.
      if (prePanRef.current) {
        map.easeTo({
          center: prePanRef.current.center,
          zoom: prePanRef.current.zoom,
          duration: 500,
        });
        prePanRef.current = null;
      }
      return;
    }

    const member = memberOf(selectedEntity);
    if (member) {
      let activeInGroup = 0;
      for (const o of allEntities) {
        const om = memberOf(o);
        if (!om || om.groupKey !== member.groupKey) continue;
        if (!filters[o.kind]) continue;
        if (!isActiveAt(o, currentYear)) continue;
        activeInGroup++;
      }
      setExpandedGroup(activeInGroup >= CLUSTER_THRESHOLD ? member.groupKey : null);
    }

    if (isMobile) return; // card covers the map; nothing to pan around

    const c = entityCoords(selectedEntity);
    if (!c) return;

    // Pan only if the dot is actually OFFSCREEN. Don't pan just because the
    // card overlaps it — on desktop the card is a side panel; this only
    // moves the map when the dot would otherwise be hidden behind it.
    const point = map.project([c.lng, c.lat]);
    const container = map.getContainer().getBoundingClientRect();
    const margin = 60;
    const offscreen =
      point.x < margin ||
      point.x > container.width - margin ||
      point.y < margin ||
      point.y > container.height - margin;

    if (offscreen) {
      // Save current view so we can restore on close.
      if (!prePanRef.current) {
        prePanRef.current = { center: map.getCenter(), zoom: map.getZoom() };
      }
      map.easeTo({ center: [c.lng, c.lat], duration: 700 });
    }
  }, [selectedEntity, mapReady]);

  // Click anywhere on the map (not on a marker) collapses an expanded cluster.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onMapClick = () => setExpandedGroup(null);
    map.on("click", onMapClick);
    return () => {
      map.off("click", onMapClick);
    };
  }, [mapReady]);

  // -------------------------------------------------------------------
  // Territory overlay
  //
  // One stable GeoJSON source + fill/line layer per keyframe century.
  // All keyframes are pre-fetched once on mount, populated into their
  // sources, and then we just animate opacity per `currentYear` tick.
  //
  // Earlier we tried 2 sources whose `data` payload swapped at
  // century boundaries — but that produced visible blips during slow
  // scrubbing because MapLibre's GeoJSON source updates land on a
  // different RAF tick than the matching `setPaintProperty` opacity
  // change. With per-keyframe layers, no data ever swaps after mount;
  // only opacity changes, which apply atomically.
  //
  // Why opacity blend instead of a true geometry tween: MapLibre can't
  // morph polygons between non-matching feature schemas, and we
  // intentionally embrace the fade — the underlying data is only
  // century-resolution, so showing a single hard polygon during the
  // years between keyframes would imply more precision than we have.
  // -------------------------------------------------------------------
  const territoryFeaturesRef = useRef<Map<number, GeoJSON.Feature>>(new Map());
  // Counter that ticks once per keyframe-fetch completion. Threaded into
  // the opacity effect's deps so it re-runs whenever new data lands —
  // necessary on deep-link loads (?year=448), where the opacity effect
  // would otherwise run exactly once on mount, set opacity for layers
  // whose data was still in flight, and never get a second chance to
  // paint until the user scrubbed.
  const [territoryLoadedCount, setTerritoryLoadedCount] = useState(0);

  // Stand up one source + fill + line layer per keyframe once the map
  // style has loaded. Then kick off a one-shot fetch for each keyframe
  // and write the data into its source. Sources stay mounted whether
  // or not the overlay is toggled on — opacity drives visibility, so
  // toggling is instant and doesn't churn the GL state.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    function ensureTerritoryLayers() {
      if (!map) return;
      const empty: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: [],
      };
      for (const year of TERRITORY_KEYFRAMES) {
        const sourceId = `territory-${year}`;
        if (map.getSource(sourceId)) continue;
        map.addSource(sourceId, { type: "geojson", data: empty });
        map.addLayer({
          id: `${sourceId}-fill`,
          type: "fill",
          source: sourceId,
          paint: { "fill-color": "#e7c873", "fill-opacity": 0 },
        });
        map.addLayer({
          id: `${sourceId}-line`,
          type: "line",
          source: sourceId,
          paint: {
            "line-color": "#c9a227",
            "line-width": 1.5,
            "line-opacity": 0,
          },
        });
      }
      // Pre-fetch every keyframe once. After this completes, `setData`
      // is never called again — only `setPaintProperty` per tick. This
      // is what eliminates the boundary-crossing blip.
      for (const year of TERRITORY_KEYFRAMES) {
        if (territoryFeaturesRef.current.has(year)) continue;
        fetch(`/territory/${year}.json`)
          .then((r) => (r.ok ? r.json() : null))
          .then((feat: GeoJSON.Feature | null) => {
            if (!feat) return;
            territoryFeaturesRef.current.set(year, feat);
            const src = map?.getSource(`territory-${year}`);
            if (src && "setData" in src) {
              (src as maplibregl.GeoJSONSource).setData({
                type: "FeatureCollection",
                features: [feat],
              });
            }
            // Wake the opacity effect so it re-applies for any layer
            // whose data just arrived (matters when a deep link lands
            // on a year whose bracketing keyframes weren't loaded yet).
            setTerritoryLoadedCount((n) => n + 1);
          })
          .catch(() => {
            /* swallow — layer just stays empty for this keyframe */
          });
      }
    }

    if (map.isStyleLoaded()) ensureTerritoryLayers();
    else map.once("load", ensureTerritoryLayers);
  }, [mapReady]);

  // Sync the overlay to currentYear + the user's toggle state. Per tick:
  // pick the two bracketing keyframes, set their layers' opacities, and
  // ZERO every other keyframe's opacity. Cheap — at most 13 layers and
  // 4 setPaintProperty calls (the active two each have a fill + line).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Sources may not be mounted yet on the first render after map load.
    if (!map.getSource(`territory-${TERRITORY_KEYFRAMES[0]}`)) return;

    const FILL_OPACITY = 0.28;
    const LINE_OPACITY = 0.8;

    const { prev, next, t } = pickTerritoryKeyframes(currentYear);
    const prevWeight = territoryOverlayOn && prev != null ? 1 - t : 0;
    const nextWeight = territoryOverlayOn && next != null ? t : 0;

    for (const year of TERRITORY_KEYFRAMES) {
      const w = year === prev ? prevWeight : year === next ? nextWeight : 0;
      map.setPaintProperty(
        `territory-${year}-fill`,
        "fill-opacity",
        w * FILL_OPACITY,
      );
      map.setPaintProperty(
        `territory-${year}-line`,
        "line-opacity",
        w * LINE_OPACITY,
      );
    }
  }, [currentYear, territoryOverlayOn, mapReady, territoryLoadedCount]);

  return <div ref={containerRef} className="absolute inset-0" />;
}

// Keyframes mirror data/build_territory_maps.py KEYFRAMES. 284 covers
// Diocletian's accession (his reign was 284–305) — synthesized from 300
// since the upstream data starts at 300 and the tetrarchic territory was
// effectively static across Diocletian's reign.
const TERRITORY_KEYFRAMES = [
  284, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400,
];

/** Pick the two surrounding keyframes for `year` and a 0..1 interpolation
 * weight `t`. `prev=null` => before the earliest keyframe (don't render).
 * `next=null` => past the last keyframe (render `prev` at full strength). */
function pickTerritoryKeyframes(year: number): {
  prev: number | null;
  next: number | null;
  t: number;
} {
  if (year < TERRITORY_KEYFRAMES[0]) return { prev: null, next: null, t: 0 };
  const last = TERRITORY_KEYFRAMES[TERRITORY_KEYFRAMES.length - 1];
  if (year >= last) return { prev: last, next: null, t: 0 };
  for (let i = 0; i < TERRITORY_KEYFRAMES.length - 1; i++) {
    const lo = TERRITORY_KEYFRAMES[i];
    const hi = TERRITORY_KEYFRAMES[i + 1];
    if (year >= lo && year < hi) {
      return { prev: lo, next: hi, t: (year - lo) / (hi - lo) };
    }
  }
  return { prev: last, next: null, t: 0 };
}

/* ----- marker element builder ----- */

function buildMarkerElement(e: AnyEntity, onClick: () => void): HTMLElement {
  const wrapper = document.createElement("button");
  wrapper.className = "byz-marker group";
  wrapper.setAttribute("aria-label", e.name);
  wrapper.style.setProperty("--marker-color", KIND_COLOR[e.kind]);
  wrapper.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });

  const disc = document.createElement("span");

  // Unified image_url across all kinds.
  const imageUrl = e.image_url ?? null;

  if (imageUrl) {
    disc.className = "byz-marker-disc byz-marker-disc--image";
    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = "";
    img.loading = "lazy";
    img.draggable = false;
    disc.appendChild(img);
  } else {
    // No image: small colored dot, no letter.
    disc.className = "byz-marker-disc byz-marker-disc--dot";
  }
  wrapper.appendChild(disc);

  const label = document.createElement("span");
  label.className = "byz-marker-label";
  label.textContent = e.name;
  wrapper.appendChild(label);

  return wrapper;
}

/* ----- cluster element builder ----- */

function pickDominantKind(entities: AnyEntity[]): AnyEntity["kind"] {
  const counts: Record<AnyEntity["kind"], number> = { person: 0, place: 0, event: 0 };
  for (const e of entities) counts[e.kind]++;
  let best: AnyEntity["kind"] = "person";
  let bestCount = -1;
  for (const k of ["person", "place", "event"] as const) {
    if (counts[k] > bestCount) {
      bestCount = counts[k];
      best = k;
    }
  }
  return best;
}

function buildClusterElement(
  count: number,
  dominantKind: AnyEntity["kind"],
  onClick: () => void,
): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "byz-cluster";
  btn.dataset.dominantKind = dominantKind;
  btn.style.setProperty("--marker-color", KIND_COLOR[dominantKind]);
  btn.setAttribute("aria-label", `${count} entities — expand`);
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });

  const inner = document.createElement("span");
  inner.className = "byz-cluster-count";
  inner.textContent = String(count);
  btn.appendChild(inner);

  return btn;
}

/* ----- Reset control (custom MapLibre IControl) ----- */

class ResetControl implements maplibregl.IControl {
  private _onReset: () => void;
  private _container: HTMLElement | null = null;
  constructor(onReset: () => void) {
    this._onReset = onReset;
  }
  onAdd(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "byz-reset-ctrl";
    btn.setAttribute("aria-label", "Reset map and timeline");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 12a9 9 0 1 0 3-6.7"/>' +
      '<polyline points="3 4 3 9 8 9"/>' +
      "</svg>";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._onReset();
    });
    wrap.appendChild(btn);
    this._container = wrap;
    return wrap;
  }
  onRemove(): void {
    this._container?.parentNode?.removeChild(this._container);
    this._container = null;
  }
}

function updateCluster(
  el: HTMLElement,
  count: number,
  dominantKind: AnyEntity["kind"],
) {
  const inner = el.querySelector(".byz-cluster-count");
  if (inner) inner.textContent = String(count);
  el.dataset.dominantKind = dominantKind;
  el.style.setProperty("--marker-color", KIND_COLOR[dominantKind]);
  el.setAttribute("aria-label", `${count} entities — expand`);
}

