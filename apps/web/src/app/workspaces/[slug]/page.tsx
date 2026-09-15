import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { StatusBadge } from '@/components/status-badge';
import { TopBar } from '@/components/top-bar';
import { WorkspaceView } from '@/components/workspace-view';
import { deleteWorkspaceAction, startWorkspaceAction, stopWorkspaceAction } from '@/lib/actions';
import { getDb } from '@/lib/db';
import { getOrchestrator } from '@/lib/orchestrator';
import { getWorkspaceDetail } from '@/lib/workspaces';

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
  const detail = await getWorkspaceDetail({ db: getDb(), orchestrator: getOrchestrator() }, slug, session.user.id);
  if (!detail) notFound();

  const { workspace, role, runtime, members, events } = detail;
  const status = runtime?.status ?? 'unknown';
  const returnTo = `/workspaces/${workspace.slug}`;

  return (
    <div className="flex h-full flex-col">
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
        {role === 'owner' ? (
          <form action={deleteWorkspaceAction} className="ml-auto">
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <button
              className="rounded border border-rose-500/30 px-2 py-0.5 text-xs text-rose-300 hover:bg-rose-500/10"
              formAction={deleteWorkspaceAction}
            >
              Delete workspace
            </button>
          </form>
        ) : null}
      </TopBar>
      {error ? (
        <p className="border-b border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">{error}</p>
      ) : null}
      <WorkspaceView
        workspaceId={workspace.id}
        slug={workspace.slug}
        role={role}
        running={status === 'running'}
        members={members}
        events={events.map((e) => ({ id: e.id, type: e.type, actorKind: e.actorKind, createdAt: e.createdAt.toISOString(), payload: e.payload as Record<string, unknown> }))}
        currentUserId={session.user.id}
        returnTo={returnTo}
      />
    </div>
  );
}
