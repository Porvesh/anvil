import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// Forge identity fonts. next/font self-hosts them, so there
// are no render-blocking requests to Google's CDN and no layout shift.
const displayFont = Space_Grotesk({
  variable: "--font-disp",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});
const bodyFont = IBM_Plex_Sans({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});
const monoFont = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Anvil — drill the hard part",
  description:
    "BYOK interview practice for the skills LeetCode ignores: debugging, code review, and system design.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
