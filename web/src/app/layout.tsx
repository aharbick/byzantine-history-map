import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Twelve Byzantine Rulers — Interactive History",
  description:
    "An interactive map and timeline based on Lars Brownworth's '12 Byzantine Rulers' podcast.",
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
