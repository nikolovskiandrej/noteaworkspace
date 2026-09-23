'use client';

import { Plus } from 'lucide-react';
import { AnimatePresence, m } from 'motion/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createWorkspaceAction } from '@/lib/actions';
import { SubmitButton } from './ui/submit-button';

/**
 * The workspace list's header with its "New workspace" action. The form opens in
 * place, under the heading; it starts open when there is nothing to list yet.
 */
export function WorkspacesHeader({ defaultOpen, children }: { defaultOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const opened = useRef(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const formId = useId();

  useEffect(() => {
    // Focus only when the person opened it, never on page load.
    if (open && opened.current) nameRef.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        {children}
        <button
          type="button"
          className={open ? 'btn btn-secondary' : 'btn btn-primary'}
          aria-expanded={open}
          aria-controls={formId}
          onClick={() => {
            opened.current = true;
            setOpen((value) => !value);
          }}
        >
          <Plus aria-hidden className={open ? 'rotate-45 transition-transform duration-200' : 'transition-transform duration-200'} />
          {open ? 'Close' : 'New workspace'}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <m.div
            key="create"
            id={formId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <form action={createWorkspaceAction} className="mt-6 rounded-lg border border-line bg-panel p-4 sm:p-5">
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)_auto] sm:items-end">
                <div>
                  <label htmlFor={`${formId}-name`} className="field-label">
                    Name
                  </label>
                  <input ref={nameRef} id={`${formId}-name`} name="name" required maxLength={80} placeholder="My project" autoComplete="off" className="input" />
                </div>
                <div>
                  <label htmlFor={`${formId}-slug`} className="field-label">
                    Slug <span className="font-normal text-fg-subtle">(optional)</span>
                  </label>
                  <input
                    id={`${formId}-slug`}
                    name="slug"
                    pattern="[a-z0-9][a-z0-9-]{1,40}"
                    placeholder="my-project"
                    autoComplete="off"
                    spellCheck={false}
                    className="input font-mono"
                  />
                </div>
                <SubmitButton className="btn-primary" icon={<Plus aria-hidden />} pendingLabel="Creating…">
                  Create workspace
                </SubmitButton>
              </div>
              <p className="field-hint">Creating starts the container and waits for its agent; it usually takes a few seconds.</p>
            </form>
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
