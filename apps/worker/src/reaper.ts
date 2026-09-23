import { eq } from 'drizzle-orm';
import {
  DEFAULT_GIT_PATHS,
  GitWorktrees,
  TASK_ID_PATTERN,
  taskBranch,
  taskIdOfBranch,
  taskIdOfWorktreePath,
  type GitPaths,
  type TaskStatus,
} from '@notea/agents';
import { DEFAULT_COORDINATION_POLICY, agentTasks, workspaces, type CoordinationPolicy } from '@notea/db';
import type { ProcessorDeps } from './processor';
import type { ConnectWorkspace } from './workspace-connection';

/**
 * Removes task worktrees and branches that nothing references any more.
 *
 * The task pipeline leaves two kinds of debris inside the container:
 *   - a task that was *deleted* keeps its worktree directory and its branch
 *     (`deleteTask` only removes the database row; the container is out of the web
 *     app's reach), and
 *   - an *integrated* (`done`) task keeps its branch (integration removes the
 *     worktree but leaves the branch behind).
 *
 * Worktrees of tasks that can still be re-run (`failed`, `cancelled`,
 * `needs_review`, `needs_rebase`, `checks_failed`, `queued`, `draft`) are kept on
 * purpose so "Run again" continues on the same branch, and a workspace with any
 * active task (`running`, `integrating`, `approved`) is skipped whole so the reaper
 * never races a live run's or integration's git operations. Worker-side because the
 * web app has no path into the container (D-038).
 */

/** Statuses that mean the workspace is busy; skip it entirely rather than race git. */
export const ACTIVE_STATUSES: TaskStatus[] = ['running', 'integrating', 'approved'];

export interface WorktreeInput {
  taskId: string;
  /** A process has its working directory inside this worktree. */
  inUse: boolean;
}

export interface BranchInput {
  taskId: string;
  branch: string;
  mergedIntoBase: boolean;
}

export interface ReapPlan {
  removeWorktrees: Array<{ taskId: string; reason: 'deleted' | 'done' }>;
  deleteBranches: Array<{ taskId: string; branch: string; reason: 'deleted' | 'done'; force: boolean }>;
  kept: Array<{ taskId: string; reason: string }>;
}

/**
 * Decides what to remove. Pure: takes the container's current task worktrees and
 * branches plus each task's status (absent from the map = the task was deleted) and
 * returns the removals. Anything whose id is not a task UUID, or whose branch is not
 * the task's own branch, is left alone — it is not ours to touch.
 */
export function planReap(input: {
  worktrees: WorktreeInput[];
  branches: BranchInput[];
  taskStatus: Map<string, TaskStatus>;
}): ReapPlan {
  const plan: ReapPlan = { removeWorktrees: [], deleteBranches: [], kept: [] };
  const inUse = new Set(input.worktrees.filter((w) => w.inUse).map((w) => w.taskId));

  for (const wt of input.worktrees) {
    if (!TASK_ID_PATTERN.test(wt.taskId)) {
      plan.kept.push({ taskId: wt.taskId, reason: 'not a task id' });
      continue;
    }
    if (wt.inUse) {
      plan.kept.push({ taskId: wt.taskId, reason: 'a process is using the worktree' });
      continue;
    }
    const status = input.taskStatus.get(wt.taskId);
    if (status === undefined) plan.removeWorktrees.push({ taskId: wt.taskId, reason: 'deleted' });
    else if (status === 'done') plan.removeWorktrees.push({ taskId: wt.taskId, reason: 'done' });
    else plan.kept.push({ taskId: wt.taskId, reason: `task is ${status}` });
  }

  for (const br of input.branches) {
    if (!TASK_ID_PATTERN.test(br.taskId) || br.branch !== taskBranch(br.taskId)) {
      plan.kept.push({ taskId: br.taskId, reason: 'not a task branch' });
      continue;
    }
    if (inUse.has(br.taskId)) {
      plan.kept.push({ taskId: br.taskId, reason: 'a process is using the worktree' });
      continue;
    }
    const status = input.taskStatus.get(br.taskId);
    if (status === undefined) {
      // Deleted task: the user discarded it. Force-delete, but archive the tip first
      // so the commits stay recoverable.
      plan.deleteBranches.push({ taskId: br.taskId, branch: br.branch, reason: 'deleted', force: true });
    } else if (status === 'done' && br.mergedIntoBase) {
      // Integrated: the commits are already on the base branch, so a merged-only
      // delete is safe and cannot lose work.
      plan.deleteBranches.push({ taskId: br.taskId, branch: br.branch, reason: 'done', force: false });
    } else {
      plan.kept.push({ taskId: br.taskId, reason: status ? `task is ${status}` : 'not merged into base' });
    }
  }
  return plan;
}

/** Reads the task worktrees, task branches and in-use state of one project repo. */
export async function gatherReapInputs(
  git: GitWorktrees,
  paths: GitPaths,
  baseBranch: string,
): Promise<{ worktrees: WorktreeInput[]; branches: BranchInput[] }> {
  const byId = new Map<string, WorktreeInput>();
  for (const entry of await git.listWorktrees()) {
    const taskId = taskIdOfWorktreePath(paths, entry.path);
    if (taskId) byId.set(taskId, { taskId, inUse: false });
  }
  // Directories git no longer tracks (a removal that failed halfway).
  for (const name of await git.listWorktreeDirectories()) {
    if (TASK_ID_PATTERN.test(name) && !byId.has(name)) byId.set(name, { taskId: name, inUse: false });
  }
  const worktrees: WorktreeInput[] = [];
  for (const wt of byId.values()) {
    const inUse = await git.isDirectoryInUse(`${paths.worktreesDir}/${wt.taskId}`);
    worktrees.push({ ...wt, inUse });
  }

  const branches: BranchInput[] = [];
  for (const branch of await git.listTaskBranches()) {
    const taskId = taskIdOfBranch(branch);
    if (!taskId) continue;
    branches.push({ taskId, branch, mergedIntoBase: await git.isMergedInto(branch, baseBranch) });
  }
  return { worktrees, branches };
}

export interface ReapResult {
  removedWorktrees: number;
  deletedBranches: number;
}

/** Executes a plan. Each operation's failure is contained so one bad ref cannot stall the rest. */
export async function executeReap(git: GitWorktrees, plan: ReapPlan, log: ProcessorDeps['log']): Promise<ReapResult> {
  const result: ReapResult = { removedWorktrees: 0, deletedBranches: 0 };
  for (const wt of plan.removeWorktrees) {
    try {
      await git.removeTaskWorktree(wt.taskId);
      result.removedWorktrees += 1;
      log.info('reaped worktree', { taskId: wt.taskId, reason: wt.reason });
    } catch (err) {
      log.warn('reap left a worktree in place', { taskId: wt.taskId, error: errorText(err) });
    }
  }
  for (const br of plan.deleteBranches) {
    try {
      if (br.force) await git.archiveTaskBranch(br.taskId); // keep the commits reachable
      await git.deleteBranch(br.branch, { force: br.force });
      result.deletedBranches += 1;
      log.info('reaped branch', { taskId: br.taskId, reason: br.reason });
    } catch (err) {
      // A not-fully-merged branch under `-d`, or one still checked out: leave it be.
      log.warn('reap kept a branch', { taskId: br.taskId, error: errorText(err) });
    }
  }
  return result;
}

/** Reaps one workspace, skipping it if any task there is currently active. */
export async function reapWorkspace(deps: ProcessorDeps, connect: ConnectWorkspace, workspaceId: string): Promise<ReapResult> {
  const { db } = deps;
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!workspace || workspace.deletedAt) return { removedWorktrees: 0, deletedBranches: 0 };

  const tasks = await db.query.agentTasks.findMany({ where: eq(agentTasks.workspaceId, workspaceId), columns: { id: true, status: true } });
  if (tasks.some((t) => (ACTIVE_STATUSES as string[]).includes(t.status))) {
    return { removedWorktrees: 0, deletedBranches: 0 };
  }
  const taskStatus = new Map<string, TaskStatus>(tasks.map((t) => [t.id, t.status as TaskStatus]));
  const policy: CoordinationPolicy = { ...DEFAULT_COORDINATION_POLICY, ...(workspace.coordinationPolicy ?? {}) };
  const baseBranch = policy.baseBranch || 'main';

  let connection: Awaited<ReturnType<ConnectWorkspace>> | null = null;
  try {
    connection = await connect(workspaceId, { id: `reaper-${workspaceId}`, userId: 'notea:reaper', name: 'notea: cleanup', kind: 'agent', role: 'editor' });
    const git = new GitWorktrees(connection.runner, DEFAULT_GIT_PATHS);
    // A workspace nobody has cloned into or run a task in has no repository yet, so it
    // cannot hold task worktrees or branches; asking git anyway failed, and logged a
    // warning, on every pass.
    if (!(await git.isRepository())) return { removedWorktrees: 0, deletedBranches: 0 };
    const { worktrees, branches } = await gatherReapInputs(git, DEFAULT_GIT_PATHS, baseBranch);
    const plan = planReap({ worktrees, branches, taskStatus });
    if (plan.removeWorktrees.length === 0 && plan.deleteBranches.length === 0) return { removedWorktrees: 0, deletedBranches: 0 };
    return await executeReap(git, plan, deps.log);
  } finally {
    connection?.close();
  }
}

/**
 * Reaps every running workspace. Only running containers are scanned, so the reaper
 * never starts a stopped workspace. Failures are logged, never thrown, so a bad
 * workspace cannot stall the worker tick.
 */
export async function reapAll(deps: ProcessorDeps, connect: ConnectWorkspace, listRunningWorkspaceIds: () => Promise<string[]>): Promise<ReapResult> {
  const total: ReapResult = { removedWorktrees: 0, deletedBranches: 0 };
  let ids: string[];
  try {
    ids = await listRunningWorkspaceIds();
  } catch (err) {
    deps.log.warn('reaper could not list workspaces', { error: errorText(err) });
    return total;
  }
  for (const workspaceId of ids) {
    try {
      const result = await reapWorkspace(deps, connect, workspaceId);
      total.removedWorktrees += result.removedWorktrees;
      total.deletedBranches += result.deletedBranches;
    } catch (err) {
      deps.log.warn('reaper failed for a workspace', { workspaceId, error: errorText(err) });
    }
  }
  return total;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
