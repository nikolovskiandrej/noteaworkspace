import { KeyRound, Play, Square } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { DEFAULT_COORDINATION_POLICY } from '@notea/db';
import { auth } from '@/auth';
import { AutoRefresh } from '@/components/auto-refresh';
import { StatusBadge } from '@/components/status-badge';
import { Crumb, TopBar } from '@/components/top-bar';
import { Notice } from '@/components/ui/notice';
import { SubmitButton } from '@/components/ui/submit-button';
import { WorkspaceActions } from '@/components/workspace-actions';
import { WorkspaceView } from '@/components/workspace-view';
import { startWorkspaceAction, stopWorkspaceAction } from '@/lib/actions';
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

  const { workspace, role, runtime, runtimeUnavailable, members, events } = detail;
  const status = runtime?.status ?? 'unknown';
  // An orchestrator that cannot be asked right now (a redeploy, a network blip) is not
  // a stopped workspace. Swapping in the "not running" view would unmount the editor
  // and lose its unsaved edits; the live view shows the outage and reconnects itself.
  const showLive = status === 'running' || runtimeUnavailable;
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
      <TopBar
        userName={session.user.name ?? 'you'}
        userEmail={session.user.email}
        actions={
          <>
            {role !== 'viewer' ? (
              status === 'running' ? (
                <form action={stopWorkspaceAction}>
                  <input type="hidden" name="workspaceId" value={workspace.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <SubmitButton
                    className="btn-ghost btn-sm"
                    icon={<Square aria-hidden />}
                    pendingLabel="Stopping…"
                    aria-label="Stop workspace"
                    title="Stop the container. Files and history are kept."
                  >
                    <span className="hidden sm:inline">Stop</span>
                  </SubmitButton>
                </form>
              ) : (
                <form action={startWorkspaceAction}>
                  <input type="hidden" name="workspaceId" value={workspace.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <SubmitButton className="btn-primary btn-sm" icon={<Play aria-hidden />} pendingLabel="Starting…">
                    Start
                  </SubmitButton>
                </form>
              )
            ) : null}
            <Link href="/settings/ai" className="btn btn-ghost btn-sm hidden md:inline-flex">
              <KeyRound aria-hidden />
              AI &amp; Claude
            </Link>
            {role === 'owner' ? <WorkspaceActions workspaceId={workspace.id} slug={workspace.slug} name={workspace.name} returnTo={returnTo} /> : null}
          </>
        }
      >
        <Crumb href="/">Workspaces</Crumb>
        <Crumb>{workspace.name}</Crumb>
        <StatusBadge status={status} className="ml-0.5" />
      </TopBar>
      {error ? (
        <div className="flex-none border-b border-line bg-panel px-3 py-2 sm:px-4">
          <Notice tone="danger" dismissHref={returnTo}>
            {error}
          </Notice>
        </div>
      ) : null}
      <WorkspaceView
        workspaceId={workspace.id}
        slug={workspace.slug}
        role={role}
        running={showLive}
        members={members}
        events={events.map((e) => ({
          id: e.id,
          type: e.type,
          actorKind: e.actorKind,
          actorId: e.actorId,
          createdAt: e.createdAt.toISOString(),
          payload: e.payload as Record<string, unknown>,
        }))}
        currentUserId={session.user.id}
        returnTo={returnTo}
        tasks={{
          workspaceId: workspace.id,
          role,
          returnTo,
          tasks,
          runtimes: runtimeOptions(),
          models: modelOptions(),
          credentials: credentials.map((c) => ({ id: c.id, provider: c.provider, label: c.label, masked: c.masked, authLabel: c.authLabel, apiBilled: c.apiBilled })),
          policy: { ...DEFAULT_COORDINATION_POLICY, ...(workspace.coordinationPolicy ?? {}) },
          credentialsConfigured: !!rawKey,
        }}
      />
    </div>
  );
}
