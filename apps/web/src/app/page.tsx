import { Play, Square } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { WorkspacesHeader } from '@/components/create-workspace';
import { LinkPendingChevron } from '@/components/link-pending';
import { StatusBadge } from '@/components/status-badge';
import { TopBar } from '@/components/top-bar';
import { Notice } from '@/components/ui/notice';
import { SubmitButton } from '@/components/ui/submit-button';
import { startWorkspaceAction, stopWorkspaceAction } from '@/lib/actions';
import { getDb } from '@/lib/db';
import { getOrchestrator } from '@/lib/orchestrator';
import { listWorkspacesForUser } from '@/lib/workspaces';

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' } as const;

export default async function HomePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  const { error } = await searchParams;
  const items = await listWorkspacesForUser({ db: getDb(), orchestrator: getOrchestrator() }, session.user.id);

  return (
    <div className="flex min-h-full flex-col">
      <TopBar userName={session.user.name ?? session.user.email ?? 'you'} userEmail={session.user.email} />
      <main className="page-enter mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <WorkspacesHeader defaultOpen={items.length === 0}>
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-fg">Workspaces</h1>
            <p className="mt-1 text-[13.5px] text-fg-muted">Persistent Linux environments you share with people and agents.</p>
          </div>
        </WorkspacesHeader>

        {error ? (
          <Notice tone="danger" dismissHref="/" className="mt-6">
            {error}
          </Notice>
        ) : null}

        {items.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
            <p className="text-[14px] font-medium text-fg">No workspaces yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-fg-muted">
              Each workspace is one project in a container of its own, with a Claude for each member, side by side. Name one above to create it.
            </p>
          </div>
        ) : (
          <ul className="mt-6 divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
            {items.map(({ workspace, role, status }) => (
              <li key={workspace.id} className="group relative flex items-center gap-3 py-3.5 pl-4 pr-11 transition-colors duration-150 hover:bg-raised">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {/* The name's link covers the row, so the whole row opens the workspace. */}
                    <Link
                      href={`/workspaces/${workspace.slug}`}
                      className="truncate text-[14px] font-medium text-fg after:absolute after:inset-0 after:content-['']"
                    >
                      {workspace.name}
                      <span className="absolute right-4 top-1/2 -translate-y-1/2">
                        <LinkPendingChevron />
                      </span>
                    </Link>
                    <StatusBadge status={status} />
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-fg-subtle">
                    <span className="truncate font-mono">{workspace.slug}</span>
                    <span className="flex-none">{ROLE_LABEL[role]}</span>
                  </div>
                </div>
                <div className="relative z-10 flex flex-none items-center gap-2">
                  {role !== 'viewer' ? (
                    status === 'running' ? (
                      <form action={stopWorkspaceAction}>
                        <input type="hidden" name="workspaceId" value={workspace.id} />
                        <SubmitButton className="btn-ghost btn-sm" icon={<Square aria-hidden />} pendingLabel="Stopping…">
                          Stop
                        </SubmitButton>
                      </form>
                    ) : (
                      <form action={startWorkspaceAction}>
                        <input type="hidden" name="workspaceId" value={workspace.id} />
                        <SubmitButton className="btn-secondary btn-sm" icon={<Play aria-hidden />} pendingLabel="Starting…">
                          Start
                        </SubmitButton>
                      </form>
                    )
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
