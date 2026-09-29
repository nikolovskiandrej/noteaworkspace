import { cx } from './ui/cx';

/**
 * The Notea logo and name: the ribbon mark on its cream tile, the name in the logo's
 * bold, the product in the quiet tone. `large` is the sign-in page's size.
 */
export function Wordmark({ compact = false, large = false }: { compact?: boolean; large?: boolean }) {
  return (
    <span className={cx('inline-flex items-center', large ? 'gap-3' : 'gap-2.5')}>
      <span className={cx('logo-tile', large ? '[--logo-size:3rem]' : '[--logo-size:1.75rem]')}>
        <img src="/brand/notea-mark.png" alt="" width={192} height={141} draggable={false} />
      </span>
      <span className={cx('inline-flex items-baseline gap-1.5 leading-none tracking-[-0.02em]', large ? 'text-[22px]' : 'text-[15px]')}>
        <span className="font-bold text-fg">Notea</span>
        <span className={cx('font-normal text-fg-muted', compact && 'hidden sm:inline')}>Workspace</span>
      </span>
    </span>
  );
}
