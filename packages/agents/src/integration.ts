import type { GitWorktrees } from './git';
import type { CommandRunner } from './types';

export interface IntegrationInput {
  taskId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  /** Shell command run in the rebased worktree before merging; null skips checks. */
  checkCommand: string | null;
  checkTimeoutMs?: number;
}

export type IntegrationResult =
  | { status: 'integrated'; log: string; commits: number }
  | { status: 'nothing_to_integrate'; log: string }
  | { status: 'conflict'; log: string }
  | { status: 'checks_failed'; log: string; exitCode: number | null }
  | { status: 'error'; log: string };

/**
 * One integration attempt: rebase the task branch onto the base branch, run the
 * checks, fast-forward the base branch. Callers must serialise calls per workspace
 * (see `PerKeyMutex`); git itself would otherwise corrupt the shared refs.
 */
export async function integrateTask(git: GitWorktrees, runner: CommandRunner, input: IntegrationInput): Promise<IntegrationResult> {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  try {
    const ahead = await git.commitsAhead(input.worktreePath, input.baseBranch);
    if (ahead === 0) {
      log('task branch has no commits beyond the base branch');
      return { status: 'nothing_to_integrate', log: lines.join('\n') };
    }
    log(`rebasing ${input.branch} onto ${input.baseBranch} (${ahead} commits)`);
    const rebase = await git.rebaseOnto(input.worktreePath, input.baseBranch);
    log(rebase.output);
    if (!rebase.ok) return { status: 'conflict', log: lines.join('\n') };

    if (input.checkCommand) {
      log(`running checks: ${input.checkCommand}`);
      const check = await runner.run(input.checkCommand, { cwd: input.worktreePath, timeoutMs: input.checkTimeoutMs ?? 15 * 60 * 1000 });
      log(check.stdout);
      if (check.stderr) log(check.stderr);
      if (check.exitCode !== 0) {
        log(`checks failed with exit code ${check.exitCode ?? 'signal ' + check.signal}${check.timedOut ? ' (timed out)' : ''}`);
        return { status: 'checks_failed', log: lines.join('\n'), exitCode: check.exitCode };
      }
    }

    log(`fast-forwarding ${input.baseBranch} to ${input.branch}`);
    await git.fastForward(input.baseBranch, input.branch);
    const commits = await git.commitsAhead(input.worktreePath, input.baseBranch);
    log('integrated');
    return { status: 'integrated', log: lines.join('\n'), commits: ahead - commits };
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return { status: 'error', log: lines.join('\n') };
  }
}

/** Serialises async work per key (workspace id) within one process. */
export class PerKeyMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** Keys with work running or queued. */
  get size(): number {
    return this.tails.size;
  }

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      // Nothing queued behind this run: forget the key.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
