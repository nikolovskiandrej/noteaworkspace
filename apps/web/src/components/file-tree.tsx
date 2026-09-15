'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FsEntry } from '@notea/protocol';
import { useWorkspaceSocket } from './workspace-socket';

interface DirState {
  entries: FsEntry[] | null;
  error: string | null;
}

export function FileTree({ selectedPath, onSelect }: { selectedPath: string | null; onSelect: (path: string) => void }) {
  const { client, state } = useWorkspaceSocket();
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));

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
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!dirs[path]) void load(path);
      }
      return next;
    });
  };

  const renderDir = (path: string, depth: number) => {
    const dir = dirs[path];
    if (!dir) return <div className="px-2 py-0.5 text-[#6f7782]" style={{ paddingLeft: 8 + depth * 12 }}>loading…</div>;
    if (dir.error) return <div className="px-2 py-0.5 text-rose-300" style={{ paddingLeft: 8 + depth * 12 }}>{dir.error}</div>;
    return dir.entries?.map((entry) => {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.type === 'dir') {
        const open = expanded.has(entryPath);
        return (
          <div key={entryPath}>
            <button
              onClick={() => toggle(entryPath)}
              className="flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-[#1c2027]"
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              <span className="w-3 text-[#6f7782]">{open ? '▾' : '▸'}</span>
              <span className="text-[#c3c8d0]">{entry.name}</span>
            </button>
            {open ? renderDir(entryPath, depth + 1) : null}
          </div>
        );
      }
      return (
        <button
          key={entryPath}
          onClick={() => onSelect(entryPath)}
          className={`flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-[#1c2027] ${
            selectedPath === entryPath ? 'bg-[#232830] text-emerald-300' : 'text-[#aab1bb]'
          }`}
          style={{ paddingLeft: 8 + depth * 12 }}
          title={entry.type === 'symlink' ? 'symlink' : `${entry.size} bytes`}
        >
          <span className="w-3" />
          <span className="truncate">{entry.name}</span>
        </button>
      );
    });
  };

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#232830] px-3 text-[11px] font-semibold uppercase tracking-wide text-[#9aa1ab]">
        Files
        <button onClick={() => void load('')} className="text-[#6f7782] hover:text-[#c3c8d0]" title="Refresh">
          ↻
        </button>
      </div>
      <div className="mono min-h-0 flex-1 overflow-auto py-1">{state === 'open' ? renderDir('', 0) : <p className="px-3 text-[#6f7782]">{state}…</p>}</div>
    </div>
  );
}
