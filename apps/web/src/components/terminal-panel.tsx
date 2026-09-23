'use client';

import { Bot, CircleAlert, Plus, SquareTerminal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Terminal } from './terminal';
import { cx } from './ui/cx';
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
  const open = state === 'open';

  return (
    <div className="flex h-full flex-col bg-canvas" data-terminal-panel>
      <div className="pane-header gap-2 pl-2 pr-2">
        <div role="group" aria-label="Terminals" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {sessions.map((session) => {
            const active = session.id === activeId;
            const watching = watchers(session.id);
            const agent = session.createdBy?.kind === 'agent';
            return (
              <div
                key={session.id}
                className={cx(
                  'group flex h-7 flex-none items-center rounded-md border text-xs transition-colors duration-150',
                  active ? 'border-line-strong bg-raised text-fg' : 'border-transparent text-fg-subtle hover:bg-hover hover:text-fg-muted',
                )}
              >
                <button
                  type="button"
                  onClick={() => setActiveId(session.id)}
                  aria-current={active ? 'true' : undefined}
                  title={`${session.command}, opened by ${session.createdBy?.name ?? 'unknown'}. Watching: ${watching.join(', ') || 'nobody'}`}
                  className="flex h-full items-center gap-1.5 pl-2 pr-1.5"
                >
                  {agent ? <Bot className="size-3.5 flex-none text-agent" aria-label="Agent session" /> : <SquareTerminal className="size-3.5 flex-none" aria-hidden />}
                  <span className="max-w-40 truncate font-mono text-[11.5px]">{session.title}</span>
                  {watching.length > 1 ? (
                    <span className="segment-count" aria-label={`${watching.length} people watching`}>
                      {watching.length}
                    </span>
                  ) : null}
                </button>
                {canInput ? (
                  <button
                    type="button"
                    onClick={() => void killTerminal(session.id)}
                    aria-label={`Close ${session.title}`}
                    title="Close terminal"
                    className={cx(
                      'mr-1 grid size-5 flex-none place-items-center rounded text-fg-subtle transition-opacity duration-150 hover:bg-hover hover:text-danger focus-visible:opacity-100',
                      active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                    )}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                ) : null}
              </div>
            );
          })}
          {canInput && sessions.length > 0 ? (
            <button
              type="button"
              onClick={() => void createTerminal()}
              disabled={!open}
              className="btn btn-ghost btn-icon btn-xs flex-none"
              aria-label="New terminal"
              title="New terminal"
            >
              <Plus aria-hidden />
            </button>
          ) : null}
        </div>
        <span className="flex flex-none items-center gap-1.5 text-xs text-fg-subtle" role="status">
          <span className={cx('status-dot', open ? 'tone-live' : 'tone-warn')} data-pulse={open ? undefined : ''} aria-hidden />
          <span className="hidden sm:inline">{open ? 'Connected' : state === 'closed' ? 'Disconnected' : 'Connecting'}</span>
        </span>
      </div>
      {error ? (
        <div role="alert" className="flex flex-none animate-enter items-center gap-2 border-b border-danger/25 bg-danger/[0.06] px-3 py-1.5 text-xs text-[#f3b1aa]">
          <CircleAlert className="size-3.5 flex-none text-danger" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button type="button" onClick={() => setError(null)} className="grid size-5 place-items-center rounded opacity-70 hover:opacity-100" aria-label="Dismiss">
            <X className="size-3" aria-hidden />
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 pb-1 pl-3 pr-1 pt-2">
        {activeId && client ? (
          <Terminal key={activeId} client={client} sessionId={activeId} canInput={canInput} />
        ) : (
          <div className="grid h-full place-items-center p-4">
            <div className="max-w-xs text-center">
              <span className="mx-auto grid size-10 place-items-center rounded-full border border-line bg-panel text-fg-subtle">
                <SquareTerminal className="size-[18px]" aria-hidden />
              </span>
              <p className="mt-3 text-[13px] font-medium text-fg">{open ? 'No terminals open' : 'Connecting to the workspace…'}</p>
              {open ? (
                <p className="mt-1 text-[12.5px] leading-relaxed text-fg-subtle">
                  {canInput ? 'Terminals are shared: everyone in the workspace can watch the same session.' : 'Terminals someone opens will appear here.'}
                </p>
              ) : null}
              {canInput && open ? (
                <button type="button" onClick={() => void createTerminal()} className="btn btn-secondary btn-sm mt-4">
                  <Plus aria-hidden />
                  New terminal
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
