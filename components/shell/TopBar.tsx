"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import styles from "./TopBar.module.css";

/**
 * Every entry here resolves to a real page. They used to all point at `/`, which
 * made the nav read as three links that silently did nothing.
 *
 * `exact` matters for Practice: `/` is a prefix of every route, so a
 * startsWith test would light it up on all of them.
 */
const NAV = [
  { href: "/", label: "Practice", exact: true },
  { href: "/bank", label: "Problem bank" },
  { href: "/history", label: "History" },
];

/** Constant app chrome (spec §6). Present on every view. */
export function TopBar() {
  const pathname = usePathname();

  return (
    <header className={styles.topbar}>
      <Link href="/" className={styles.brand}>
        <Logo />
        <b>Anvil</b>
      </Link>
      <div className={styles.grow} />
      <nav className={styles.nav}>
        {NAV.map(({ href, label, exact }) => {
          // A solve page is reached from the bank, so keep that entry lit while
          // the user is inside a problem rather than showing no location at all.
          const active = exact
            ? pathname === href
            : pathname.startsWith(href) || (href === "/bank" && pathname.startsWith("/solve"));
          return (
            <Link key={href} href={href} className={active ? styles.active : ""} aria-current={active ? "page" : undefined}>
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
