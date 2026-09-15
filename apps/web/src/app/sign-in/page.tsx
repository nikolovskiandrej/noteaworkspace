import { redirect } from 'next/navigation';
import { currentUserId } from '@/auth';
import { signInAction } from '@/lib/actions';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  if (await currentUserId()) redirect('/');
  const { error, callbackUrl } = await searchParams;
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <form action={signInAction} className="w-full max-w-sm space-y-4 rounded-lg border border-[#232830] bg-[#14171c] p-6">
        <div>
          <h1 className="text-lg font-semibold text-emerald-300">Notea Workspace</h1>
          <p className="text-sm text-[#9aa1ab]">Sign in to your workspaces.</p>
        </div>
        {error ? (
          <p className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            {error === 'rate_limited' ? 'Too many failed attempts. Try again in 15 minutes.' : 'Invalid email or password.'}
          </p>
        ) : null}
        <input type="hidden" name="callbackUrl" value={callbackUrl ?? '/'} />
        <label className="block text-sm">
          <span className="mb-1 block text-[#9aa1ab]">Email</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded border border-[#2b313b] bg-[#0e1014] px-3 py-2 outline-none focus:border-emerald-500/60"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[#9aa1ab]">Password</span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="w-full rounded border border-[#2b313b] bg-[#0e1014] px-3 py-2 outline-none focus:border-emerald-500/60"
          />
        </label>
        <button type="submit" className="w-full rounded bg-emerald-500 px-3 py-2 text-sm font-medium text-black hover:bg-emerald-400">
          Sign in
        </button>
        <p className="text-xs text-[#6f7782]">Accounts are created by the administrator (`npm run create-user -w @notea/web`).</p>
      </form>
    </main>
  );
}
