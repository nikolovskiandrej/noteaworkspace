import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PROVIDERS } from '@notea/agents';
import { auth } from '@/auth';
import { TopBar } from '@/components/top-bar';
import { addCredentialAction, deleteCredentialAction } from '@/lib/actions';
import { listCredentials } from '@/lib/credentials';
import { getDb } from '@/lib/db';
import { env } from '@/lib/env';

export default async function CredentialsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  const { error } = await searchParams;
  const rawKey = env().CREDENTIALS_KEY;
  const key = rawKey ? Buffer.from(rawKey, 'hex') : null;
  const credentials = await listCredentials(getDb(), session.user.id, key);

  return (
    <div className="flex h-full flex-col">
      <TopBar userName={session.user.name ?? 'you'}>
        <Link href="/" className="text-[#6f7782] hover:text-[#c3c8d0]">
          Workspaces
        </Link>
        <span className="text-[#3a404a]">/</span>
        <span className="font-medium text-[#e6e9ee]">Provider credentials</span>
      </TopBar>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 p-6 text-sm">
        {error ? <p className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">{error}</p> : null}
        <p className="text-[#9aa1ab]">
          API keys are encrypted at rest and injected only into the agent session of a run that selects them. Alternatively, sign in to a
          CLI from a workspace terminal; that login stays on the workspace volume.
        </p>
        {!key ? (
          <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-300">
            CREDENTIALS_KEY is not configured on the web app, so keys cannot be stored. Generate one with <code className="mono">openssl rand -hex 32</code> and
            set the same value for the web app and the worker.
          </p>
        ) : null}
        <ul className="divide-y divide-[#232830] rounded-lg border border-[#232830] bg-[#14171c]">
          {credentials.length === 0 ? <li className="p-4 text-[#6f7782]">No credentials stored.</li> : null}
          {credentials.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3">
              <span className="w-24 text-[#9aa1ab]">{c.providerName}</span>
              <span className="flex-1 text-[#e6e9ee]">{c.label}</span>
              <span className="mono text-[#6f7782]">{c.masked}</span>
              <form action={deleteCredentialAction}>
                <input type="hidden" name="credentialId" value={c.id} />
                <button className="rounded border border-rose-500/30 px-2 py-0.5 text-xs text-rose-300 hover:bg-rose-500/10">Delete</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={addCredentialAction} className="flex flex-wrap items-end gap-3 rounded-lg border border-[#232830] bg-[#14171c] p-4">
          <label>
            <span className="mb-1 block text-[#9aa1ab]">Provider</span>
            <select name="provider" className="rounded border border-[#2b313b] bg-[#0e1014] px-3 py-2">
              {Object.values(PROVIDERS).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.credentialEnv})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[#9aa1ab]">Label</span>
            <input name="label" required maxLength={80} placeholder="personal key" className="rounded border border-[#2b313b] bg-[#0e1014] px-3 py-2" />
          </label>
          <label className="flex-1">
            <span className="mb-1 block text-[#9aa1ab]">Secret</span>
            <input name="secret" type="password" required autoComplete="off" className="mono w-full rounded border border-[#2b313b] bg-[#0e1014] px-3 py-2" />
          </label>
          <button disabled={!key} className="rounded bg-emerald-500 px-3 py-2 font-medium text-black hover:bg-emerald-400 disabled:opacity-40">
            Store encrypted
          </button>
        </form>
      </main>
    </div>
  );
}
