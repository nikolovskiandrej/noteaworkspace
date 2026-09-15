'use client';

import { useEffect, useState } from 'react';
import { Terminal } from './terminal';
import { useWorkspaceSocket } from './workspace-socket';

export function TerminalPanel({ canInput }: { canInput: boolean }) {
  const { client, state, sessions, presence } = useWorkspaceSocket();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep a valid active tab as sessions come and go.
  useEffect(() => {
    if (activeId && sessions.some((s) => s.id === activeId)) return;
    setActiveId(sessions[0]?.id ?? null);
  }, [sessions, activeId]);

  const createTerminal = async () => {
    if (!client) return;
    setError(null);
    try {
      const reply = await client.createTerminal({ cols: 120, rows: 30, attach: false });
      setActiveId(reply.session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create terminal');
    }
  };

  const killTerminal = async (sessionId: string) => {
    if (!client) return;
    try {
      await client.killTerminal(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to close terminal');
    }
  };

  const watchers = (sessionId: string) => presence.filter((p) => p.attachedSessionIds.includes(sessionId)).map((p) => p.name);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[#232830] bg-[#14171c] px-2 text-xs">
        {sessions.map((session) => (
          <button
            key={session.id}
            onClick={() => setActiveId(session.id)}
            title={`${session.command} · ${session.createdBy?.name ?? 'unknown'} · watching: ${watchers(session.id).join(', ') || 'nobody'}`}
            className={`group flex items-center gap-2 rounded px-2 py-1 ${
              session.id === activeId ? 'bg-[#232830] text-[#e6e9ee]' : 'text-[#9aa1ab] hover:bg-[#1c2027]'
            }`}
          >
            <span className="mono">{session.title}</span>
            {session.createdBy?.kind === 'agent' ? <span className="rounded bg-violet-500/20 px-1 text-[10px] text-violet-300">agent</span> : null}
            {watchers(session.id).length > 1 ? (
              <span className="rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-300">{watchers(session.id).length}</span>
            ) : null}
            {canInput ? (
              <span
                role="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void killTerminal(session.id);
                }}
                className="ml-1 hidden text-[#6f7782] hover:text-rose-300 group-hover:inline"
                title="Close terminal"
              >
                ×
              </span>
            ) : null}
          </button>
        ))}
        {canInput ? (
          <button
            onClick={() => void createTerminal()}
            disabled={state !== 'open'}
            className="ml-1 rounded border border-[#2b313b] px-2 py-1 text-[#c3c8d0] hover:bg-[#1c2027] disabled:opacity-40"
          >
            + Terminal
          </button>
        ) : null}
        <span className="ml-auto text-[#6f7782]">{state === 'open' ? 'connected' : state}</span>
      </div>
      {error ? <p className="bg-rose-500/10 px-3 py-1 text-xs text-rose-300">{error}</p> : null}
      <div className="min-h-0 flex-1 p-1">
        {activeId && client ? (
          <Terminal key={activeId} client={client} sessionId={activeId} canInput={canInput} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[#6f7782]">
            {state === 'open' ? (canInput ? 'No terminals. Open one with “+ Terminal”.' : 'No terminals are open.') : 'Connecting to the workspace…'}
          </div>
        )}
      </div>
    </div>
  );
}
