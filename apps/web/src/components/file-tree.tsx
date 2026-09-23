'use client';

import { ChevronRight, CircleAlert, File, FileCode, FileJson, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FsEntry } from '@notea/protocol';
import { cx } from './ui/cx';
import { useWorkspaceSocket } from './workspace-socket';

interface DirState {
  entries: FsEntry[] | null;
  error: string | null;
}

const CODE_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'go', 'rs', 'rb', 'java', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'css', 'scss', 'html', 'sql', 'yml', 'yaml', 'toml']);
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'rst', 'log']);

function FileIcon({ name }: { name: string }) {
  const ext = name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : '';
  const Icon = ext === 'json' ? FileJson : CODE_EXTENSIONS.has(ext) ? FileCode : TEXT_EXTENSIONS.has(ext) ? FileText : File;
  return <Icon className="size-3.5 flex-none text-fg-subtle" aria-hidden />;
}

const INDENT = 12;
const BASE = 8;

export function FileTree({ selectedPath, onSelect }: { selectedPath: string | null; onSelect: (path: string) => void }) {
  const { client, state } = useWorkspaceSocket();
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (path: string) => {
      if (!client) return;
      try {
        const reply = await client.listFiles(path);
        setDirs((prev) => ({ ...prev, [path]: { entries: reply.entries, error: null } }));
      } catch (err) {
        setDirs((prev) => ({ ...prev, [path]: { entries: null, error: err instanceof Error ? err.message : 'failed' } }));
      }
    },
    [client],
  );

  useEffect(() => {
    if (state === 'open') void load('');
  }, [state, load]);

  const toggle = (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (opening && !dirs[path]) void load(path);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load('');
    } finally {
      setRefreshing(false);
    }
  };

  const renderDir = (path: string, depth: number) => {
    const dir = dirs[path];
    const indent = { paddingLeft: BASE + depth * INDENT };
    if (!dir) {
      return (
        <div className="space-y-2 py-1.5" style={indent} aria-label="Loading">
          <div className="skeleton h-2.5 w-24" />
          <div className="skeleton h-2.5 w-16" />
          <div className="skeleton h-2.5 w-20" />
        </div>
      );
    }
    if (dir.error) {
      return (
        <p className="flex items-center gap-1.5 py-1 pr-2 text-xs text-danger" style={indent}>
          <CircleAlert className="size-3.5 flex-none" aria-hidden />
          <span className="truncate">{dir.error}</span>
        </p>
      );
    }
    if (dir.entries?.length === 0) {
      return (
        <p className="py-1 text-xs italic text-fg-faint" style={{ paddingLeft: BASE + depth * INDENT + 18 }}>
          Empty
        </p>
      );
    }
    return dir.entries?.map((entry) => {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      const hidden = entry.name.startsWith('.');
      if (entry.type === 'dir') {
        const open = expanded.has(entryPath);
        const FolderIcon = open ? FolderOpen : Folder;
        return (
          <div key={entryPath}>
            <button
              type="button"
              onClick={() => toggle(entryPath)}
              aria-expanded={open}
              className="flex h-[26px] w-full items-center gap-1.5 pr-2 text-left text-[13px] transition-colors duration-100 hover:bg-hover focus-visible:rounded-none focus-visible:-outline-offset-2"
              style={indent}
            >
              <ChevronRight
                className={cx('size-3.5 flex-none text-fg-faint transition-transform duration-150 ease-out', open && 'rotate-90')}
                aria-hidden
              />
              <FolderIcon className={cx('size-3.5 flex-none', hidden ? 'text-fg-faint' : 'text-fg-subtle')} aria-hidden />
              <span className={cx('truncate', hidden ? 'text-fg-subtle' : 'text-fg-muted')}>{entry.name}</span>
            </button>
            {open ? renderDir(entryPath, depth + 1) : null}
          </div>
        );
      }
      const selected = selectedPath === entryPath;
      return (
        <button
          key={entryPath}
          type="button"
          onClick={() => onSelect(entryPath)}
          aria-current={selected ? 'true' : undefined}
          className={cx(
            'relative flex h-[26px] w-full items-center gap-1.5 pr-2 text-left text-[13px] transition-colors duration-100 focus-visible:rounded-none focus-visible:-outline-offset-2',
            selected
              ? 'bg-selected text-fg before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-accent'
              : cx('hover:bg-hover', hidden ? 'text-fg-subtle' : 'text-fg-muted'),
          )}
          style={{ paddingLeft: BASE + depth * INDENT + 20 }}
          title={entry.type === 'symlink' ? `${entryPath} (symlink)` : `${entryPath}, ${entry.size.toLocaleString('en-US')} bytes`}
        >
          <FileIcon name={entry.name} />
          <span className="truncate">{entry.name}</span>
        </button>
      );
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="pane-header">
        <h2 className="pane-title">Files</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={state !== 'open'}
          className="btn btn-ghost btn-icon btn-xs ml-auto"
          aria-label="Refresh files"
          title="Refresh"
        >
          <RefreshCw className={refreshing ? 'animate-spin' : undefined} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {state === 'open' || dirs[''] ? (
          renderDir('', 0)
        ) : (
          <p className="px-3 py-1 text-xs text-fg-subtle">{state === 'closed' ? 'Disconnected.' : 'Connecting…'}</p>
        )}
      </div>
    </div>
  );
}
