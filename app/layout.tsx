import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { GenerationWatcher } from "@/components/home/GenerationWatcher";

// Forge identity fonts (ported from v1.html). next/font self-hosts them, so there
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
    "Interview practice for the skills LeetCode ignores: debugging, code review, and system design. Free, browser-based, AI-graded.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
    >
      <body>
        {children}
        {/* Mounted here, not on the home page: a generation job deliberately
            outlives the page that started it, because the user is sent off to
            solve a bank problem the moment they paste a JD. */}
        <GenerationWatcher />
      </body>
    </html>
  );
}
