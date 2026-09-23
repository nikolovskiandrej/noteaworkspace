import { KeyRound, Plug, ShieldCheck, Unplug } from 'lucide-react';
import { redirect } from 'next/navigation';
import { AUTH_MODES, PROVIDERS } from '@notea/agents';
import { auth } from '@/auth';
import { Crumb, TopBar } from '@/components/top-bar';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { SubmitButton } from '@/components/ui/submit-button';
import { addCredentialAction, checkCredentialAction, deleteCredentialAction } from '@/lib/actions';
import { connectionsFor, listCredentials } from '@/lib/credentials';
import { getDb } from '@/lib/db';
import { env } from '@/lib/env';
import { getOrchestrator } from '@/lib/orchestrator';
import { listWorkspacesForUser } from '@/lib/workspaces';

const PAGE = '/settings/ai';

/**
 * Password managers treat any form with a password field as a sign-in form and fill in
 * the Notea login. These attributes ask Chrome and the common extensions to leave the
 * token field alone.
 */
const NOT_A_LOGIN = { 'data-1p-ignore': true, 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' } as const;

/** The provider help texts mark commands with backticks; show those as code. */
function withCode(text: string) {
  return text.split('`').map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="kbd">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

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
  const authModeIds = [...new Set(Object.values(AUTH_MODES).flat().map((m) => m.id))];

  return (
    <div className="flex min-h-full flex-col">
      <TopBar userName={session.user.name ?? 'you'} userEmail={session.user.email}>
        <Crumb href="/">Workspaces</Crumb>
        <Crumb>AI &amp; Claude</Crumb>
      </TopBar>

      <main className="page-enter mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <header>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-fg">Your AI connections</h1>
          <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-fg-muted">
            These belong to <span className="text-fg">{session.user.email ?? session.user.name}</span> and to nobody else. Agent tasks you create run as your
            own Unix user inside the workspace container and are the only processes that ever receive them. Another member&apos;s shell, and another
            member&apos;s agent, cannot read them.
          </p>
          <p className="mt-3 max-w-2xl rounded-lg border border-line bg-panel px-3.5 py-2.5 text-[13px] leading-relaxed text-fg-muted">
            <span className="font-medium text-fg">Your Claude in a workspace needs none of this.</span> The first time it starts, it asks you to sign in with
            your own Claude account, right in its terminal, and keeps that sign-in private to you. The connections below are only for agent tasks.
          </p>
        </header>

        <div className="mt-6 space-y-3 empty:hidden">
          {error ? (
            <Notice tone="danger" dismissHref={PAGE}>
              {error}
            </Notice>
          ) : null}
          {checked ? (
            <Notice tone={ok === '1' ? 'success' : 'warn'} dismissHref={PAGE}>
              {checked}
            </Notice>
          ) : null}
          {!key ? (
            <Notice tone="warn">
              CREDENTIALS_KEY is not configured on the web app, so connections cannot be stored. Generate one with{' '}
              <code className="kbd">openssl rand -hex 32</code> and set the same value for the web app and the worker.
            </Notice>
          ) : null}
        </div>

        <div className="mt-8 space-y-4">
          {connections.map((connection) => (
            <section key={connection.provider} aria-labelledby={`provider-${connection.provider}`} className="overflow-hidden rounded-lg border border-line bg-panel">
              <header className="flex items-center gap-3 px-4 py-3">
                <h2 id={`provider-${connection.provider}`} className="text-[14px] font-semibold text-fg">
                  {connection.providerName}
                </h2>
                <span className={connection.connected ? 'status tone-live' : 'status tone-muted'}>
                  <span className="status-dot" data-hollow={connection.connected ? undefined : ''} aria-hidden />
                  {connection.connected ? 'Connected' : 'Not connected'}
                </span>
              </header>

              {connection.mixed ? (
                <p className="mx-4 mb-3 rounded-md border border-warn/25 bg-warn/[0.06] px-3 py-2 text-xs leading-relaxed text-[#ecd3a1]">
                  You have both a subscription and an API connection here. Each task uses exactly one: whichever you pick when you create it.
                </p>
              ) : null}

              <ul className="divide-y divide-line border-y border-line">
                {connection.credentials.length === 0 ? <li className="px-4 py-3 text-[13px] text-fg-subtle">Nothing connected yet.</li> : null}
                {connection.credentials.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
                    <div className="min-w-48 flex-1">
                      <p className="text-[13px] font-medium text-fg">{c.label}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
                        <span className="text-fg-muted">{c.authLabel}</span>
                        <span className={c.apiBilled ? 'text-warn' : 'text-accent'}>{c.apiBilled ? 'Pay-as-you-go API billing' : 'No API charges'}</span>
                        <span className="font-mono" title={`Injected as ${c.env}`}>
                          {c.masked}
                        </span>
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {runnable.length > 0 ? (
                        <form action={checkCredentialAction} className="flex items-center gap-1.5">
                          <input type="hidden" name="credentialId" value={c.id} />
                          <select name="workspaceId" aria-label="Workspace to check in" className="input input-sm w-auto max-w-44">
                            {runnable.map((w) => (
                              <option key={w.workspace.id} value={w.workspace.id}>
                                {w.workspace.name}
                              </option>
                            ))}
                          </select>
                          <SubmitButton className="btn-secondary btn-sm" icon={<ShieldCheck aria-hidden />} pendingLabel="Checking…" title="Ask the CLI, as your own uid in a real container, how it authenticates">
                            Check
                          </SubmitButton>
                        </form>
                      ) : null}
                      <form action={deleteCredentialAction}>
                        <input type="hidden" name="credentialId" value={c.id} />
                        <SubmitButton className="btn-danger btn-sm" icon={<Unplug aria-hidden />} pendingLabel="Disconnecting…">
                          Disconnect
                        </SubmitButton>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="space-y-1.5 bg-canvas/40 px-4 py-3 text-xs leading-relaxed text-fg-subtle">
                {AUTH_MODES[connection.provider].map((mode) => (
                  <p key={mode.id}>
                    <span className="font-medium text-fg-muted">{mode.label}:</span> {withCode(mode.obtain)}{' '}
                    <span className="text-fg-faint">({mode.billing})</span>
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <form action={addCredentialAction} autoComplete="off" className="mt-8 rounded-lg border border-line bg-panel p-4 sm:p-5">
          <div className="flex items-center gap-2.5">
            <KeyRound className="size-4 text-fg-subtle" aria-hidden />
            <h2 className="text-[14px] font-semibold text-fg">Connect an account</h2>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Provider" htmlFor="credential-provider">
              <select id="credential-provider" name="provider" className="input">
                {Object.values(PROVIDERS).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Authentication" htmlFor="credential-mode">
              <select id="credential-mode" name="authMode" className="input">
                {authModeIds.map((modeId) => {
                  const mode = Object.values(AUTH_MODES).flat().find((m) => m.id === modeId)!;
                  return (
                    <option key={modeId} value={modeId}>
                      {mode.label.replace(/^Claude /, '').replace(/^Anthropic /, '')} ({modeId === 'subscription' ? 'no API charges' : 'API billing'})
                    </option>
                  );
                })}
              </select>
            </Field>
            <Field label="Label" htmlFor="credential-label">
              <input id="credential-label" name="label" required maxLength={80} placeholder="My Claude account" autoComplete="off" {...NOT_A_LOGIN} className="input" />
            </Field>
            <Field label="Token or key" htmlFor="credential-secret">
              <input
                id="credential-secret"
                name="secret"
                type="password"
                required
                autoComplete="new-password"
                spellCheck={false}
                {...NOT_A_LOGIN}
                className="input font-mono"
              />
            </Field>
          </div>
          <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
            <p className="max-w-md text-xs leading-relaxed text-fg-subtle">
              Stored encrypted (AES-256-GCM) and never shown again. Notea sets exactly one credential variable per run and clears the others, so a subscription
              connection cannot quietly fall back to metered API usage.
            </p>
            <SubmitButton disabled={!key} className="btn-primary" icon={<Plug aria-hidden />} pendingLabel="Connecting…">
              Connect
            </SubmitButton>
          </div>
        </form>
      </main>
    </div>
  );
}
