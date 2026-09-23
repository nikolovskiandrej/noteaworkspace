import { Bot } from 'lucide-react';
import { cx } from './cx';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0]?.slice(0, 1) ?? '?');
  return letters.toUpperCase();
}

/**
 * People are circles with their initials; agents are rounded squares with a robot
 * glyph in the agent colour, so the two are told apart by shape as well as colour.
 */
export function Avatar({ name, kind = 'user', size = 'md', className }: { name: string; kind?: 'user' | 'agent'; size?: 'sm' | 'md'; className?: string }) {
  const dimension = size === 'sm' ? 'size-5 text-[9.5px]' : 'size-7 text-[11px]';
  if (kind === 'agent') {
    return (
      <span
        className={cx('grid flex-none place-items-center rounded-md bg-agent/12 text-agent ring-1 ring-agent/30', dimension, className)}
        aria-hidden
      >
        <Bot className={size === 'sm' ? 'size-3' : 'size-3.5'} />
      </span>
    );
  }
  return (
    <span className={cx('grid flex-none place-items-center rounded-full bg-selected font-semibold text-fg-muted ring-1 ring-line-strong', dimension, className)} aria-hidden>
      {initials(name)}
    </span>
  );
}
