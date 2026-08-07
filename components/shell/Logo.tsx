/**
 * Anvil mark: an orange
 * spark/hammer over steel blocks). Placeholder identity; the name may change.
 */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M4 12h15l4-3 5 2-3 4H10l-2 3H4z" fill="var(--spark)" />
      <rect x="11" y="21" width="8" height="3" rx="1" fill="var(--steel)" />
      <rect x="9" y="24" width="12" height="3" rx="1" fill="var(--steel-dim)" />
    </svg>
  );
}
