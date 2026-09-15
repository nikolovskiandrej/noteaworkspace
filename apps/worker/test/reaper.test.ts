import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GIT_PATHS, GitWorktrees, ScriptedCommandRunner, type TaskStatus, type WorkspaceSession } from '@notea/agents';
import { agentTasks, createDatabase, runMigrations, users, workspaceMembers, workspaces, type DatabaseHandle } from '@notea/db';
import { executeReap, gatherReapInputs, planReap, reapWorkspace, type ReapPlan } from '../src/reaper';
import type { ProcessorDeps } from '../src/processor';

const WD = DEFAULT_GIT_PATHS.worktreesDir;
const PD = DEFAULT_GIT_PATHS.projectDir;
const uuid = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(12)}`;
const del = uuid('1');
const done = uuid('2');
const failed = uuid('3');
const running = uuid('4');
const inuse = uuid('5');
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('planReap', () => {
  it('reaps deleted and done debris, keeps everything re-runnable, active or in use', () => {
    const plan = planReap({
      worktrees: [
        { taskId: del, inUse: false },
        { taskId: done, inUse: false },
        { taskId: failed, inUse: false },
        { taskId: running, inUse: false },
        { taskId: inuse, inUse: true },
      ],
      branches: [
        { taskId: del, branch: `notea/task/${del}`, mergedIntoBase: false },
        { taskId: done, branch: `notea/task/${done}`, mergedIntoBase: true },
        { taskId: failed, branch: `notea/task/${failed}`, mergedIntoBase: false },
        { taskId: running, branch: `notea/task/${running}`, mergedIntoBase: false },
        { taskId: inuse, branch: `notea/task/${inuse}`, mergedIntoBase: false },
      ],
      taskStatus: new Map<string, TaskStatus>([
        [done, 'done'],
        [failed, 'failed'],
        [running, 'running'],
        // `del` and `inuse` are absent -> deleted tasks.
      ]),
    });

    expect(plan.removeWorktrees.map((w) => w.taskId).sort()).toEqual([del, done].sort());
    expect(plan.removeWorktrees.find((w) => w.taskId === del)?.reason).toBe('deleted');
    expect(plan.removeWorktrees.find((w) => w.taskId === done)?.reason).toBe('done');
    expect(plan.deleteBranches.find((b) => b.taskId === del)).toMatchObject({ reason: 'deleted', force: true });
    expect(plan.deleteBranches.find((b) => b.taskId === done)).toMatchObject({ reason: 'done', force: false });
    expect(plan.deleteBranches.map((b) => b.taskId).sort()).toEqual([del, done].sort());

    const keptIds = new Set(plan.kept.map((k) => k.taskId));
    expect(keptIds.has(failed)).toBe(true); // Run again
    expect(keptIds.has(running)).toBe(true); // active
    expect(keptIds.has(inuse)).toBe(true); // a process holds it
  });

  it('force-deletes an orphaned branch that has no worktree (deleted task)', () => {
    const plan = planReap({ worktrees: [], branches: [{ taskId: del, branch: `notea/task/${del}`, mergedIntoBase: false }], taskStatus: new Map() });
    expect(plan.deleteBranches).toEqual([{ taskId: del, branch: `notea/task/${del}`, reason: 'deleted', force: true }]);
    expect(plan.removeWorktrees).toEqual([]);
  });

  it('keeps an unmerged done branch rather than risk losing commits', () => {
    const plan = planReap({ worktrees: [], branches: [{ taskId: done, branch: `notea/task/${done}`, mergedIntoBase: false }], taskStatus: new Map([[done, 'done']]) });
    expect(plan.deleteBranches).toEqual([]);
    expect(plan.kept.some((k) => k.taskId === done)).toBe(true);
  });

  it('ignores ids and branches that are not ours', () => {
    const plan = planReap({
      worktrees: [{ taskId: 'not-a-uuid', inUse: false }],
      branches: [{ taskId: 'main', branch: 'main', mergedIntoBase: true }],
      taskStatus: new Map(),
    });
    expect(plan.removeWorktrees).toEqual([]);
    expect(plan.deleteBranches).toEqual([]);
  });
});

describe('gatherReapInputs', () => {
  it('collects task worktrees (incl. orphan dirs), branches and in-use flags', async () => {
    const runner = new ScriptedCommandRunner()
      .on('git worktree list --porcelain', {
        stdout: [`worktree ${PD}`, 'HEAD abc', 'branch refs/heads/main', '', `worktree ${WD}/${done}`, `branch refs/heads/notea/task/${done}`, ''].join('\n'),
      })
      .on(`if [ -d '${WD}' ]; then ls -1A '${WD}'; fi`, { stdout: `${done}\n${del}\nnot-a-uuid\n` })
      .on(`git for-each-ref --format='%(refname:short)' 'refs/heads/notea/task/'`, { stdout: `notea/task/${done}\nnotea/task/${del}\n` })
      .on(`git merge-base --is-ancestor 'notea/task/${del}' 'main'`, { exitCode: 1 })
      .on(/^git merge-base --is-ancestor/, { exitCode: 0 })
      .on(new RegExp(`awk -v p='${WD}/${del}'`), { stdout: '2\n' }) // del worktree is in use
      .on(/^for p in \/proc/, { stdout: '0\n' });

    const { worktrees, branches } = await gatherReapInputs(new GitWorktrees(runner, DEFAULT_GIT_PATHS), DEFAULT_GIT_PATHS, 'main');
    expect(worktrees.map((w) => w.taskId).sort()).toEqual([del, done].sort());
    expect(worktrees.find((w) => w.taskId === del)?.inUse).toBe(true);
    expect(worktrees.find((w) => w.taskId === done)?.inUse).toBe(false);
    expect(branches.find((b) => b.taskId === done)?.mergedIntoBase).toBe(true);
    expect(branches.find((b) => b.taskId === del)?.mergedIntoBase).toBe(false);
  });
});

describe('executeReap', () => {
  it('removes worktrees and deletes branches, archiving a force-deleted one first', async () => {
    const runner = new ScriptedCommandRunner();
    const plan: ReapPlan = {
      removeWorktrees: [{ taskId: done, reason: 'done' }],
      deleteBranches: [
        { taskId: del, branch: `notea/task/${del}`, reason: 'deleted', force: true },
        { taskId: done, branch: `notea/task/${done}`, reason: 'done', force: false },
      ],
      kept: [],
    };
    const result = await executeReap(new GitWorktrees(runner, DEFAULT_GIT_PATHS), plan, log);
    expect(result).toEqual({ removedWorktrees: 1, deletedBranches: 2 });
    const commands = runner.calls.map((c) => c.command);
    expect(commands).toContain(`git worktree remove --force '${WD}/${done}'`);
    expect(commands).toContain(`git update-ref 'refs/notea/archive/${del}' 'refs/heads/notea/task/${del}'`);
    expect(commands).toContain(`git branch -D 'notea/task/${del}'`);
    expect(commands).toContain(`git branch -d 'notea/task/${done}'`);
    // The archive must precede the force delete.
    expect(commands.indexOf(`git update-ref 'refs/notea/archive/${del}' 'refs/heads/notea/task/${del}'`)).toBeLessThan(commands.indexOf(`git branch -D 'notea/task/${del}'`));
  });

  it('keeps a branch git refuses to delete rather than forcing it', async () => {
    const runner = new ScriptedCommandRunner().on(`git branch -d 'notea/task/${done}'`, { exitCode: 1, stderr: 'not fully merged' });
    const plan: ReapPlan = { removeWorktrees: [], deleteBranches: [{ taskId: done, branch: `notea/task/${done}`, reason: 'done', force: false }], kept: [] };
    const result = await executeReap(new GitWorktrees(runner, DEFAULT_GIT_PATHS), plan, log);
    expect(result.deletedBranches).toBe(0);
  });
});

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

function fakeSession(): WorkspaceSession {
  return {
    createTerminal: async () => ({ sessionId: 'fake' }),
    killTerminal: async () => undefined,
    onTerminalOutput: () => () => undefined,
    onTerminalExit: () => () => undefined,
    writeHostFile: async () => undefined,
    ensureHostFile: async () => undefined,
  };
}

describeDb('reapWorkspace', () => {
  let handle: DatabaseHandle;
  let userId: string;
  let workspaceId: string;
  let runner: ScriptedCommandRunner;
  const suffix = randomUUID().slice(0, 8);

  const deps = (): ProcessorDeps => ({
    db: handle.db,
    runtimes: new Map(),
    connect: async () => ({ session: fakeSession(), runner, close: () => undefined }),
    credentialsKey: null,
    workerId: 'reaper-test',
    log,
  });

  beforeAll(async () => {
    handle = createDatabase(url as string, { max: 2 });
    await runMigrations(handle.db);
    const [user] = await handle.db.insert(users).values({ email: `reaper-${suffix}@example.com`, name: 'R' }).returning();
    userId = user!.id;
    const [ws] = await handle.db.insert(workspaces).values({ slug: `reaper-${suffix}`, name: 'Reaper WS', ownerId: userId }).returning();
    workspaceId = ws!.id;
    await handle.db.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
  });

  afterAll(async () => {
    await handle.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await handle.db.delete(users).where(eq(users.id, userId));
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.delete(agentTasks).where(eq(agentTasks.workspaceId, workspaceId));
  });

  async function createTask(status: TaskStatus): Promise<string> {
    const [task] = await handle.db
      .insert(agentTasks)
      .values({ workspaceId, title: `t ${status}`, description: 'x', runtime: 'generic-cli', agentName: 'A', command: 'true', status, createdBy: userId })
      .returning({ id: agentTasks.id });
    return task!.id;
  }

  function scriptedRepo(taskIds: string[]): ScriptedCommandRunner {
    return new ScriptedCommandRunner()
      .on('git worktree list --porcelain', {
        stdout: [`worktree ${PD}`, 'branch refs/heads/main', '', ...taskIds.flatMap((id) => [`worktree ${WD}/${id}`, `branch refs/heads/notea/task/${id}`, ''])].join('\n'),
      })
      .on(`if [ -d '${WD}' ]; then ls -1A '${WD}'; fi`, { stdout: taskIds.join('\n') + '\n' })
      .on(`git for-each-ref --format='%(refname:short)' 'refs/heads/notea/task/'`, { stdout: taskIds.map((id) => `notea/task/${id}`).join('\n') + '\n' })
      .on(/^git merge-base --is-ancestor/, { exitCode: 0 })
      .on(/^for p in \/proc/, { stdout: '0\n' });
  }

  it('skips a workspace that has an active task, without connecting', async () => {
    const doneId = await createTask('done');
    await createTask('running');
    runner = scriptedRepo([doneId]);
    const result = await reapWorkspace(deps(), deps().connect, workspaceId);
    expect(result).toEqual({ removedWorktrees: 0, deletedBranches: 0 });
    expect(runner.calls).toHaveLength(0);
  });

  it('reaps a done branch and a deleted task, keeps a failed task', async () => {
    const doneId = await createTask('done');
    const failedId = await createTask('failed');
    const deletedId = randomUUID(); // never inserted -> looks deleted
    runner = scriptedRepo([doneId, failedId, deletedId]);

    const result = await reapWorkspace(deps(), deps().connect, workspaceId);
    expect(result.removedWorktrees).toBe(2); // done (stray) + deleted
    expect(result.deletedBranches).toBe(2); // done (merged) + deleted (forced)
    const commands = runner.calls.map((c) => c.command);
    expect(commands).toContain(`git branch -d 'notea/task/${doneId}'`);
    expect(commands).toContain(`git branch -D 'notea/task/${deletedId}'`);
    expect(commands.some((c) => c.includes(`notea/task/${failedId}`) && c.startsWith('git branch'))).toBe(false);
    expect(commands.some((c) => c.includes(`${WD}/${failedId}`) && c.startsWith('git worktree remove'))).toBe(false);
  });
});
