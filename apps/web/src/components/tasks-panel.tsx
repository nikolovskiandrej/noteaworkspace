'use client';

import { Ban, ChevronDown, GitBranch, GitMerge, ListChecks, Plus, RotateCcw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { AnimatePresence, m } from 'motion/react';
import { useId, useState } from 'react';
import type { WorkspaceRole } from '@notea/protocol';
import { approveTaskAction, cancelTaskAction, createTaskAction, deleteTaskAction, requeueTaskAction, updatePolicyAction } from '@/lib/actions';
import { StatusBadge } from './status-badge';
import { cx } from './ui/cx';
import { Field } from './ui/field';
import { SubmitButton } from './ui/submit-button';

export interface TaskListItem {
  id: string;
  title: string;
  description: string;
  status: string;
  runtime: string;
  provider: string | null;
  modelId: string | null;
  agentName: string;
  scope: string[];
  branch: string | null;
  summary: string | null;
  diffStat: string | null;
  lastLog: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
  createdAt: string;
  updatedAt: string;
  run: { id: string; attempt: number; status: string; sessionId: string | null } | null;
  events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
}

export interface TasksPanelProps {
  workspaceId: string;
  role: WorkspaceRole;
  returnTo: string;
  tasks: TaskListItem[];
  runtimes: Array<{ id: string; label: string; provider: string | null }>;
  models: Array<{ provider: string; modelId: string; label: string }>;
  credentials: Array<{ id: string; provider: string; label: string; masked: string; authLabel: string; apiBilled: boolean }>;
  policy: { overlap: string; integration: string; checkCommand: string | null; baseBranch: string };
  credentialsConfigured: boolean;
}

const EASE = [0.16, 1, 0.3, 1] as const;
const REVEAL = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: { duration: 0.26, ease: EASE } },
  exit: { height: 0, opacity: 0, transition: { duration: 0.18, ease: EASE } },
};

function eventText(event: TaskListItem['events'][number]): string {
  const p = event.payload;
  switch (event.type) {
    case 'message':
      return `${String(p.role)}: ${String(p.text).slice(0, 300)}`;
    case 'tool_call':
      return `tool ${String(p.name)} ${JSON.stringify(p.input).slice(0, 160)}`;
    case 'file_changed':
      return `edited ${String(p.path)}`;
    case 'usage':
      return `usage in=${String(p.inputTokens)} out=${String(p.outputTokens)}${p.costUsd != null ? ` $${Number(p.costUsd).toFixed(4)}` : ''}`;
    case 'finished':
      return `finished: ${String(p.outcome)}${p.summary ? ` — ${String(p.summary).slice(0, 300)}` : ''}`;
    case 'log':
      return String(p.text).slice(0, 300);
    default:
      return event.type;
  }
}

function eventTone(event: TaskListItem['events'][number]): string {
  switch (event.type) {
    case 'tool_call':
      return 'text-info';
    case 'file_changed':
      return 'text-accent';
    case 'usage':
    case 'started':
      return 'text-fg-subtle';
    case 'finished':
      return event.payload.outcome === 'completed' ? 'text-accent' : 'text-danger';
    case 'message':
      return 'text-fg';
    default:
      return 'text-fg-muted';
  }
}

/** `git diff --stat`, with its bars in the colours of what they count. */
function DiffStat({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-canvas px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fg-muted">
      {text.split('\n').map((line, index) => {
        const match = /^(.*\|\s*\d+\s)(\+*)(-*)\s*$/.exec(line);
        return (
          <span key={index} className="block">
            {match ? (
              <>
                {match[1]}
                <span className="text-accent">{match[2]}</span>
                <span className="text-danger">{match[3]}</span>
              </>
            ) : (
              line
            )}
          </span>
        );
      })}
    </pre>
  );
}

export function TasksPanel({ workspaceId, role, returnTo, tasks, runtimes, models, credentials, policy, credentialsConfigured }: TasksPanelProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [showPolicy, setShowPolicy] = useState(false);
  const [runtime, setRuntime] = useState(runtimes[0]?.id ?? 'claude-code-cli');
  const [expanded, setExpanded] = useState<string | null>(null);
  const id = useId();
  const canEdit = role !== 'viewer';
  const selectedRuntime = runtimes.find((r) => r.id === runtime);
  const compatibleModels = models.filter((m) => !selectedRuntime?.provider || m.provider === selectedRuntime.provider);
  const compatibleCredentials = credentials.filter((c) => !selectedRuntime?.provider || c.provider === selectedRuntime.provider);
  const runtimeLabel = (runtimeId: string) => runtimes.find((r) => r.id === runtimeId)?.label ?? runtimeId;

  const active = tasks.filter((t) => t.status === 'running' || t.status === 'integrating').length;
  const toReview = tasks.filter((t) => t.status === 'needs_review' || t.status === 'checks_failed').length;
  const summary =
    [active ? `${active} running` : null, toReview ? `${toReview} to review` : null].filter(Boolean).join(', ') ||
    (tasks.length > 0 ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}` : 'No tasks yet');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center gap-2 px-3 pb-2 pt-2.5">
        <p className="min-w-0 flex-1 truncate text-xs text-fg-subtle" aria-live="polite">
          {summary}
        </p>
        {role === 'owner' ? (
          <button
            type="button"
            onClick={() => setShowPolicy((v) => !v)}
            aria-expanded={showPolicy}
            aria-controls={`${id}-policy`}
            className={cx('btn btn-ghost btn-xs', showPolicy && 'bg-hover text-fg')}
            title="How tasks share files and reach the base branch"
          >
            <SlidersHorizontal aria-hidden />
            Policy
          </button>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            aria-expanded={showCreate}
            aria-controls={`${id}-create`}
            className={cx('btn btn-xs', showCreate ? 'btn-secondary' : 'btn-primary')}
          >
            <Plus aria-hidden className={cx('transition-transform duration-200', showCreate && 'rotate-45')} />
            {showCreate ? 'Close' : 'New task'}
          </button>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {showPolicy ? (
          <m.div key="policy" id={`${id}-policy`} {...REVEAL} className="flex-none overflow-hidden">
            <form
              action={async (formData) => {
                await updatePolicyAction(formData);
                setShowPolicy(false);
              }}
              className="mx-3 mb-3 space-y-3 rounded-lg border border-line bg-canvas/60 p-3"
            >
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="Overlapping scopes" htmlFor={`${id}-overlap`}>
                <select id={`${id}-overlap`} name="overlap" defaultValue={policy.overlap} className="input input-sm">
                  <option value="block">Wait for the running task</option>
                  <option value="warn">Run anyway</option>
                </select>
              </Field>
              <Field label="Integration" htmlFor={`${id}-integration`}>
                <select id={`${id}-integration`} name="integration" defaultValue={policy.integration} className="input input-sm">
                  <option value="human">A person approves each task</option>
                  <option value="auto">Automatic after a successful run</option>
                </select>
              </Field>
              <Field label="Check command" htmlFor={`${id}-check`} hint="Runs before a task is merged; a failure stops the merge.">
                <input id={`${id}-check`} name="checkCommand" defaultValue={policy.checkCommand ?? ''} placeholder="npm test" spellCheck={false} className="input input-sm font-mono" />
              </Field>
              <Field label="Base branch" htmlFor={`${id}-base`}>
                <input id={`${id}-base`} name="baseBranch" defaultValue={policy.baseBranch} spellCheck={false} className="input input-sm font-mono" />
              </Field>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPolicy(false)}>
                  Cancel
                </button>
                <SubmitButton className="btn-secondary btn-sm" pendingLabel="Saving…">
                  Save policy
                </SubmitButton>
              </div>
            </form>
          </m.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {showCreate ? (
          <m.div key="create" id={`${id}-create`} {...REVEAL} className="flex min-h-0 flex-none flex-col overflow-hidden">
            <form
              action={async (formData) => {
                // The page stays mounted after an action (`finish` in lib/actions.ts), so
                // the form closes itself once the task is queued.
                await createTaskAction(formData);
                setShowCreate(false);
              }}
              className="mx-3 mb-3 max-h-[60vh] space-y-3 overflow-y-auto rounded-lg border border-line bg-canvas/60 p-3"
            >
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="Title" htmlFor={`${id}-title`}>
                <input id={`${id}-title`} name="title" required maxLength={200} placeholder="Add a /health endpoint" autoComplete="off" className="input input-sm" />
              </Field>
              <Field label="Instructions" htmlFor={`${id}-description`}>
                <textarea
                  id={`${id}-description`}
                  name="description"
                  required
                  rows={4}
                  placeholder="What should the agent do? Be specific about acceptance criteria."
                  className="input text-[12.5px]"
                />
              </Field>
              <Field label="Runtime" htmlFor={`${id}-runtime`}>
                <select id={`${id}-runtime`} name="runtime" value={runtime} onChange={(e) => setRuntime(e.target.value)} className="input input-sm">
                  {runtimes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
              {runtime === 'generic-cli' ? (
                <Field label="Command" htmlFor={`${id}-command`} hint="Runs inside the task's own worktree.">
                  <input id={`${id}-command`} name="command" placeholder="./scripts/agent.sh" spellCheck={false} className="input input-sm font-mono" />
                </Field>
              ) : (
                <>
                  <Field label="Model" htmlFor={`${id}-model`}>
                    <select id={`${id}-model`} name="model" defaultValue="" className="input input-sm">
                      <option value="">Runtime default</option>
                      {compatibleModels.map((m) => (
                        <option key={`${m.provider}:${m.modelId}`} value={`${m.provider}:${m.modelId}`}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="Your AI connection"
                    htmlFor={`${id}-credential`}
                    hint={!credentialsConfigured ? 'Set CREDENTIALS_KEY to store connections under Settings.' : 'Choosing a connection chooses who pays for the run.'}
                  >
                    <select id={`${id}-credential`} name="credentialId" defaultValue="" className="input input-sm">
                      <option value="">None: the CLI login in your own agent home</option>
                      {/* The billing mode is on the option itself: choosing a connection is choosing who pays. */}
                      {compatibleCredentials.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label} ({c.authLabel}, {c.apiBilled ? 'API billing' : 'no API charges'})
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
              <Field label={<>Scope <span className="font-normal text-fg-subtle">(optional)</span></>} htmlFor={`${id}-scope`} hint="Paths or globs the task works in, comma separated.">
                <input id={`${id}-scope`} name="scope" placeholder="src/api/**, docs" spellCheck={false} className="input input-sm font-mono" />
              </Field>
              <div className="grid grid-cols-[minmax(0,1fr)_4.25rem_4.25rem] gap-2">
                <Field label="Agent name" htmlFor={`${id}-agent`}>
                  <input id={`${id}-agent`} name="agentName" placeholder="Optional" autoComplete="off" className="input input-sm" />
                </Field>
                <Field label="Minutes" htmlFor={`${id}-minutes`}>
                  <input id={`${id}-minutes`} name="maxMinutes" type="number" min={1} max={240} defaultValue={30} className="input input-sm tabular-nums" />
                </Field>
                <Field label="Max $" htmlFor={`${id}-budget`}>
                  <input
                    id={`${id}-budget`}
                    name="maxBudgetUsd"
                    type="number"
                    min={0}
                    step={0.5}
                    placeholder="None"
                    title="Maximum spend in USD (Claude Code)"
                    className="input input-sm tabular-nums"
                  />
                </Field>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowCreate(false)}>
                  Cancel
                </button>
                <SubmitButton className="btn-primary btn-sm" icon={<Plus aria-hidden />} pendingLabel="Queueing…">
                  Queue task
                </SubmitButton>
              </div>
            </form>
          </m.div>
        ) : null}
      </AnimatePresence>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {tasks.length === 0 ? (
          <li className="px-4 py-8 text-center">
            <span className="mx-auto grid size-10 place-items-center rounded-full border border-line bg-canvas text-fg-subtle">
              <ListChecks className="size-[18px]" aria-hidden />
            </span>
            <p className="mt-3 text-[13px] font-medium text-fg">No tasks yet</p>
            <p className="mx-auto mt-1 max-w-64 text-[12.5px] leading-relaxed text-fg-subtle">
              {canEdit
                ? 'Queue one and an agent works on it in its own branch. Its run log shows up here as it goes.'
                : 'Tasks an editor queues show up here.'}
            </p>
          </li>
        ) : null}
        <AnimatePresence initial={false}>
          {tasks.map((task) => {
            const open = expanded === task.id;
            const canApprove = task.status === 'needs_review' || task.status === 'checks_failed';
            const canRequeue = ['failed', 'needs_rebase', 'checks_failed', 'cancelled', 'needs_review'].includes(task.status);
            const canCancel = ['queued', 'running', 'needs_review', 'approved'].includes(task.status);
            const canDelete = role === 'owner' && !['running', 'integrating'].includes(task.status);
            // Cancel is spelled out when it is the one thing to do (a queued or running
            // task); next to Approve and Run again it shrinks to an icon.
            const cancelIsMain = !canApprove && !canRequeue;
            const label = runtimeLabel(task.runtime);
            const engine = task.modelId ?? (label.startsWith(task.agentName) ? null : label);
            return (
              <m.li
                key={task.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto', transition: { duration: 0.28, ease: EASE } }}
                exit={{ opacity: 0, height: 0, transition: { duration: 0.2, ease: EASE } }}
                className="overflow-hidden"
              >
                <div
                  className={cx(
                    'mt-1 rounded-lg border px-2.5 py-2.5 transition-colors duration-150',
                    open ? 'border-line bg-raised/50' : 'border-transparent hover:bg-raised/40',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : task.id)}
                    aria-expanded={open}
                    aria-controls={`${id}-task-${task.id}`}
                    className="flex w-full items-start gap-2 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[13px] font-medium leading-snug text-fg">{task.title}</span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-fg-subtle">
                        <StatusBadge status={task.status} kind="task" />
                        <span className="text-fg-muted">{task.agentName}</span>
                        {engine ? <span>{engine}</span> : null}
                        {task.run ? <span className="tabular-nums">Run {task.run.attempt}</span> : null}
                        {task.usage?.costUsd != null ? <span className="tabular-nums">${task.usage.costUsd.toFixed(3)}</span> : null}
                      </span>
                    </span>
                    <ChevronDown
                      className={cx('mt-0.5 size-4 flex-none text-fg-faint transition-transform duration-200 ease-out', open && 'rotate-180 text-fg-subtle')}
                      aria-hidden
                    />
                  </button>

                  {canEdit && (canApprove || canRequeue || canCancel || canDelete) ? (
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {canApprove ? (
                        <form action={approveTaskAction}>
                          <input type="hidden" name="taskId" value={task.id} />
                          <input type="hidden" name="returnTo" value={returnTo} />
                          <SubmitButton className="btn-primary btn-xs" icon={<GitMerge aria-hidden />} pendingLabel="Approving…">
                            Approve &amp; integrate
                          </SubmitButton>
                        </form>
                      ) : null}
                      {canRequeue ? (
                        <form action={requeueTaskAction}>
                          <input type="hidden" name="taskId" value={task.id} />
                          <input type="hidden" name="returnTo" value={returnTo} />
                          <SubmitButton className="btn-secondary btn-xs" icon={<RotateCcw aria-hidden />}>
                            Run again
                          </SubmitButton>
                        </form>
                      ) : null}
                      {canCancel && cancelIsMain ? (
                        <form action={cancelTaskAction}>
                          <input type="hidden" name="taskId" value={task.id} />
                          <input type="hidden" name="returnTo" value={returnTo} />
                          <SubmitButton className="btn-secondary btn-xs" icon={<Ban aria-hidden />} pendingLabel="Cancelling…">
                            Cancel task
                          </SubmitButton>
                        </form>
                      ) : null}
                      <div className="ml-auto flex items-center gap-0.5">
                        {canCancel && !cancelIsMain ? (
                          <form action={cancelTaskAction}>
                            <input type="hidden" name="taskId" value={task.id} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <SubmitButton className="btn-ghost btn-icon btn-xs" icon={<Ban aria-hidden />} aria-label="Cancel task" title="Cancel task" />
                          </form>
                        ) : null}
                        {canDelete ? (
                          <form action={deleteTaskAction}>
                            <input type="hidden" name="taskId" value={task.id} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <SubmitButton
                              className="btn-ghost btn-icon btn-xs hover:bg-danger/10 hover:text-danger"
                              icon={<Trash2 aria-hidden />}
                              aria-label="Delete task"
                              title="Delete task"
                            />
                          </form>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  <AnimatePresence initial={false}>
                    {open ? (
                      <m.div key="details" id={`${id}-task-${task.id}`} {...REVEAL} className="overflow-hidden">
                        <div className="mt-3 space-y-3 border-t border-line pt-3">
                          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg-muted">{task.description}</p>
                          {task.scope.length > 0 || task.branch ? (
                            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-xs">
                              {task.scope.length > 0 ? (
                                <>
                                  <dt className="text-fg-subtle">Scope</dt>
                                  <dd className="flex flex-wrap gap-1">
                                    {task.scope.map((pattern) => (
                                      <code key={pattern} className="rounded border border-line bg-canvas px-1.5 py-px font-mono text-[11px] text-fg-muted">
                                        {pattern}
                                      </code>
                                    ))}
                                  </dd>
                                </>
                              ) : null}
                              {task.branch ? (
                                <>
                                  <dt className="text-fg-subtle">Branch</dt>
                                  <dd className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-fg-muted">
                                    <GitBranch className="size-3 flex-none text-fg-subtle" aria-hidden />
                                    <span className="break-all">{task.branch}</span>
                                  </dd>
                                </>
                              ) : null}
                            </dl>
                          ) : null}
                          {task.summary ? (
                            <p className="whitespace-pre-wrap rounded-md border border-accent/20 bg-accent/[0.06] px-2.5 py-2 text-[12.5px] leading-relaxed text-[#c3e4d2]">
                              {task.summary}
                            </p>
                          ) : null}
                          {task.diffStat ? <DiffStat text={task.diffStat} /> : null}
                          {task.lastLog ? (
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-danger/25 bg-danger/[0.05] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#f3b1aa]">
                              {task.lastLog}
                            </pre>
                          ) : null}
                          {task.events.length > 0 ? (
                            <div>
                              <p className="mb-1.5 text-xs text-fg-subtle">Run log</p>
                              <ol className="max-h-64 space-y-0.5 overflow-auto rounded-md border border-line bg-canvas px-2.5 py-2 font-mono text-[11px] leading-relaxed">
                                {task.events.map((event) => (
                                  <li key={event.seq} className="flex gap-2.5">
                                    <span className="w-5 flex-none text-right tabular-nums text-fg-faint">{event.seq}</span>
                                    <span className={cx('min-w-0 break-words', eventTone(event))}>{eventText(event)}</span>
                                  </li>
                                ))}
                              </ol>
                            </div>
                          ) : null}
                        </div>
                      </m.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              </m.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}
