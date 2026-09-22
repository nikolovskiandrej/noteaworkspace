'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceRequestError } from '@notea/workspace-client';
import { useWorkspaceSocket } from './workspace-socket';

type EditorHandle = {
  getValue(): string;
  setValue(value: string): void;
  destroy(): void;
};

async function createEditor(parent: HTMLElement, path: string, initial: string, onChange: () => void, readOnly: boolean): Promise<EditorHandle> {
  const [{ EditorView, basicSetup }, { EditorState, Compartment }, { keymap }, { oneDark }] = await Promise.all([
    import('codemirror'),
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/theme-one-dark'),
  ]);
  const language = await languageFor(path);
  const readOnlyCompartment = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        oneDark,
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

export function Editor({ path, canWrite }: { path: string | null; canWrite: boolean }) {
  const { client, state } = useWorkspaceSocket();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const etagRef = useRef<string | null>(null);
  /** Bumped by every load and on teardown; only the latest load may touch the editor. */
  const loadSeqRef = useRef(0);
  const [status, setStatus] = useState<'idle' | 'loading' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-[#232830] bg-[#14171c] px-3 text-xs">
        <span className="mono truncate text-[#c3c8d0]">{path ?? 'No file selected'}</span>
        <span className="text-[#6f7782]">{status === 'idle' ? '' : status}</span>
        {message ? <span className={status === 'conflict' ? 'text-amber-300' : 'text-rose-300'}>{message}</span> : null}
        <div className="ml-auto flex items-center gap-2">
          {status === 'conflict' ? (
            <>
              <button onClick={() => void load()} className="rounded border border-[#2b313b] px-2 py-0.5 hover:bg-[#1c2027]">
                Reload
              </button>
              <button onClick={() => void save(true)} className="rounded border border-amber-500/40 px-2 py-0.5 text-amber-300 hover:bg-amber-500/10">
                Overwrite
              </button>
            </>
          ) : null}
          {path && canWrite ? (
            <button
              onClick={() => void save()}
              disabled={status === 'saving' || status === 'loading'}
              className="rounded bg-emerald-500 px-2 py-0.5 font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
            >
              Save
            </button>
          ) : null}
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden text-[13px]">
        {!path ? <p className="p-4 text-sm text-[#6f7782]">Select a file in the tree to open it.</p> : null}
      </div>
    </div>
  );
}
