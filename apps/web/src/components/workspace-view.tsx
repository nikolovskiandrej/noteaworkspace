'use client';

import { useState } from 'react';
import type { WorkspaceRole } from '@notea/protocol';
import { addMemberAction, removeMemberAction } from '@/lib/actions';
import { Editor } from './editor';
import { FileTree } from './file-tree';
import { TerminalPanel } from './terminal-panel';
import { useWorkspaceSocket, WorkspaceSocketProvider } from './workspace-socket';

export interface WorkspaceViewProps {
  workspaceId: string;
  slug: string;
  role: WorkspaceRole;
  running: boolean;
  members: Array<{ userId: string; email: string; name: string; role: WorkspaceRole }>;
  events: Array<{ id: number; type: string; actorKind: string; createdAt: string; payload: Record<string, unknown> }>;
  currentUserId: string;
  returnTo: string;
}

/** Deterministic (UTC, fixed locale) so server and client render identical markup. */
function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso)) + ' UTC';
}

export function WorkspaceView(props: WorkspaceViewProps) {
  if (!props.running) {
    return (
      <main className="flex flex-1 items-center justify-center p-6 text-sm text-[#9aa1ab]">
        This workspace is not running. {props.role !== 'viewer' ? 'Start it from the top bar.' : 'Ask an editor or the owner to start it.'}
      </main>
    );
  }
  return (
    <WorkspaceSocketProvider workspaceId={props.workspaceId}>
      <WorkspaceLayout {...props} />
    </WorkspaceSocketProvider>
  );
}

function WorkspaceLayout({ workspaceId, role, members, events, currentUserId, returnTo }: WorkspaceViewProps) {
  const { state, presence, lastClose } = useWorkspaceSocket();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const canWrite = role !== 'viewer';

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-60 shrink-0 border-r border-[#232830] bg-[#111418]">
        <FileTree selectedPath={selectedPath} onSelect={setSelectedPath} />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {state !== 'open' ? (
          <p className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
            {state === 'closed' ? `Disconnected${lastClose?.reason ? `: ${lastClose.reason}` : ''}. Reload the page.` : `Connecting to the workspace… (${state})`}
          </p>
        ) : null}
        <div className="min-h-0 flex-[3] border-b border-[#232830]">
          <Editor path={selectedPath} canWrite={canWrite} />
        </div>
        <div className="min-h-0 flex-[2]">
          <TerminalPanel canInput={canWrite} />
        </div>
      </section>
      <aside className="flex w-64 shrink-0 flex-col border-l border-[#232830] bg-[#111418] text-xs">
        <div className="border-b border-[#232830] p-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#9aa1ab]">Here now</h3>
          <ul className="space-y-1">
            {presence.length === 0 ? <li className="text-[#6f7782]">Nobody connected</li> : null}
            {presence.map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${p.kind === 'agent' ? 'bg-violet-400' : 'bg-emerald-400'}`} />
                <span className="text-[#e6e9ee]">{p.name}</span>
                <span className="text-[#6f7782]">{p.role}</span>
                {p.attachedSessionIds.length > 0 ? <span className="text-[#6f7782]">· {p.attachedSessionIds.length} term</span> : null}
              </li>
            ))}
          </ul>
        </div>
        <div className="border-b border-[#232830] p-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#9aa1ab]">Members</h3>
          <ul className="space-y-1">
            {members.map((m) => (
              <li key={m.userId} className="flex items-center gap-2">
                <span className="truncate text-[#e6e9ee]" title={m.email}>
                  {m.name}
                </span>
                <span className="text-[#6f7782]">{m.role}</span>
                {role === 'owner' && m.role !== 'owner' ? (
                  <form action={removeMemberAction} className="ml-auto">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="userId" value={m.userId} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <button className="text-[#6f7782] hover:text-rose-300" title="Remove member">
                      ×
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          {role === 'owner' ? (
            <form action={addMemberAction} className="mt-2 flex flex-col gap-1">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <input
                name="email"
                type="email"
                required
                placeholder="collaborator@example.com"
                className="rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1 outline-none focus:border-emerald-500/60"
              />
              <div className="flex gap-1">
                <select name="role" className="flex-1 rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1">
                  <option value="editor">editor</option>
                  <option value="viewer">viewer</option>
                </select>
                <button className="rounded border border-emerald-500/40 px-2 py-1 text-emerald-300 hover:bg-emerald-500/10">Add</button>
              </div>
            </form>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#9aa1ab]">Activity</h3>
          <ul className="space-y-1.5">
            {events.map((event) => (
              <li key={event.id} className="text-[#aab1bb]">
                <span className="text-[#e6e9ee]">{event.type}</span>
                <span className="block text-[10px] text-[#6f7782]">
                  {event.actorKind} · {formatTimestamp(event.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-[#232830] p-2 text-[10px] text-[#6f7782]">
          you: {members.find((m) => m.userId === currentUserId)?.name ?? 'unknown'} ({role})
        </div>
      </aside>
    </div>
  );
}
