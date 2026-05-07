import { lookupForKind } from "@/lib/entity_meta";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  renderEntityOg,
} from "@/lib/og_image";

export const alt = "Twelve Byzantine Rulers — entity card";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = lookupForKind("place", slug);
  if (!entity) {
    return new Response("Not found", { status: 404 });
  }
  return renderEntityOg(entity);
}
