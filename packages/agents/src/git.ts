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

const TASK_BRANCH_PREFIX = 'notea/task/';

/**
 * Task ids are database UUIDs. Cleanup derives ids from branch names and directory
 * names it finds in the container, so anything that does not look like one is left
 * alone: it is not ours.
 */
export const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function taskBranch(taskId: string): string {
  return `${TASK_BRANCH_PREFIX}${taskId}`;
}

export function taskWorktreePath(paths: GitPaths, taskId: string): string {
  return `${paths.worktreesDir}/${taskId}`;
}

/** The task id a task branch name encodes, or null for any other branch. */
export function taskIdOfBranch(branch: string): string | null {
  if (!branch.startsWith(TASK_BRANCH_PREFIX)) return null;
  const taskId = branch.slice(TASK_BRANCH_PREFIX.length);
  return TASK_ID_PATTERN.test(taskId) ? taskId : null;
}

/** The task id a worktree path encodes, or null when the path is not a task worktree. */
export function taskIdOfWorktreePath(paths: GitPaths, worktreePath: string): string | null {
  const prefix = `${paths.worktreesDir}/`;
  if (!worktreePath.startsWith(prefix)) return null;
  const taskId = worktreePath.slice(prefix.length);
  return TASK_ID_PATTERN.test(taskId) ? taskId : null;
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** Full ref name (`refs/heads/…`), or null when detached or bare. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Parses the output of `git worktree list --porcelain`. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    if (!line) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = { path: value, head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  if (current) entries.push(current);
  return entries;
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

  /**
   * Removes a task worktree, including a directory git no longer registers (a
   * removal that failed halfway). The branch is left alone; delete it explicitly
   * with {@link deleteBranch} after checking {@link isMergedInto}.
   */
  async removeTaskWorktree(taskId: string): Promise<void> {
    // The path is built from the task id and deleted recursively below, so the id
    // must be a plain name: no separators, no traversal, nothing hidden.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) throw new Error(`refusing to remove a worktree for task id ${JSON.stringify(taskId)}`);
    const path = taskWorktreePath(this.paths, taskId);
    await this.runner.run(`git worktree remove --force ${shellQuote(path)}`, { cwd: this.paths.projectDir });
    await this.runner.run(`if [ -e ${shellQuote(path)} ]; then rm -rf ${shellQuote(path)}; fi`, { cwd: this.paths.projectDir });
    await this.runner.run('git worktree prune', { cwd: this.paths.projectDir });
  }

  /** Every worktree git knows about, the main tree included. */
  async listWorktrees(): Promise<WorktreeEntry[]> {
    const result = await runOrThrow(this.runner, 'git worktree list --porcelain', { cwd: this.paths.projectDir });
    return parseWorktreeList(result.stdout);
  }

  /** Local branches in the task namespace (`notea/task/*`), short names. */
  async listTaskBranches(): Promise<string[]> {
    const result = await runOrThrow(this.runner, `git for-each-ref --format='%(refname:short)' ${shellQuote(`refs/heads/${TASK_BRANCH_PREFIX}`)}`, {
      cwd: this.paths.projectDir,
    });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Names of the entries directly inside a directory; a missing directory has none. */
  async listDirectory(dir: string): Promise<string[]> {
    const result = await runOrThrow(this.runner, `if [ -d ${shellQuote(dir)} ]; then ls -1A ${shellQuote(dir)}; fi`, { cwd: this.paths.projectDir });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async listWorktreeDirectories(): Promise<string[]> {
    return this.listDirectory(this.paths.worktreesDir);
  }

  /** True when `commitish` is reachable from `base`, i.e. already merged into it. */
  async isMergedInto(commitish: string, base: string): Promise<boolean> {
    const result = await this.runner.run(`git merge-base --is-ancestor ${shellQuote(commitish)} ${shellQuote(base)}`, { cwd: this.paths.projectDir });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`cannot compare ${commitish} with ${base}: ${(result.stderr || result.stdout).trim()}`);
  }

  /** Deletes a local branch. `force` skips git's own merged check; verify with {@link isMergedInto} first. */
  async deleteBranch(branch: string, options: { force: boolean }): Promise<void> {
    await runOrThrow(this.runner, `git branch ${options.force ? '-D' : '-d'} ${shellQuote(branch)}`, { cwd: this.paths.projectDir });
  }

  /**
   * Points `refs/notea/archive/<taskId>` at the task branch tip so the commits stay
   * reachable after the branch is deleted. Returns the archive ref.
   */
  async archiveTaskBranch(taskId: string): Promise<string> {
    const ref = `refs/notea/archive/${taskId}`;
    await runOrThrow(this.runner, `git update-ref ${shellQuote(ref)} ${shellQuote(`refs/heads/${taskBranch(taskId)}`)}`, { cwd: this.paths.projectDir });
    return ref;
  }

  /**
   * True when a process this runner may inspect has its working directory inside
   * `dir` — in practice a shell someone opened there, since human terminals and the
   * runner's own commands run as `dev`. Agent processes run under their members'
   * own uids (D-039), and the kernel refuses other uids their `/proc/<pid>/cwd`, the
   * same protection that hides their credentials, so a live agent run is invisible
   * here: callers must also skip workspaces with active tasks, as the reaper does.
   */
  async isDirectoryInUse(dir: string): Promise<boolean> {
    const script = `for p in /proc/[0-9]*; do readlink "$p/cwd" 2>/dev/null; done | awk -v p=${shellQuote(dir)} '$0 == p || index($0, p "/") == 1 { n++ } END { print n + 0 }'`;
    const result = await runOrThrow(this.runner, script, { cwd: this.paths.projectDir });
    return (Number(result.stdout.trim()) || 0) > 0;
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
