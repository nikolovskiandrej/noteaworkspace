import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { StatusBadge } from '@/components/status-badge';
import { TopBar } from '@/components/top-bar';
import { createWorkspaceAction, startWorkspaceAction, stopWorkspaceAction } from '@/lib/actions';
import { getDb } from '@/lib/db';
import { getOrchestrator } from '@/lib/orchestrator';
import { listWorkspacesForUser } from '@/lib/workspaces';

export default async function HomePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  const { error } = await searchParams;
  const items = await listWorkspacesForUser({ db: getDb(), orchestrator: getOrchestrator() }, session.user.id);

  return (
    <div className="flex h-full flex-col">
      <TopBar userName={session.user.name ?? session.user.email ?? 'you'} />
      <main className="mx-auto w-full max-w-4xl flex-1 space-y-8 p-6">
        {error ? (
          <p className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>
        ) : null}

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#9aa1ab]">Workspaces</h2>
          {items.length === 0 ? (
            <p className="rounded border border-dashed border-[#2b313b] p-6 text-sm text-[#6f7782]">
              No workspaces yet. Create one below; it starts a persistent Linux environment you can reach from any browser.
            </p>
          ) : (
            <ul className="divide-y divide-[#232830] rounded-lg border border-[#232830] bg-[#14171c]">
              {items.map(({ workspace, role, status }) => (
                <li key={workspace.id} className="flex items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/workspaces/${workspace.slug}`} className="font-medium text-[#e6e9ee] hover:text-emerald-300">
                      {workspace.name}
                    </Link>
                    <div className="mono text-xs text-[#6f7782]">
                      {workspace.slug} · {role}
                    </div>
                  </div>
                  <StatusBadge status={status} />
                  {role !== 'viewer' ? (
                    status === 'running' ? (
                      <form action={stopWorkspaceAction}>
                        <input type="hidden" name="workspaceId" value={workspace.id} />
                        <button className="rounded border border-[#2b313b] px-2 py-1 text-xs hover:bg-[#1c2027]">Stop</button>
                      </form>
                    ) : (
                      <form action={startWorkspaceAction}>
                        <input type="hidden" name="workspaceId" value={workspace.id} />
                        <button className="rounded border border-emerald-500/40 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10">
                          Start
                        </button>
                      </form>
                    )
                  ) : null}
                  <Link
                    href={`/workspaces/${workspace.slug}`}
                    className="rounded bg-emerald-500 px-3 py-1 text-xs font-medium text-black hover:bg-emerald-400"
                  >
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#9aa1ab]">New workspace</h2>
          <form action={createWorkspaceAction} className="flex flex-wrap items-end gap-3 rounded-lg border border-[#232830] bg-[#14171c] p-4">
            <label className="text-sm">
              <span className="mb-1 block text-[#9aa1ab]">Name</span>
              <input
                name="name"
                required
                maxLength={80}
                placeholder="My project"
                className="w-64 rounded border border-[#2b313b] bg-[#0e1014] px-3 py-2 outline-none focus:border-emerald-500/60"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-[#9aa1ab]">Slug (optional)</span>
              <input
                name="slug"
                pattern="[a-z0-9][a-z0-9-]{1,40}"
                placeholder="my-project"
                className="mono w-48 rounded border border-[#2b313b] bg-[#0e1014] px-3 py-2 outline-none focus:border-emerald-500/60"
              />
            </label>
            <button type="submit" className="rounded bg-emerald-500 px-3 py-2 text-sm font-medium text-black hover:bg-emerald-400">
              Create workspace
            </button>
            <p className="basis-full text-xs text-[#6f7782]">Creation starts the container and waits for its agent; it usually takes a few seconds.</p>
          </form>
        </section>
      </main>
    </div>
  );
}
