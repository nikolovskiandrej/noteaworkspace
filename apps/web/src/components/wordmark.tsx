import { cx } from './ui/cx';

/**
 * The Notea logo and name: the ribbon N on its own, no tile behind it, then the name in
 * the logo's bold and the product in the quiet tone. `large` is the sign-in page's size.
 */
export function Wordmark({ compact = false, large = false }: { compact?: boolean; large?: boolean }) {
  return (
    <span className={cx('inline-flex items-center', large ? 'gap-3' : 'gap-2.5')}>
      <img
        src="/brand/notea-mark.png"
        alt=""
        width={256}
        height={188}
        draggable={false}
        className={cx('logo-mark', large ? '[--logo-w:3.5rem]' : '[--logo-w:1.875rem]')}
      />
      <span className={cx('inline-flex items-baseline gap-1.5 leading-none tracking-[-0.02em]', large ? 'text-[22px]' : 'text-[15px]')}>
        <span className="font-bold text-fg">Notea</span>
        <span className={cx('font-normal text-fg-muted', compact && 'hidden sm:inline')}>Workspace</span>
      </span>
    </span>
  );
}
