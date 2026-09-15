'use client';

import { useState } from 'react';
import type { WorkspaceRole } from '@notea/protocol';
import { approveTaskAction, cancelTaskAction, createTaskAction, deleteTaskAction, requeueTaskAction, updatePolicyAction } from '@/lib/actions';

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
  credentials: Array<{ id: string; provider: string; label: string; masked: string }>;
  policy: { overlap: string; integration: string; checkCommand: string | null; baseBranch: string };
  credentialsConfigured: boolean;
}

const STATUS_STYLE: Record<string, string> = {
  queued: 'text-[#aab1bb] border-[#3a404a]',
  running: 'text-emerald-300 border-emerald-500/40',
  needs_review: 'text-amber-300 border-amber-500/40',
  approved: 'text-sky-300 border-sky-500/40',
  integrating: 'text-sky-300 border-sky-500/40',
  needs_rebase: 'text-rose-300 border-rose-500/40',
  checks_failed: 'text-rose-300 border-rose-500/40',
  done: 'text-emerald-200 border-emerald-500/30',
  failed: 'text-rose-300 border-rose-500/40',
  cancelled: 'text-[#6f7782] border-[#3a404a]',
  draft: 'text-[#6f7782] border-[#3a404a]',
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

export function TasksPanel({ workspaceId, role, returnTo, tasks, runtimes, models, credentials, policy, credentialsConfigured }: TasksPanelProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [showPolicy, setShowPolicy] = useState(false);
  const [runtime, setRuntime] = useState(runtimes[0]?.id ?? 'claude-code-cli');
  const [expanded, setExpanded] = useState<string | null>(null);
  const canEdit = role !== 'viewer';
  const selectedRuntime = runtimes.find((r) => r.id === runtime);
  const compatibleModels = models.filter((m) => !selectedRuntime?.provider || m.provider === selectedRuntime.provider);
  const compatibleCredentials = credentials.filter((c) => !selectedRuntime?.provider || c.provider === selectedRuntime.provider);

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex items-center gap-2 border-b border-[#232830] px-3 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[#9aa1ab]">Agent tasks</h3>
        <span className="text-[#6f7782]">{tasks.length}</span>
        <div className="ml-auto flex gap-1">
          {role === 'owner' ? (
            <button onClick={() => setShowPolicy((v) => !v)} className="rounded border border-[#2b313b] px-2 py-0.5 hover:bg-[#1c2027]">
              Policy
            </button>
          ) : null}
          {canEdit ? (
            <button onClick={() => setShowCreate((v) => !v)} className="rounded bg-emerald-500 px-2 py-0.5 font-medium text-black hover:bg-emerald-400">
              + Task
            </button>
          ) : null}
        </div>
      </div>

      {showPolicy ? (
        <form action={updatePolicyAction} className="space-y-2 border-b border-[#232830] bg-[#14171c] p-3">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="block">
            <span className="text-[#9aa1ab]">Overlapping scopes</span>
            <select name="overlap" defaultValue={policy.overlap} className="mt-0.5 w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1">
              <option value="block">block (wait for the running task)</option>
              <option value="warn">warn (run anyway)</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[#9aa1ab]">Integration</span>
            <select name="integration" defaultValue={policy.integration} className="mt-0.5 w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1">
              <option value="human">human approval required</option>
              <option value="auto">automatic after a successful run</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[#9aa1ab]">Check command (run before merging)</span>
            <input name="checkCommand" defaultValue={policy.checkCommand ?? ''} placeholder="npm test" className="mono mt-0.5 w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1" />
          </label>
          <label className="block">
            <span className="text-[#9aa1ab]">Base branch</span>
            <input name="baseBranch" defaultValue={policy.baseBranch} className="mono mt-0.5 w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1" />
          </label>
          <button className="rounded border border-emerald-500/40 px-2 py-1 text-emerald-300 hover:bg-emerald-500/10">Save policy</button>
        </form>
      ) : null}

      {showCreate ? (
        <form action={createTaskAction} className="space-y-2 border-b border-[#232830] bg-[#14171c] p-3">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input name="title" required maxLength={200} placeholder="Title" className="w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1" />
          <textarea
            name="description"
            required
            rows={4}
            placeholder="What should the agent do? Be specific about acceptance criteria."
            className="w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1"
          />
          <label className="block">
            <span className="text-[#9aa1ab]">Runtime</span>
            <select name="runtime" value={runtime} onChange={(e) => setRuntime(e.target.value)} className="mt-0.5 w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1">
              {runtimes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          {runtime === 'generic-cli' ? (
            <input name="command" placeholder="command to run in the worktree, e.g. ./scripts/agent.sh" className="mono w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1" />
          ) : (
            <>
              <label className="block">
                <span className="text-[#9aa1ab]">Model</span>
                <select name="model" defaultValue="" className="mt-0.5 w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1">
                  <option value="">runtime default</option>
                  {compatibleModels.map((m) => (
                    <option key={`${m.provider}:${m.modelId}`} value={`${m.provider}:${m.modelId}`}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[#9aa1ab]">Credential</span>
                <select name="credentialId" defaultValue="" className="mt-0.5 w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1">
                  <option value="">none (CLI login inside the workspace)</option>
                  {compatibleCredentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} ({c.masked})
                    </option>
                  ))}
                </select>
                {!credentialsConfigured ? <span className="text-[10px] text-[#6f7782]">Set CREDENTIALS_KEY to store API keys under Settings.</span> : null}
              </label>
            </>
          )}
          <input name="scope" placeholder="scope globs, comma separated (src/api/**, docs)" className="mono w-full rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1" />
          <div className="flex gap-2">
            <input name="agentName" placeholder="agent name (optional)" className="flex-1 rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1" />
            <input name="maxMinutes" type="number" min={1} max={240} defaultValue={30} title="max minutes" className="w-20 rounded border border-[#2b313b] bg-[#0e1014] px-2 py-1" />
          </div>
          <button className="rounded bg-emerald-500 px-2 py-1 font-medium text-black hover:bg-emerald-400">Queue task</button>
        </form>
      ) : null}

      <ul className="min-h-0 flex-1 divide-y divide-[#232830] overflow-auto">
        {tasks.length === 0 ? <li className="p-3 text-[#6f7782]">No tasks yet. Queue one and watch its terminal appear.</li> : null}
        {tasks.map((task) => {
          const open = expanded === task.id;
          return (
            <li key={task.id} className="p-3">
              <div className="flex items-start gap-2">
                <button onClick={() => setExpanded(open ? null : task.id)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-1 text-[10px] uppercase ${STATUS_STYLE[task.status] ?? ''}`}>{task.status.replace('_', ' ')}</span>
                    <span className="truncate font-medium text-[#e6e9ee]">{task.title}</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-[#6f7782]">
                    {task.agentName} · {task.runtime}
                    {task.modelId ? ` · ${task.modelId}` : ''}
                    {task.run ? ` · run ${task.run.attempt}` : ''}
                    {task.usage?.costUsd != null ? ` · $${task.usage.costUsd.toFixed(3)}` : ''}
                  </div>
                </button>
              </div>
              {canEdit ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {task.status === 'needs_review' || task.status === 'checks_failed' ? (
                    <form action={approveTaskAction}>
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <button className="rounded border border-emerald-500/40 px-2 py-0.5 text-emerald-300 hover:bg-emerald-500/10">Approve & integrate</button>
                    </form>
                  ) : null}
                  {['queued', 'running', 'needs_review', 'approved'].includes(task.status) ? (
                    <form action={cancelTaskAction}>
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <button className="rounded border border-[#2b313b] px-2 py-0.5 hover:bg-[#1c2027]">Cancel</button>
                    </form>
                  ) : null}
                  {['failed', 'needs_rebase', 'checks_failed', 'cancelled', 'needs_review'].includes(task.status) ? (
                    <form action={requeueTaskAction}>
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <button className="rounded border border-[#2b313b] px-2 py-0.5 hover:bg-[#1c2027]">Run again</button>
                    </form>
                  ) : null}
                  {role === 'owner' && !['running', 'integrating'].includes(task.status) ? (
                    <form action={deleteTaskAction}>
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <button className="rounded border border-rose-500/30 px-2 py-0.5 text-rose-300 hover:bg-rose-500/10">Delete</button>
                    </form>
                  ) : null}
                </div>
              ) : null}
              {open ? (
                <div className="mt-2 space-y-2 rounded border border-[#232830] bg-[#0e1014] p-2">
                  <p className="whitespace-pre-wrap text-[#c3c8d0]">{task.description}</p>
                  {task.scope.length > 0 ? <p className="mono text-[#9aa1ab]">scope: {task.scope.join(', ')}</p> : null}
                  {task.branch ? <p className="mono text-[#9aa1ab]">branch: {task.branch}</p> : null}
                  {task.summary ? <p className="whitespace-pre-wrap text-emerald-200">{task.summary}</p> : null}
                  {task.diffStat ? <pre className="mono whitespace-pre-wrap text-[#9aa1ab]">{task.diffStat}</pre> : null}
                  {task.lastLog ? <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap text-rose-200">{task.lastLog}</pre> : null}
                  {task.events.length > 0 ? (
                    <ol className="max-h-64 space-y-0.5 overflow-auto">
                      {task.events.map((event) => (
                        <li key={event.seq} className="mono text-[10px] text-[#aab1bb]">
                          <span className="text-[#6f7782]">{event.seq}</span> {eventText(event)}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
