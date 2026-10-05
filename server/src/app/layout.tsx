import type {Metadata} from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lumina Server",
  description: "Self-hosted companion server for Lumina Code",
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
