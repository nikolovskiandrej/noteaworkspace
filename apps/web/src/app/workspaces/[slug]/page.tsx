import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { DEFAULT_COORDINATION_POLICY } from '@notea/db';
import { auth } from '@/auth';
import { AutoRefresh } from '@/components/auto-refresh';
import { StatusBadge } from '@/components/status-badge';
import { TopBar } from '@/components/top-bar';
import { WorkspaceView } from '@/components/workspace-view';
import { deleteWorkspaceAction, startWorkspaceAction, stopWorkspaceAction } from '@/lib/actions';
import { listCredentials } from '@/lib/credentials';
import { getDb } from '@/lib/db';
import { env } from '@/lib/env';
import { getOrchestrator } from '@/lib/orchestrator';
import { listTasksForWorkspace, modelOptions, runtimeOptions } from '@/lib/tasks';
import { getWorkspaceDetail } from '@/lib/workspaces';

const ACTIVE_STATUSES = new Set(['queued', 'running', 'approved', 'integrating']);

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  const { slug } = await params;
  const { error } = await searchParams;
  const db = getDb();
  const detail = await getWorkspaceDetail({ db, orchestrator: getOrchestrator() }, slug, session.user.id);
  if (!detail) notFound();

  const { workspace, role, runtime, members, events } = detail;
  const status = runtime?.status ?? 'unknown';
  const returnTo = `/workspaces/${workspace.slug}`;
  const rawKey = env().CREDENTIALS_KEY;
  const [taskViews, credentials] = await Promise.all([
    listTasksForWorkspace(db, workspace.id),
    listCredentials(db, session.user.id, rawKey ? Buffer.from(rawKey, 'hex') : null),
  ]);
  const tasks = taskViews.map(({ task, latestRun, events: runEvents }) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    runtime: task.runtime,
    provider: task.provider,
    modelId: task.modelId,
    agentName: task.agentName,
    scope: task.scope,
    branch: task.branch,
    summary: task.summary,
    diffStat: task.diffStat,
    lastLog: task.lastLog,
    usage: task.usage,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    run: latestRun ? { id: latestRun.id, attempt: latestRun.attempt, status: latestRun.status, sessionId: latestRun.sessionId } : null,
    events: runEvents.map((e) => ({ seq: e.seq, type: e.type, payload: e.payload as Record<string, unknown> })),
  }));
  const anyActive = tasks.some((t) => ACTIVE_STATUSES.has(t.status));

  return (
    <div className="flex h-full flex-col">
      <AutoRefresh intervalMs={5000} enabled={anyActive} />
      <TopBar userName={session.user.name ?? 'you'}>
        <Link href="/" className="text-[#6f7782] hover:text-[#c3c8d0]">
          Workspaces
        </Link>
        <span className="text-[#3a404a]">/</span>
        <span className="font-medium text-[#e6e9ee]">{workspace.name}</span>
        <StatusBadge status={status} />
        {role !== 'viewer' ? (
          status === 'running' ? (
            <form action={stopWorkspaceAction}>
              <input type="hidden" name="workspaceId" value={workspace.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <button className="rounded border border-[#2b313b] px-2 py-0.5 text-xs hover:bg-[#1c2027]">Stop</button>
            </form>
          ) : (
            <form action={startWorkspaceAction}>
              <input type="hidden" name="workspaceId" value={workspace.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <button className="rounded border border-emerald-500/40 px-2 py-0.5 text-xs text-emerald-300 hover:bg-emerald-500/10">
                Start
              </button>
            </form>
          )
        ) : null}
        <Link href="/settings/credentials" className="ml-auto text-xs text-[#6f7782] hover:text-[#c3c8d0]">
          Credentials
        </Link>
        {role === 'owner' ? (
          <form action={deleteWorkspaceAction}>
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <button className="rounded border border-rose-500/30 px-2 py-0.5 text-xs text-rose-300 hover:bg-rose-500/10">Delete workspace</button>
          </form>
        ) : null}
      </TopBar>
      {error ? <p className="border-b border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">{error}</p> : null}
      <WorkspaceView
        workspaceId={workspace.id}
        slug={workspace.slug}
        role={role}
        running={status === 'running'}
        members={members}
        events={events.map((e) => ({ id: e.id, type: e.type, actorKind: e.actorKind, createdAt: e.createdAt.toISOString(), payload: e.payload as Record<string, unknown> }))}
        currentUserId={session.user.id}
        returnTo={returnTo}
        tasks={{
          workspaceId: workspace.id,
          role,
          returnTo,
          tasks,
          runtimes: runtimeOptions(),
          models: modelOptions(),
          credentials: credentials.map((c) => ({ id: c.id, provider: c.provider, label: c.label, masked: c.masked })),
          policy: { ...DEFAULT_COORDINATION_POLICY, ...(workspace.coordinationPolicy ?? {}) },
          credentialsConfigured: !!rawKey,
        }}
      />
    </div>
  );
}
