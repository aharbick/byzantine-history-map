import type { Metadata } from "next";
import { SITE_URL } from "@/lib/entity_meta";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Twelve Byzantine Rulers — Interactive History",
  description:
    "An interactive map and timeline based on Lars Brownworth's '12 Byzantine Rulers' podcast.",
  openGraph: {
    title: "Twelve Byzantine Rulers — Interactive History",
    description:
      "An interactive map and timeline based on Lars Brownworth's '12 Byzantine Rulers' podcast.",
    url: SITE_URL,
    siteName: "Twelve Byzantine Rulers",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-byz-ink text-byz-parchment">{children}</body>
    </html>
  );
}
