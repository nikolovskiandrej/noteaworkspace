'use client';

import { Check, CircleAlert, FileCode, LoaderCircle, RotateCcw, Save, TriangleAlert } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceRequestError } from '@notea/workspace-client';
import { cx } from './ui/cx';
import { useWorkspaceSocket } from './workspace-socket';

type EditorHandle = {
  getValue(): string;
  setValue(value: string): void;
  destroy(): void;
};

async function createEditor(parent: HTMLElement, path: string, initial: string, onChange: () => void, readOnly: boolean): Promise<EditorHandle> {
  const [{ EditorView, basicSetup }, { EditorState, Compartment }, { keymap }, { noteaEditorTheme }] = await Promise.all([
    import('codemirror'),
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('./editor-theme'),
  ]);
  const language = await languageFor(path);
  const readOnlyCompartment = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        noteaEditorTheme,
        keymap.of([{ key: 'Mod-s', run: () => true }]), // handled at the document level
        ...(language ? [language] : []),
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange();
        }),
      ],
    }),
  });
  return {
    getValue: () => view.state.doc.toString(),
    setValue: (value) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }),
    destroy: () => view.destroy(),
  };
}

async function languageFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(ext)) {
    const { javascript } = await import('@codemirror/lang-javascript');
    return javascript({ jsx: ext.endsWith('x'), typescript: ext.startsWith('t') || ext === 'mts' || ext === 'cts' });
  }
  if (ext === 'json') return (await import('@codemirror/lang-json')).json();
  if (ext === 'md' || ext === 'markdown') return (await import('@codemirror/lang-markdown')).markdown();
  return null;
}

type EditorStatus = 'idle' | 'loading' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';

/** What the file's state means to the person editing it, next to its name. */
function StatusNote({ status, readOnly }: { status: EditorStatus; readOnly: boolean }) {
  if (readOnly && (status === 'idle' || status === 'saved')) return <span className="text-xs text-fg-subtle">Read only</span>;
  switch (status) {
    case 'loading':
      return (
        <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          Opening
        </span>
      );
    case 'dirty':
      return (
        <span className="flex items-center gap-1.5 text-xs text-warn">
          <span className="size-1.5 rounded-full bg-warn" aria-hidden />
          Unsaved changes
        </span>
      );
    case 'saving':
      return (
        <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          Saving
        </span>
      );
    case 'saved':
      return (
        <span className="flex animate-enter items-center gap-1 text-xs text-accent">
          <Check className="size-3.5" aria-hidden />
          Saved
        </span>
      );
    default:
      return null;
  }
}

export function Editor({ path, canWrite }: { path: string | null; canWrite: boolean }) {
  const { client, state } = useWorkspaceSocket();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const etagRef = useRef<string | null>(null);
  /** Bumped by every load and on teardown; only the latest load may touch the editor. */
  const loadSeqRef = useRef(0);
  const [status, setStatus] = useState<EditorStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!path || !containerRef.current || !client) return;
    // Reads can finish out of order: a slow read of the file opened before must not
    // land last and put its content under this path, where Save would write it.
    const seq = ++loadSeqRef.current;
    setStatus('loading');
    setMessage(null);
    handleRef.current?.destroy();
    handleRef.current = null;
    try {
      const file = await client.readFile(path);
      if (seq !== loadSeqRef.current || !containerRef.current) return;
      etagRef.current = file.etag;
      containerRef.current.innerHTML = '';
      const handle = await createEditor(containerRef.current, path, file.content, () => setStatus('dirty'), !canWrite);
      if (seq !== loadSeqRef.current) {
        handle.destroy();
        return;
      }
      handleRef.current = handle;
      setStatus('idle');
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'failed to load file');
    }
  }, [client, path, canWrite]);

  // Load once the socket is open, and again only when the file changes. A reconnect
  // keeps the editor as it is: reloading would replace unsaved edits with the copy on
  // disk, and the etag still catches a conflicting change when saving.
  useEffect(() => {
    if (state === 'open' && !handleRef.current) void load();
  }, [load, state]);

  useEffect(
    () => () => {
      loadSeqRef.current += 1;
      handleRef.current?.destroy();
      handleRef.current = null;
    },
    [load],
  );

  // Somebody else (a collaborator or an agent) saved this file through the file API.
  useEffect(() => {
    if (!client || !path) return;
    return client.on('fs.changed', (message) => {
      if (message.path !== path || message.etag === etagRef.current) return;
      setStatus('conflict');
      setMessage(`${message.by.name} changed this file on disk.`);
    });
  }, [client, path]);

  const save = useCallback(
    async (force = false) => {
      if (!path || !handleRef.current || !canWrite || !client) return;
      setStatus('saving');
      try {
        const reply = await client.writeFile(path, handleRef.current.getValue(), force ? undefined : (etagRef.current ?? undefined));
        etagRef.current = reply.etag;
        setStatus('saved');
        setMessage(null);
      } catch (err) {
        if (err instanceof WorkspaceRequestError && err.code === 'conflict') {
          setStatus('conflict');
          setMessage('This file changed on disk since you opened it.');
        } else {
          setStatus('error');
          setMessage(err instanceof Error ? err.message : 'save failed');
        }
      }
    },
    [client, path, canWrite],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const segments = path ? path.split('/') : [];

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="pane-header gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {path ? (
            <p className="flex min-w-0 items-center gap-1 font-mono text-[12.5px]" title={path}>
              {segments.map((segment, index) => (
                <Fragment key={index}>
                  {index > 0 ? (
                    <span className="flex-none text-fg-faint" aria-hidden>
                      /
                    </span>
                  ) : null}
                  <span className={index === segments.length - 1 ? 'truncate text-fg' : 'hidden flex-none text-fg-subtle sm:inline'}>{segment}</span>
                </Fragment>
              ))}
            </p>
          ) : (
            <span className="text-[12.5px] text-fg-subtle">No file open</span>
          )}
          {path ? <StatusNote status={status} readOnly={!canWrite} /> : null}
        </div>
        {path && canWrite ? (
          <button
            type="button"
            onClick={() => void save()}
            disabled={status === 'saving' || status === 'loading'}
            className={cx('btn btn-xs', status === 'dirty' ? 'btn-primary' : 'btn-secondary')}
            title="Save (Ctrl+S)"
          >
            <Save aria-hidden />
            Save
          </button>
        ) : null}
      </div>
      {message && (status === 'conflict' || status === 'error') ? (
        <div
          role="alert"
          className={cx(
            'flex flex-none animate-enter flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2 text-xs',
            status === 'conflict' ? 'border-warn/25 bg-warn/[0.06] text-[#ecd3a1]' : 'border-danger/25 bg-danger/[0.06] text-[#f3b1aa]',
          )}
        >
          {status === 'conflict' ? <TriangleAlert className="size-3.5 flex-none text-warn" aria-hidden /> : <CircleAlert className="size-3.5 flex-none text-danger" aria-hidden />}
          <span className="min-w-0 flex-1">{message}</span>
          {status === 'conflict' ? (
            <span className="flex flex-none gap-1.5">
              <button type="button" onClick={() => void load()} className="btn btn-secondary btn-xs">
                <RotateCcw aria-hidden />
                Reload from disk
              </button>
              <button type="button" onClick={() => void save(true)} className="btn btn-xs border-warn/40 text-warn hover:bg-warn/10">
                Overwrite
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {/* CodeMirror owns this element's children; React never renders into it. */}
        <div ref={containerRef} className="absolute inset-0 overflow-hidden text-[13px]" />
        {!path ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="max-w-xs text-center">
              <span className="mx-auto grid size-10 place-items-center rounded-full border border-line bg-panel text-fg-subtle">
                <FileCode className="size-[18px]" aria-hidden />
              </span>
              <p className="mt-3 text-[13px] font-medium text-fg">Open a file</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-fg-subtle">
                Choose one in the file tree. <span className="kbd">Ctrl S</span> saves, and a change someone else saved first is flagged before you overwrite it.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
