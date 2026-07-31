/**
 * The app's icon set — small stroke SVGs on `currentColor`.
 *
 * These replace emoji glyphs (🔒 🎙 🔊 ⤨ 👍 …), which rendered in each
 * platform's own color-emoji font: multicolored, misaligned against text, and
 * different on every OS — three ways to break an otherwise consistent dark UI.
 * Stroke icons inherit color from the element they sit in, so a button's hover
 * and active states restyle its icon for free.
 *
 * All icons share one 24×24 grid and are sized by the `size` prop; strokes stay
 * at 2 for weight consistency with the existing inline icons (send, play).
 */
import type { SVGProps } from "react";

function base(size: number, props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

type IconProps = { size?: number } & SVGProps<SVGSVGElement>;

/** User-provided model credential. */
export function IconKey({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M16 7l3 3M14 9l3 3" />
    </svg>
  );
}

/** Read-only file marker (file tabs). */
export function IconLock({ size = 12, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** Disclosure and dropdown indicator. */
export function IconChevronDown({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Dictate a question (speech-to-text). */
export function IconMic({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

/** Interviewer voice on (text-to-speech). */
export function IconSpeaker({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke="none" />
      <path d="M15 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
    </svg>
  );
}

/** Interviewer voice muted. */
export function IconSpeakerOff({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke="none" />
      <path d="m16 9 5 6M21 9l-5 6" />
    </svg>
  );
}

/** Random problem (shuffle). */
export function IconShuffle({ size = 13, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M3 7h3.5c1.6 0 3 .8 3.9 2.1l3.2 5.8A4.7 4.7 0 0 0 17.5 17H21M3 17h3.5c1 0 2-.3 2.8-.9M21 7h-3.5c-1 0-2 .3-2.8.9" />
      <path d="m18 4 3 3-3 3M18 14l3 3-3 3" />
    </svg>
  );
}

/** Upvote — curates the bank. */
export function IconThumbsUp({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M7 11v9M7 11l4-7c.9 0 2.5.6 2.5 2.5 0 .9-.4 2.6-.6 3.5H18a2 2 0 0 1 2 2.3l-.9 5.5A2 2 0 0 1 17.1 20H7" />
      <path d="M7 11H4v9h3" />
    </svg>
  );
}

/** Downvote — enough of these retires the problem. */
export function IconThumbsDown({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M17 13V4M17 13l-4 7c-.9 0-2.5-.6-2.5-2.5 0-.9.4-2.6.6-3.5H6a2 2 0 0 1-2-2.3l.9-5.5A2 2 0 0 1 6.9 4H17" />
      <path d="M17 13h3V4h-3" />
    </svg>
  );
}

/** AI-authored marker (the PR flag, generation toast). */
export function IconSparkle({ size = 12, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" fill="currentColor" stroke="none" />
      <path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Retired-from-the-bank flag. */
export function IconFlag({ size = 13, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M5 21V4c4-2 6 2 10 0v9c-4 2-6-2-10 0" />
    </svg>
  );
}
