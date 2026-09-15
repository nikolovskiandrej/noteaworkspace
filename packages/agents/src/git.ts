import { runOrThrow, shellQuote } from './command-runner';
import type { CommandRunner } from './types';

export interface GitPaths {
  /** Main working tree, e.g. /home/dev/project */
  projectDir: string;
  /** Parent directory for task worktrees, e.g. /home/dev/.notea/worktrees */
  worktreesDir: string;
}

export const DEFAULT_GIT_PATHS: GitPaths = {
  projectDir: '/home/dev/project',
  worktreesDir: '/home/dev/.notea/worktrees',
};

export function taskBranch(taskId: string): string {
  return `notea/task/${taskId}`;
}

export function taskWorktreePath(paths: GitPaths, taskId: string): string {
  return `${paths.worktreesDir}/${taskId}`;
}

/**
 * Git operations for task isolation, executed inside the workspace through a
 * CommandRunner. Every method is idempotent where git allows it, so a worker can
 * retry after a crash.
 */
export class GitWorktrees {
  constructor(
    private readonly runner: CommandRunner,
    private readonly paths: GitPaths = DEFAULT_GIT_PATHS,
  ) {}

  /** Makes sure the project is a git repository with at least one commit. */
  async ensureRepository(): Promise<{ initialized: boolean; branch: string }> {
    const { projectDir } = this.paths;
    const isRepo = await this.runner.run('git rev-parse --is-inside-work-tree', { cwd: projectDir });
    let initialized = false;
    if (isRepo.exitCode !== 0) {
      await runOrThrow(this.runner, 'git init -b main', { cwd: projectDir });
      initialized = true;
    }
    const hasCommit = await this.runner.run('git rev-parse --verify HEAD', { cwd: projectDir });
    if (hasCommit.exitCode !== 0) {
      await runOrThrow(this.runner, 'git add -A && git -c user.name=Notea -c user.email=notea@local commit -q --allow-empty -m "Initial commit"', {
        cwd: projectDir,
      });
      initialized = true;
    }
    const branch = (await runOrThrow(this.runner, 'git rev-parse --abbrev-ref HEAD', { cwd: projectDir })).stdout.trim();
    return { initialized, branch };
  }

  /** Creates (or reuses) the worktree and branch for a task, based on `baseBranch`. */
  async createTaskWorktree(taskId: string, baseBranch: string): Promise<{ path: string; branch: string; reused: boolean }> {
    const path = taskWorktreePath(this.paths, taskId);
    const branch = taskBranch(taskId);
    const existing = await this.runner.run(`test -d ${shellQuote(path)}/.git || test -f ${shellQuote(path)}/.git`, { cwd: this.paths.projectDir });
    if (existing.exitCode === 0) return { path, branch, reused: true };
    await runOrThrow(this.runner, `mkdir -p ${shellQuote(this.paths.worktreesDir)}`, { cwd: this.paths.projectDir });
    const branchExists = await this.runner.run(`git rev-parse --verify ${shellQuote(branch)}`, { cwd: this.paths.projectDir });
    const command =
      branchExists.exitCode === 0
        ? `git worktree add ${shellQuote(path)} ${shellQuote(branch)}`
        : `git worktree add -b ${shellQuote(branch)} ${shellQuote(path)} ${shellQuote(baseBranch)}`;
    await runOrThrow(this.runner, command, { cwd: this.paths.projectDir });
    return { path, branch, reused: false };
  }

  async removeTaskWorktree(taskId: string, options: { deleteBranch: boolean }): Promise<void> {
    const path = taskWorktreePath(this.paths, taskId);
    await this.runner.run(`git worktree remove --force ${shellQuote(path)}`, { cwd: this.paths.projectDir });
    await this.runner.run('git worktree prune', { cwd: this.paths.projectDir });
    if (options.deleteBranch) await this.runner.run(`git branch -D ${shellQuote(taskBranch(taskId))}`, { cwd: this.paths.projectDir });
  }

  async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    const status = await runOrThrow(this.runner, 'git status --porcelain', { cwd: worktreePath });
    return status.stdout.trim().length > 0;
  }

  /** Commits everything in the worktree as the agent identity. No-op when clean. */
  async commitAll(worktreePath: string, message: string, author: { name: string; email: string }): Promise<boolean> {
    if (!(await this.hasUncommittedChanges(worktreePath))) return false;
    await runOrThrow(
      this.runner,
      `git add -A && git -c user.name=${shellQuote(author.name)} -c user.email=${shellQuote(author.email)} commit -q -m ${shellQuote(message)}`,
      { cwd: worktreePath },
    );
    return true;
  }

  /** Commits on the task branch that are not on the base branch. */
  async commitsAhead(worktreePath: string, baseBranch: string): Promise<number> {
    const result = await runOrThrow(this.runner, `git rev-list --count ${shellQuote(baseBranch)}..HEAD`, { cwd: worktreePath });
    return Number(result.stdout.trim()) || 0;
  }

  async diffStat(worktreePath: string, baseBranch: string): Promise<string> {
    const result = await runOrThrow(this.runner, `git diff --stat ${shellQuote(baseBranch)}...HEAD`, { cwd: worktreePath });
    return result.stdout.trim();
  }

  async diff(worktreePath: string, baseBranch: string, maxBytes = 200_000): Promise<string> {
    const result = await runOrThrow(this.runner, `git diff ${shellQuote(baseBranch)}...HEAD`, { cwd: worktreePath });
    return result.stdout.length > maxBytes ? `${result.stdout.slice(0, maxBytes)}\n… (truncated)` : result.stdout;
  }

  /** Rebases the task branch onto the base branch. Returns false (and aborts) on conflict. */
  async rebaseOnto(worktreePath: string, baseBranch: string): Promise<{ ok: boolean; output: string }> {
    const result = await this.runner.run(
      `git -c user.name=Notea -c user.email=notea@local rebase ${shellQuote(baseBranch)}`,
      { cwd: worktreePath },
    );
    if (result.exitCode === 0) return { ok: true, output: result.stdout };
    await this.runner.run('git rebase --abort', { cwd: worktreePath });
    return { ok: false, output: `${result.stdout}\n${result.stderr}`.trim() };
  }

  /** Fast-forwards the base branch (checked out in the main tree) to the task branch. */
  async fastForward(baseBranch: string, branch: string): Promise<void> {
    const current = (await runOrThrow(this.runner, 'git rev-parse --abbrev-ref HEAD', { cwd: this.paths.projectDir })).stdout.trim();
    if (current !== baseBranch) {
      throw new Error(`main tree is on ${current}, expected ${baseBranch}; integration requires the base branch to be checked out`);
    }
    if (await this.hasUncommittedChanges(this.paths.projectDir)) {
      throw new Error('main tree has uncommitted changes; commit or stash them before integrating');
    }
    await runOrThrow(this.runner, `git merge --ff-only ${shellQuote(branch)}`, { cwd: this.paths.projectDir });
  }
}
