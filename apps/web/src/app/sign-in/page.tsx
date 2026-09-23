import { redirect } from 'next/navigation';
import { currentUserId } from '@/auth';
import { Wordmark } from '@/components/wordmark';
import { Notice } from '@/components/ui/notice';
import { SubmitButton } from '@/components/ui/submit-button';
import { signInAction } from '@/lib/actions';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  if (await currentUserId()) redirect('/');
  const { error, callbackUrl } = await searchParams;
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="page-enter w-full max-w-[22.5rem]">
        <div className="mb-7 flex justify-center">
          <Wordmark />
        </div>
        <div className="rounded-xl border border-line bg-panel p-6 shadow-[0_24px_64px_-32px_rgb(0_0_0/0.9)] sm:p-7">
          <h1 className="text-[20px] font-semibold tracking-[-0.015em] text-fg">Sign in</h1>
          <p className="mt-1 text-[13px] text-fg-muted">Use the account your administrator created for you.</p>
          {error ? (
            <Notice tone="danger" className="mt-5">
              {error === 'rate_limited' ? 'Too many failed attempts. Try again in 15 minutes.' : 'The email or password is incorrect.'}
            </Notice>
          ) : null}
          <form action={signInAction} className="mt-6 space-y-4">
            <input type="hidden" name="callbackUrl" value={callbackUrl ?? '/'} />
            <div>
              <label htmlFor="email" className="field-label">
                Email
              </label>
              <input id="email" name="email" type="email" required autoComplete="email" className="input h-10" />
            </div>
            <div>
              <label htmlFor="password" className="field-label">
                Password
              </label>
              <input id="password" name="password" type="password" required autoComplete="current-password" className="input h-10" />
            </div>
            <SubmitButton className="btn-primary mt-2 h-10 w-full" pendingLabel="Signing in…">
              Sign in
            </SubmitButton>
          </form>
        </div>
        <p className="mt-6 text-center text-xs leading-relaxed text-fg-subtle">
          No account yet? An administrator creates one with <code className="kbd">npm run create-user -w @notea/web</code>
        </p>
      </div>
    </main>
  );
}
