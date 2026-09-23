'use client';

import { Ellipsis, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { deleteWorkspaceAction } from '@/lib/actions';
import { Dialog } from './ui/dialog';
import { Menu } from './ui/menu';
import { SubmitButton } from './ui/submit-button';

/**
 * The owner's workspace menu. Deleting asks for the slug to be typed, as before; the
 * server checks it again (`deleteWorkspaceAction`), the button only saves a round trip.
 */
export function WorkspaceActions({ workspaceId, slug, name, returnTo }: { workspaceId: string; slug: string; name: string; returnTo: string }) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = () => {
    setConfirming(false);
    setTyped('');
    // The menu item that opened the dialog is gone; hand focus back to the menu button.
    menuRef.current?.querySelector('button')?.focus();
  };

  return (
    <>
      <div ref={menuRef} className="contents">
        <Menu label="Workspace actions" triggerClassName="btn btn-ghost btn-icon btn-sm" trigger={<Ellipsis aria-hidden />}>
          {(closeMenu) => (
            <button
              type="button"
              className="menu-item menu-item-danger"
              onClick={() => {
                closeMenu();
                setConfirming(true);
              }}
            >
              <Trash2 aria-hidden />
              Delete workspace…
            </button>
          )}
        </Menu>
      </div>
      <Dialog
        open={confirming}
        onClose={close}
        title={`Delete ${name}?`}
        description={
          <>
            This removes the container and its volume, with every file, terminal and task branch in it. It cannot be undone. Type{' '}
            <code className="kbd">{slug}</code> to confirm.
          </>
        }
      >
        <form action={deleteWorkspaceAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="expectedSlug" value={slug} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <label htmlFor={inputId} className="field-label">
            Workspace slug
          </label>
          <input
            id={inputId}
            name="confirmSlug"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={slug}
            autoComplete="off"
            spellCheck={false}
            className="input font-mono"
          />
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={close}>
              Cancel
            </button>
            <SubmitButton className="btn-danger-solid" disabled={typed.trim() !== slug} icon={<Trash2 aria-hidden />} pendingLabel="Deleting…">
              Delete workspace
            </SubmitButton>
          </div>
        </form>
      </Dialog>
    </>
  );
}
