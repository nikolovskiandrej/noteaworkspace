/** The Notea wordmark: the name in the brand's green, the product in the quiet tone. */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 text-[14px] leading-none tracking-[-0.01em]">
      <span className="font-semibold text-accent">Notea</span>
      <span className={compact ? 'hidden font-normal text-fg-muted sm:inline' : 'font-normal text-fg-muted'}>Workspace</span>
    </span>
  );
}
