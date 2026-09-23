'use client';

import { AnimatePresence, m } from 'motion/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from './cx';

/**
 * A button that opens a small panel of actions (the user menu, a workspace's
 * actions). Disclosure semantics — Tab moves through the items, Escape or a click
 * elsewhere closes it and returns focus to the button — rather than an ARIA menu,
 * whose arrow-key contract the items (links and forms) would not honour.
 */
export function Menu({
  label,
  trigger,
  triggerClassName,
  align = 'end',
  children,
}: {
  /** Accessible name of the trigger button. */
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  align?: 'start' | 'end';
  /** Items; a function receives `close` for items that open something else. */
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    // Keyboard users land on the first item, as they would in a native menu.
    panelRef.current?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cx(triggerClassName, open && 'bg-hover text-fg')}
      >
        {trigger}
      </button>
      <AnimatePresence>
        {open ? (
          <m.div
            ref={panelRef}
            id={panelId}
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] } }}
            exit={{ opacity: 0, scale: 0.98, y: -2, transition: { duration: 0.12, ease: [0.7, 0, 0.84, 0] } }}
            style={{ transformOrigin: align === 'end' ? 'top right' : 'top left' }}
            className={cx('menu-panel absolute top-full z-50 mt-1.5', align === 'end' ? 'right-0' : 'left-0')}
            // A followed link leaves the page; close first so the panel does not linger.
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('a')) close();
            }}
          >
            {typeof children === 'function' ? children(close) : children}
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
