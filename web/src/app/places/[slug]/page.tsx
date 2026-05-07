import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AppShell from "@/components/AppShell";
import { entities } from "@/lib/data";
import { buildEntityMetadata, lookupForKind } from "@/lib/entity_meta";

export function generateStaticParams() {
  return entities.places.map((p) => ({ slug: p.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = lookupForKind("place", slug);
  if (!entity) return {};
  return buildEntityMetadata(entity);
}

export default async function PlacePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = lookupForKind("place", slug);
  if (!entity) notFound();
  return <AppShell initialEntityId={entity.id} />;
}
