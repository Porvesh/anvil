import Link from "next/link";
import { Logo } from "./Logo";
import styles from "./TopBar.module.css";

/** Constant app chrome (spec §6). Present on every view. */
export function TopBar() {
  return (
    <header className={styles.topbar}>
      <Link href="/" className={styles.brand}>
        <Logo />
        <b>Anvil</b>
        <span className={styles.tag}>working title</span>
      </Link>
      <div className={styles.grow} />
      <nav className={styles.nav}>
        <Link href="/">Practice</Link>
        <Link href="/">Problem bank</Link>
        <Link href="/">History</Link>
      </nav>
      <button className="btn-ghost">Sign in</button>
    </header>
  );
}
