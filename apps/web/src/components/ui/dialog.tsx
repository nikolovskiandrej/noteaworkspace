'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A modal built on the native <dialog>: the browser traps focus, makes the page
 * behind it inert and closes it on Escape. Enter and exit are CSS transitions
 * (`.dialog` in globals.css), so the element can animate out after it closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      // A click on the dialog element itself is a click on the backdrop.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="p-5">
        <h2 id={titleId} className="text-[15px] font-semibold tracking-[-0.01em] text-fg">
          {title}
        </h2>
        {description ? (
          <div id={descriptionId} className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
            {description}
          </div>
        ) : null}
        <div className="mt-4">{children}</div>
      </div>
    </dialog>
  );
}
