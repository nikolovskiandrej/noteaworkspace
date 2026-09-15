import type { WorkspaceRuntimeStatus } from '@notea/protocol';

const STYLES: Record<WorkspaceRuntimeStatus | 'deleted', string> = {
  running: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  starting: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  creating: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  stopping: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  stopped: 'bg-[#2a2f38] text-[#aab1bb] border-[#3a404a]',
  error: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  unknown: 'bg-[#2a2f38] text-[#aab1bb] border-[#3a404a]',
  deleted: 'bg-[#2a2f38] text-[#aab1bb] border-[#3a404a]',
};

export function StatusBadge({ status }: { status: string }) {
  const style = STYLES[status as WorkspaceRuntimeStatus] ?? STYLES.unknown;
  return <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${style}`}>{status}</span>;
}
