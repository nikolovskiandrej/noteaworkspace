import { ArrowLeft, SearchX } from 'lucide-react';
import Link from 'next/link';

export default function WorkspaceNotFound() {
  return (
    <main className="flex min-h-full items-center justify-center px-6 py-12">
      <div className="page-enter max-w-sm text-center">
        <span className="mx-auto grid size-11 place-items-center rounded-full border border-line-strong bg-raised text-fg-subtle">
          <SearchX className="size-[18px]" aria-hidden />
        </span>
        <h1 className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-fg">Workspace not found</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">It does not exist, or you are not a member. The owner can add you from its People tab.</p>
        <Link href="/" className="btn btn-secondary mt-5">
          <ArrowLeft aria-hidden />
          Back to workspaces
        </Link>
      </div>
    </main>
  );
}
