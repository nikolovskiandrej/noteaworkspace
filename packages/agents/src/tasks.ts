import type { TaskStatus } from './types';

/** Allowed status transitions. Anything not listed is rejected. */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['running', 'cancelled', 'draft'],
  running: ['needs_review', 'failed', 'cancelled'],
  needs_review: ['approved', 'queued', 'cancelled'],
  approved: ['integrating', 'cancelled'],
  integrating: ['done', 'needs_rebase', 'checks_failed', 'failed'],
  needs_rebase: ['queued', 'cancelled'],
  checks_failed: ['queued', 'approved', 'cancelled'],
  done: [],
  failed: ['queued', 'cancelled'],
  cancelled: ['queued'],
};

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['done'];
export const ACTIVE_TASK_STATUSES: TaskStatus[] = ['queued', 'running', 'integrating'];

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`cannot move task from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

// ---------------------------------------------------------------------------
// Scopes and leases
// ---------------------------------------------------------------------------

/** Converts a glob (`*`, `**`, `?`) to a RegExp over forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (ch === '?') pattern += '[^/]';
    else pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Two scopes overlap when any pattern of one could match a path the other names.
 * Patterns are compared conservatively: a literal path overlaps a glob when the glob
 * matches it or when either is a prefix directory of the other; two globs overlap
 * when their literal prefixes share a common ancestor.
 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return a.some((x) => b.some((y) => patternsOverlap(x, y)));
}

function patternsOverlap(x: string, y: string): boolean {
  const gx = /[*?]/.test(x);
  const gy = /[*?]/.test(y);
  if (!gx && !gy) return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  if (gx && !gy) return globToRegExp(x).test(y) || y.startsWith(`${literalPrefix(x)}`) || literalPrefix(x).startsWith(`${y}/`);
  if (!gx && gy) return patternsOverlap(y, x);
  const px = literalPrefix(x);
  const py = literalPrefix(y);
  return px.startsWith(py) || py.startsWith(px);
}

function literalPrefix(glob: string): string {
  const index = glob.search(/[*?]/);
  const prefix = index === -1 ? glob : glob.slice(0, index);
  return prefix;
}

/** Paths that count as environment-level changes and overlap with every task. */
export const GLOBAL_SCOPE_PATHS = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

export function effectiveScope(scope: string[]): string[] {
  return scope.length === 0 ? ['**'] : scope;
}
