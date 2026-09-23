'use client';

import { Play, Power, SquareTerminal, UserPlus, Users, WifiOff, X } from 'lucide-react';
import { AnimatePresence, m } from 'motion/react';
import { useState, type CSSProperties } from 'react';
import type { WorkspaceRole } from '@notea/protocol';
import { addMemberAction, removeMemberAction, startWorkspaceAction } from '@/lib/actions';
import { describeEvent, formatEventTime, type ActivityEvent, type ActivityTone } from '@/lib/activity';
import { claudePanes } from '@/lib/claude-panes';
import { ClaudeTerminal } from './claude-terminal';
import { TasksPanel, type TasksPanelProps } from './tasks-panel';
import { Avatar } from './ui/avatar';
import { cx } from './ui/cx';
import { SegmentedTabs } from './ui/segmented-tabs';
import { SubmitButton } from './ui/submit-button';
import { useWorkspaceSocket, WorkspaceSocketProvider } from './workspace-socket';

export interface WorkspaceViewProps {
  workspaceId: string;
  slug: string;
  role: WorkspaceRole;
  running: boolean;
  members: Array<{ userId: string; email: string; name: string; role: WorkspaceRole }>;
  events: ActivityEvent[];
  currentUserId: string;
  returnTo: string;
  tasks: TasksPanelProps;
}

const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };

export function WorkspaceView(props: WorkspaceViewProps) {
  if (!props.running) {
    const canStart = props.role !== 'viewer';
    return (
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="flex flex-1 items-center justify-center px-6 py-12">
          <div className="page-enter max-w-sm text-center">
            <span className="mx-auto grid size-11 place-items-center rounded-full border border-line-strong bg-raised text-fg-subtle">
              <Power className="size-[18px]" aria-hidden />
            </span>
            <h2 className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-fg">This workspace is not running</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
              {canStart
                ? 'Start it to open everyone’s Claude. The project, its history and each person’s Claude sign-in are kept while it is stopped.'
                : 'Ask an editor or the owner to start it. Its tasks are listed alongside.'}
            </p>
            {canStart ? (
              <form action={startWorkspaceAction} className="mt-5">
                <input type="hidden" name="workspaceId" value={props.workspaceId} />
                <input type="hidden" name="returnTo" value={props.returnTo} />
                <SubmitButton className="btn-primary" icon={<Play aria-hidden />} pendingLabel="Starting…">
                  Start workspace
                </SubmitButton>
              </form>
            ) : null}
          </div>
        </main>
        <aside
          aria-label="Tasks"
          className="flex min-h-0 flex-col border-t border-line bg-panel max-lg:flex-1 lg:w-80 lg:flex-none lg:border-l lg:border-t-0 xl:w-[22rem]"
        >
          <div className="pane-header">
            <h2 className="pane-title">Tasks</h2>
          </div>
          <div className="min-h-0 flex-1">
            <TasksPanel {...props.tasks} />
          </div>
        </aside>
      </div>
    );
  }
  return (
    <WorkspaceSocketProvider workspaceId={props.workspaceId}>
      <WorkspaceLayout {...props} />
    </WorkspaceSocketProvider>
  );
}

type PanelTab = 'people' | 'activity' | 'tasks';

/** The phone layout's switcher: one entry per Claude terminal (by member id), plus this. */
const TEAM_VIEW = 'team';

function WorkspaceLayout({ workspaceId, role, members, events, currentUserId, returnTo, tasks }: WorkspaceViewProps) {
  const { state, presence, lastClose } = useWorkspaceSocket();
  // One Claude per member who can write, side by side: the whole middle of the page.
  const panes = claudePanes(members, currentUserId);
  const [tab, setTab] = useState<PanelTab>('people');
  // Below the `lg` breakpoint one pane is shown at a time, your own Claude first; every
  // pane stays mounted, so the terminals keep their connections while hidden.
  const [chosen, setView] = useState<string>(() => panes.find((pane) => pane.isYou)?.userId ?? panes[0]?.userId ?? TEAM_VIEW);
  // A member who was removed takes their pane with them.
  const view = chosen === TEAM_VIEW || panes.some((pane) => pane.userId === chosen) ? chosen : (panes[0]?.userId ?? TEAM_VIEW);
  const columns = { '--pane-columns': panes.length <= 3 ? Math.max(panes.length, 1) : 2 } as CSSProperties;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ConnectionStatus state={state} reason={lastClose?.reason} />
      <div className="flex-none border-b border-line bg-panel px-2 py-1.5 lg:hidden">
        <SegmentedTabs
          label="Workspace pane"
          idPrefix="workspace-view"
          value={view}
          onChange={setView}
          tabs={[
            ...panes.map((pane) => ({ id: pane.userId, label: pane.shortLabel, icon: <SquareTerminal className="size-3.5" aria-hidden /> })),
            { id: TEAM_VIEW, label: 'Team', icon: <Users className="size-3.5" aria-hidden /> },
          ]}
        />
      </div>
      <div id="workspace-view-panel" className="flex min-h-0 flex-1">
        <section
          aria-label="Claude terminals"
          style={columns}
          className={cx(
            'min-h-0 min-w-0 flex-1 gap-px bg-line lg:grid lg:[grid-auto-rows:minmax(0,1fr)] lg:[grid-template-columns:repeat(var(--pane-columns),minmax(0,1fr))]',
            view === TEAM_VIEW ? 'hidden' : 'flex',
          )}
        >
          {panes.map((pane) => (
            <div key={pane.userId} className={cx('min-h-0 min-w-0 flex-1 lg:block', view === pane.userId ? 'block' : 'hidden')}>
              <ClaudeTerminal workspaceId={workspaceId} pane={pane} />
            </div>
          ))}
        </section>
        <aside
          aria-label="People, activity and tasks"
          className={cx(
            'min-h-0 min-w-0 flex-col bg-panel lg:flex lg:w-80 lg:flex-none lg:border-l lg:border-line xl:w-[22rem]',
            view === TEAM_VIEW ? 'flex flex-1' : 'hidden',
          )}
        >
          <div className="flex-none border-b border-line px-2 py-1.5">
            <SegmentedTabs
              label="Workspace panel"
              idPrefix="workspace-panel"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'people', label: 'People', count: presence.length },
                { id: 'activity', label: 'Activity' },
                { id: 'tasks', label: 'Tasks', count: tasks.tasks.length },
              ]}
            />
          </div>
          <m.div
            key={tab}
            id="workspace-panel-panel"
            role="tabpanel"
            aria-labelledby={`workspace-panel-tab-${tab}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="min-h-0 flex-1 overflow-hidden"
          >
            {tab === 'people' ? (
              <PeoplePanel workspaceId={workspaceId} role={role} members={members} currentUserId={currentUserId} returnTo={returnTo} />
            ) : null}
            {tab === 'activity' ? <ActivityPanel events={events} currentUserId={currentUserId} members={members} tasks={tasks.tasks} /> : null}
            {tab === 'tasks' ? <TasksPanel {...tasks} /> : null}
          </m.div>
        </aside>
      </div>
    </div>
  );
}

/**
 * The workspace connection's state, as a pill floating over the panes rather than a
 * banner that pushes them down. It fades in late, so a quick first connect never
 * shows it at all.
 */
function ConnectionStatus({ state, reason }: { state: string; reason?: string }) {
  const closed = state === 'closed';
  return (
    <AnimatePresence>
      {state !== 'open' ? (
        <m.div
          key="connection"
          role="status"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0, transition: { delay: 0.4, duration: 0.24, ease: [0.16, 1, 0.3, 1] } }}
          exit={{ opacity: 0, y: -6, transition: { duration: 0.16 } }}
          className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-3"
        >
          <span
            className={cx(
              'pointer-events-auto flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-[0_12px_32px_-12px_rgb(0_0_0/0.9)]',
              closed ? 'border-danger/30 bg-[#1b1110] text-[#f3b1aa]' : 'border-warn/30 bg-[#1a160d] text-[#ecd3a1]',
            )}
          >
            {closed ? (
              <WifiOff className="size-3.5 flex-none" aria-hidden />
            ) : (
              <span className="status-dot tone-warn" data-pulse="" aria-hidden />
            )}
            <span className="truncate">
              {closed
                ? `Disconnected${reason ? `: ${reason}` : ''}. Reload the page to reconnect.`
                : state === 'reconnecting'
                  ? 'Connection lost. Reconnecting…'
                  : 'Connecting to the workspace…'}
            </span>
          </span>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

function PeoplePanel({
  workspaceId,
  role,
  members,
  currentUserId,
  returnTo,
}: {
  workspaceId: string;
  role: WorkspaceRole;
  members: WorkspaceViewProps['members'];
  currentUserId: string;
  returnTo: string;
}) {
  const { presence } = useWorkspaceSocket();
  return (
    <div className="h-full space-y-6 overflow-y-auto px-3 py-4">
      <section>
        <h3 className="px-1 text-xs font-medium text-fg-subtle">Here now</h3>
        <ul className="mt-2 space-y-0.5">
          {presence.length === 0 ? <li className="px-1 text-[13px] text-fg-subtle">Nobody is connected.</li> : null}
          {presence.map((client) => (
            <li key={client.id} className="flex items-center gap-2.5 rounded-md px-1 py-1.5">
              <span className="relative">
                <Avatar name={client.name} kind={client.kind === 'agent' ? 'agent' : 'user'} />
                <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-accent ring-2 ring-panel" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-fg">
                  {client.name}
                  {client.userId === currentUserId ? <span className="text-fg-subtle"> (you)</span> : null}
                </p>
                <p className="text-xs text-fg-subtle">
                  {client.kind === 'agent' ? 'Agent' : ROLE_LABEL[client.role]}
                  {client.attachedSessionIds.length > 0
                    ? `, watching ${client.attachedSessionIds.length} terminal${client.attachedSessionIds.length === 1 ? '' : 's'}`
                    : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="px-1 text-xs font-medium text-fg-subtle">Members</h3>
        <ul className="mt-2 space-y-0.5">
          {members.map((member) => (
            <li key={member.userId} className="group flex items-center gap-2.5 rounded-md px-1 py-1.5">
              <Avatar name={member.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-fg">
                  {member.name}
                  {member.userId === currentUserId ? <span className="text-fg-subtle"> (you)</span> : null}
                </p>
                <p className="truncate text-xs text-fg-subtle">{member.email}</p>
              </div>
              <span className="flex-none text-xs text-fg-muted">{ROLE_LABEL[member.role]}</span>
              {role === 'owner' && member.role !== 'owner' ? (
                <form action={removeMemberAction} className="flex-none">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="userId" value={member.userId} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <SubmitButton className="btn-ghost btn-icon btn-xs hover:text-danger" aria-label={`Remove ${member.name}`} title={`Remove ${member.name}`}>
                    <X aria-hidden />
                  </SubmitButton>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {role === 'owner' ? (
          <form action={addMemberAction} className="mt-4 rounded-lg border border-line bg-canvas/60 p-3">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <label htmlFor="member-email" className="field-label">
              Add a member
            </label>
            <input
              id="member-email"
              name="email"
              type="email"
              required
              placeholder="colleague@example.com"
              autoComplete="off"
              className="input input-sm"
            />
            <div className="mt-2 flex gap-2">
              <select name="role" aria-label="Role" defaultValue="editor" className="input input-sm flex-1">
                <option value="editor">Editor: can edit and run tasks</option>
                <option value="viewer">Viewer: read only</option>
              </select>
              <SubmitButton className="btn-secondary btn-sm" icon={<UserPlus aria-hidden />}>
                Add
              </SubmitButton>
            </div>
            <p className="field-hint">They need an account already; there are no invitations yet.</p>
          </form>
        ) : null}
      </section>
    </div>
  );
}

const TONE_DOT: Record<ActivityTone, string> = {
  neutral: 'bg-fg-faint',
  agent: 'bg-agent',
  ok: 'bg-accent',
  danger: 'bg-danger',
};

function ActivityPanel({
  events,
  currentUserId,
  members,
  tasks,
}: {
  events: ActivityEvent[];
  currentUserId: string;
  members: WorkspaceViewProps['members'];
  tasks: TasksPanelProps['tasks'];
}) {
  if (events.length === 0) {
    return <p className="px-4 py-6 text-[13px] text-fg-subtle">Nothing has happened here yet.</p>;
  }
  return (
    <ol className="h-full overflow-y-auto px-3 py-3">
      {events.map((event, index) => {
        const line = describeEvent(event, { currentUserId, members, tasks });
        return (
          <li key={event.id} className="relative flex gap-3 pb-4 last:pb-1">
            {/* The rail joins the events into one timeline, newest first. */}
            {index < events.length - 1 ? <span className="absolute bottom-0 left-[3.5px] top-3 w-px bg-line" aria-hidden /> : null}
            <span className={cx('relative mt-[7px] size-2 flex-none rounded-full ring-4 ring-panel', TONE_DOT[line.tone])} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug text-fg-muted">
                <span className="font-medium text-fg">{line.actor}</span> {line.action}
                {line.subject ? <span className="text-fg"> “{line.subject}”</span> : null}
              </p>
              <p className="mt-0.5 text-[11.5px] text-fg-subtle">
                <time dateTime={event.createdAt}>{formatEventTime(event.createdAt)}</time>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
