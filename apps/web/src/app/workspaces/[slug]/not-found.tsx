import Link from 'next/link';

export default function WorkspaceNotFound() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-sm">
      <p className="text-[#c3c8d0]">This workspace does not exist or you are not a member.</p>
      <Link href="/" className="text-emerald-300 hover:underline">
        Back to workspaces
      </Link>
    </main>
  );
}
