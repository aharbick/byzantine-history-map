import type { MetadataRoute } from "next";
import { entities } from "@/lib/data";
import { entityRoute, SITE_URL } from "@/lib/entity_meta";

/** Single sitemap covering the homepage + every entity page. The data is
 * static (committed `entities.json`) so generation is essentially free; we
 * surface every person/place/event for indexability rather than relying on
 * crawlers to discover deep links from the home page's client-rendered map. */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const homepage = {
    url: SITE_URL,
    lastModified,
    changeFrequency: "monthly" as const,
    priority: 1,
  };
  const entityUrls = [
    ...entities.people,
    ...entities.places,
    ...entities.events,
  ].map((e) => ({
    url: `${SITE_URL}${entityRoute(e)}`,
    lastModified,
    changeFrequency: "monthly" as const,
    // The 12 ruler-protagonists are the headline entities — boost them so
    // they crawl ahead of the supporting cast.
    priority:
      e.kind === "person" && e.is_twelve_ruler ? 0.9 : 0.6,
  }));
  return [homepage, ...entityUrls];
}
