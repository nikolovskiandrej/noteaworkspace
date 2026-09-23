import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from './cx';

const TONES = {
  danger: { icon: CircleAlert, className: 'border-danger/30 bg-danger/[0.07] text-[#f3b1aa]', iconClass: 'text-danger' },
  warn: { icon: TriangleAlert, className: 'border-warn/30 bg-warn/[0.07] text-[#ecd3a1]', iconClass: 'text-warn' },
  success: { icon: CircleCheck, className: 'border-accent/30 bg-accent/[0.07] text-[#bfe3cf]', iconClass: 'text-accent' },
  info: { icon: Info, className: 'border-info/30 bg-info/[0.07] text-[#c3d6f1]', iconClass: 'text-info' },
} as const;

/**
 * An inline message: an error from a server action, a check result, a configuration
 * warning. `dismissHref` renders a close link (usually the same page without its
 * query string), so dismissing needs no client code.
 */
export function Notice({
  tone,
  children,
  dismissHref,
  className,
}: {
  tone: keyof typeof TONES;
  children: ReactNode;
  dismissHref?: string;
  className?: string;
}) {
  const style = TONES[tone];
  const Icon = style.icon;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px] leading-relaxed animate-enter', style.className, className)}
    >
      <Icon className={cx('mt-[3px] size-[15px] flex-none', style.iconClass)} aria-hidden />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {dismissHref ? (
        <Link href={dismissHref} className="-mr-1 mt-px flex-none rounded p-0.5 text-current opacity-60 transition-opacity hover:opacity-100" aria-label="Dismiss">
          <X className="size-3.5" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}
