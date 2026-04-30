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
const INITIAL_CENTER: [number, number] = [28.949, 41.013]; // Constantinople
const INITIAL_ZOOM = 4;

const KIND_COLOR: Record<AnyEntity["kind"], string> = {
  person: "#e7c873",
  place: "#3a6b8c",
  event: "#b44646",
};

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
  const { currentYear, selectedEntity, selectEntity, setCurrentYear, filters } = useApp();
  // Mirror selectedEntity into a ref so the marker click handlers (created
  // once at marker construction) can read the *current* value without stale
  // closures — needed for click-to-toggle behavior.
  const selectedRef = useRef<AnyEntity | null>(null);
  selectedRef.current = selectedEntity;

  // Init map once per mount
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
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
        map.easeTo({
          center: INITIAL_CENTER,
          zoom: INITIAL_ZOOM,
          bearing: 0,
          pitch: 0,
          duration: 700,
        });
        prePanRef.current = null;
      }),
      "top-right",
    );
    map.scrollZoom.disable();
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

    // Group active entities by their coord group
    type Bucket = { coords: { lat: number; lng: number }; entities: AnyEntity[] };
    const activeByGroup = new Map<string, Bucket>();

    for (const e of allEntities) {
      if (!filters[e.kind]) continue;
      if (!isActiveAt(e, currentYear)) continue;
      const m = memberOf(e);
      if (!m) continue;
      const bucket = activeByGroup.get(m.groupKey);
      if (bucket) bucket.entities.push(e);
      else activeByGroup.set(m.groupKey, { coords: m.coords, entities: [e] });
    }

    const wantedMarkerKeys = new Set<string>();
    const wantedClusterKeys = new Set<string>();

    for (const [groupKey, bucket] of activeByGroup) {
      // Cluster based on the *active* count (not all-time), so we don't show
      // "+1" or "+2" clusters at otherwise-busy locations.
      const clustered = bucket.entities.length >= CLUSTER_THRESHOLD;
      const isExpanded = expandedGroup === groupKey;

      if (clustered && !isExpanded) {
        // Render a single cluster marker for the whole group, tinted by the
        // most-represented kind among its members.
        wantedClusterKeys.add(groupKey);
        const dominantKind = pickDominantKind(bucket.entities);
        if (!clustersRef.current.has(groupKey)) {
          const el = buildClusterElement(
            bucket.entities.length,
            dominantKind,
            () => setExpandedGroup(groupKey),
          );
          el.dataset.groupKey = groupKey;
          const m = new maplibregl.Marker({ element: el, anchor: "center" })
            .setLngLat([bucket.coords.lng, bucket.coords.lat])
            .addTo(map);
          clustersRef.current.set(groupKey, m);
        } else {
          // Update count + dominant-kind color if either changed.
          const existing = clustersRef.current.get(groupKey)!;
          updateCluster(existing.getElement(), bucket.entities.length, dominantKind);
        }
        continue;
      }

      // Render individual markers — use STABLE offsets (precomputed). Use
      // wider "spider" radius if this group is expanded; normal fan otherwise.
      for (const e of bucket.entities) {
        const member = memberOf(e)!;
        const offset = isExpanded ? member.spiderOffset : member.fanOffset;
        const key = `${e.kind}:${e.id}`;
        wantedMarkerKeys.add(key);

        const existing = markersRef.current.get(key);
        if (existing) {
          existing.setOffset(offset);
        } else {
          const el = buildMarkerElement(e, () => {
            // Click-to-toggle: clicking the same dot a second time closes it.
            if (selectedRef.current?.id === e.id) selectEntity(null);
            else selectEntity(e);
          });
          el.dataset.entityKey = key;
          const m = new maplibregl.Marker({ element: el, anchor: "center", offset })
            .setLngLat([bucket.coords.lng, bucket.coords.lat])
            .addTo(map);
          markersRef.current.set(key, m);
        }
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
  }, [currentYear, selectEntity, filters, mapReady, expandedGroup]);

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

  // Selection effect: expand clustered groups when needed; pan ONLY if the
  // selected dot is genuinely offscreen; restore the prior map view on close.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

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

    const c = entityCoords(selectedEntity);
    if (!c) return;

    // Pan only if the dot is actually OFFSCREEN. Don't pan just because the
    // card overlaps it — on mobile the card is full-width so the dot would
    // always be covered, but panning doesn't help (you can't see anything
    // behind the card anyway).
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

  return <div ref={containerRef} className="absolute inset-0" />;
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

  // Pick the best image we have for this entity.
  const imageUrl =
    e.kind === "person"
      ? (e as { portrait_url?: string | null }).portrait_url
      : (e as { image_url?: string | null }).image_url;

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

