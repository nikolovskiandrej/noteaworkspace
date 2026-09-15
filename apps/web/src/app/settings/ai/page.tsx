import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AUTH_MODES, PROVIDERS } from '@notea/agents';
import { auth } from '@/auth';
import { TopBar } from '@/components/top-bar';
import { addCredentialAction, checkCredentialAction, deleteCredentialAction } from '@/lib/actions';
import { connectionsFor, listCredentials } from '@/lib/credentials';
import { getDb } from '@/lib/db';
import { env } from '@/lib/env';
import { getOrchestrator } from '@/lib/orchestrator';
import { listWorkspacesForUser } from '@/lib/workspaces';

const CARD = 'rounded-lg border border-[#232830] bg-[#14171c]';
const INPUT = 'rounded border border-[#2b313b] bg-[#0e1014] px-3 py-2';

export default async function AiSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; checked?: string; ok?: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  const { error, checked, ok } = await searchParams;
  const rawKey = env().CREDENTIALS_KEY;
  const key = rawKey ? Buffer.from(rawKey, 'hex') : null;
  const db = getDb();
  const credentials = await listCredentials(db, session.user.id, key);
  const connections = connectionsFor(credentials);
  const workspaces = await listWorkspacesForUser({ db, orchestrator: getOrchestrator() }, session.user.id);
  const runnable = workspaces.filter((w) => w.status === 'running' && w.role !== 'viewer');

  return (
    <div className="flex h-full flex-col">
      <TopBar userName={session.user.name ?? 'you'}>
        <Link href="/" className="text-[#6f7782] hover:text-[#c3c8d0]">
          Workspaces
        </Link>
        <span className="text-[#3a404a]">/</span>
        <span className="font-medium text-[#e6e9ee]">AI &amp; Claude</span>
      </TopBar>

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 overflow-y-auto p-6 text-sm">
        {error ? <p className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">{error}</p> : null}
        {checked ? (
          <p className={`rounded border px-3 py-2 ${ok === '1' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
            {checked}
          </p>
        ) : null}

        <section className="space-y-1">
          <h1 className="text-base font-medium text-[#e6e9ee]">Your AI connections</h1>
          <p className="text-[#9aa1ab]">
            These belong to <span className="text-[#e6e9ee]">{session.user.email ?? session.user.name}</span> and to nobody else. Agent tasks you
            create run as your own Unix user inside the workspace container and are the only processes that ever receive them — another member&apos;s
            shell, and another member&apos;s agent, cannot read them.
          </p>
        </section>

        {!key ? (
          <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-300">
            CREDENTIALS_KEY is not configured on the web app, so connections cannot be stored. Generate one with{' '}
            <code className="mono">openssl rand -hex 32</code> and set the same value for the web app and the worker.
          </p>
        ) : null}

        {connections.map((connection) => (
          <section key={connection.provider} className={`${CARD} p-4`}>
            <header className="flex items-center gap-2">
              <h2 className="text-[#e6e9ee]">{connection.providerName}</h2>
              <span className={connection.connected ? 'text-emerald-400' : 'text-[#6f7782]'}>
                {connection.connected ? '● Connected' : '○ Not connected'}
              </span>
            </header>

            {connection.mixed ? (
              <p className="mt-2 text-xs text-amber-300">
                You have both a subscription and an API connection here. Each task uses exactly one — whichever you pick when you create it.
              </p>
            ) : null}

            <ul className="mt-3 divide-y divide-[#232830] border-y border-[#232830]">
              {connection.credentials.length === 0 ? (
                <li className="py-3 text-[#6f7782]">Nothing connected yet.</li>
              ) : null}
              {connection.credentials.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                  <span className="min-w-40 flex-1 text-[#e6e9ee]">{c.label}</span>
                  <span className="text-[#9aa1ab]">
                    Authentication: <span className="text-[#e6e9ee]">{c.authLabel}</span>
                  </span>
                  <span className={c.apiBilled ? 'text-amber-300' : 'text-emerald-300'}>
                    {c.apiBilled ? 'API billing: pay-as-you-go' : 'API billing: not used'}
                  </span>
                  <span className="mono text-xs text-[#6f7782]" title={`injected as ${c.env}`}>
                    {c.masked}
                  </span>
                  {runnable.length > 0 ? (
                    <form action={checkCredentialAction} className="flex items-center gap-1">
                      <input type="hidden" name="credentialId" value={c.id} />
                      <select name="workspaceId" className="rounded border border-[#2b313b] bg-[#0e1014] px-2 py-0.5 text-xs">
                        {runnable.map((w) => (
                          <option key={w.workspace.id} value={w.workspace.id}>
                            {w.workspace.name}
                          </option>
                        ))}
                      </select>
                      <button className="rounded border border-[#2b313b] px-2 py-0.5 text-xs text-[#c3c8d0] hover:bg-[#1c2027]">Check</button>
                    </form>
                  ) : null}
                  <form action={deleteCredentialAction}>
                    <input type="hidden" name="credentialId" value={c.id} />
                    <button className="rounded border border-rose-500/30 px-2 py-0.5 text-xs text-rose-300 hover:bg-rose-500/10">Disconnect</button>
                  </form>
                </li>
              ))}
            </ul>

            <div className="mt-3 space-y-1 text-xs text-[#6f7782]">
              {AUTH_MODES[connection.provider].map((mode) => (
                <p key={mode.id}>
                  <span className="text-[#9aa1ab]">{mode.label}:</span> {mode.obtain} <span className="text-[#4e555f]">({mode.billing})</span>
                </p>
              ))}
            </div>
          </section>
        ))}

        <form action={addCredentialAction} className={`${CARD} flex flex-wrap items-end gap-3 p-4`}>
          <h2 className="w-full text-[#e6e9ee]">Connect an account</h2>
          <label>
            <span className="mb-1 block text-[#9aa1ab]">Provider</span>
            <select name="provider" className={INPUT}>
              {Object.values(PROVIDERS).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[#9aa1ab]">Authentication</span>
            <select name="authMode" className={INPUT}>
              {[...new Set(Object.values(AUTH_MODES).flat().map((m) => m.id))].map((id) => {
                const mode = Object.values(AUTH_MODES).flat().find((m) => m.id === id)!;
                return (
                  <option key={id} value={id}>
                    {mode.label.replace(/^Claude /, '').replace(/^Anthropic /, '')} — {id === 'subscription' ? 'no API charges' : 'API billing'}
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[#9aa1ab]">Label</span>
            <input name="label" required maxLength={80} placeholder="my Claude account" className={INPUT} />
          </label>
          <label className="flex-1">
            <span className="mb-1 block text-[#9aa1ab]">Token or key</span>
            <input name="secret" type="password" required autoComplete="off" className={`mono w-full ${INPUT}`} />
          </label>
          <button disabled={!key} className="rounded bg-emerald-500 px-3 py-2 font-medium text-black hover:bg-emerald-400 disabled:opacity-40">
            Connect
          </button>
          <p className="w-full text-xs text-[#6f7782]">
            Stored encrypted (AES-256-GCM) and never shown again. Notea sets exactly one credential variable per run and clears the others, so a
            subscription connection cannot quietly fall back to metered API usage.
          </p>
        </form>
      </main>
    </div>
  );
}
