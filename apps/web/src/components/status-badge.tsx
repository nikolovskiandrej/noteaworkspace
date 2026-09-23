import { cx } from './ui/cx';

type Tone = 'live' | 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'muted';

interface StatusStyle {
  label: string;
  tone: Tone;
  /** Something is in progress right now; the dot breathes. */
  pulse?: boolean;
  /** Waiting, or at rest: an outlined dot. */
  hollow?: boolean;
}

const WORKSPACE: Record<string, StatusStyle> = {
  running: { label: 'Running', tone: 'live' },
  starting: { label: 'Starting', tone: 'warn', pulse: true },
  creating: { label: 'Creating', tone: 'warn', pulse: true },
  stopping: { label: 'Stopping', tone: 'warn', pulse: true },
  stopped: { label: 'Stopped', tone: 'neutral', hollow: true },
  error: { label: 'Error', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'muted', hollow: true },
  deleted: { label: 'Deleted', tone: 'muted' },
};

const TASK: Record<string, StatusStyle> = {
  draft: { label: 'Draft', tone: 'muted', hollow: true },
  queued: { label: 'Queued', tone: 'neutral', hollow: true },
  running: { label: 'Running', tone: 'live', pulse: true },
  needs_review: { label: 'Needs review', tone: 'warn' },
  approved: { label: 'Approved', tone: 'info', hollow: true },
  integrating: { label: 'Integrating', tone: 'info', pulse: true },
  needs_rebase: { label: 'Needs rebase', tone: 'danger' },
  checks_failed: { label: 'Checks failed', tone: 'danger' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

function styleFor(kind: 'workspace' | 'task', status: string): StatusStyle {
  const table = kind === 'task' ? TASK : WORKSPACE;
  return table[status] ?? { label: status.replace(/_/g, ' '), tone: 'muted' };
}

/** A workspace's or a task's state: a dot and a word, in the state's own colour. */
export function StatusBadge({ status, kind = 'workspace', className }: { status: string; kind?: 'workspace' | 'task'; className?: string }) {
  const style = styleFor(kind, status);
  return (
    <span className={cx('status', `tone-${style.tone}`, className)}>
      <span className="status-dot" data-pulse={style.pulse ? '' : undefined} data-hollow={style.hollow ? '' : undefined} aria-hidden />
      {style.label}
    </span>
  );
}
