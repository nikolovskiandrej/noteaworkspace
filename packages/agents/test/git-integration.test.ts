import { describe, expect, it } from 'vitest';
import { ScriptedCommandRunner } from '../src/command-runner';
import { GitWorktrees, TASK_ID_PATTERN, parseWorktreeList, taskBranch, taskIdOfBranch, taskIdOfWorktreePath, taskWorktreePath } from '../src/git';
import { PerKeyMutex, integrateTask } from '../src/integration';

const paths = { projectDir: '/home/dev/project', worktreesDir: '/home/dev/.notea/worktrees' };
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('worktree/branch parsing (reaper safety guards)', () => {
  it('parses `git worktree list --porcelain`, including flags', () => {
    const output = [
      '/home/dev/project',
      'worktree /home/dev/project',
      'HEAD 7c8a81ec',
      'branch refs/heads/main',
      '',
      `worktree /home/dev/.notea/worktrees/${UUID}`,
      'HEAD 418116b8',
      `branch refs/heads/notea/task/${UUID}`,
      'locked',
      '',
      'worktree /home/dev/.notea/worktrees/gone',
      'HEAD deadbeef',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    const entries = parseWorktreeList(output);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ path: '/home/dev/project', branch: 'refs/heads/main', detached: false });
    expect(entries[1]).toMatchObject({ path: `/home/dev/.notea/worktrees/${UUID}`, branch: `refs/heads/notea/task/${UUID}`, locked: true });
    expect(entries[2]).toMatchObject({ path: '/home/dev/.notea/worktrees/gone', detached: true, prunable: true });
  });

  it('extracts a task id from a task branch and rejects anything else', () => {
    expect(taskIdOfBranch(`notea/task/${UUID}`)).toBe(UUID);
    expect(taskIdOfBranch('main')).toBeNull();
    expect(taskIdOfBranch('notea/task/not-a-uuid')).toBeNull();
    expect(taskIdOfBranch('feature/notea/task/' + UUID)).toBeNull();
  });

  it('extracts a task id from a worktree path and rejects escapes', () => {
    expect(taskIdOfWorktreePath(paths, `/home/dev/.notea/worktrees/${UUID}`)).toBe(UUID);
    expect(taskIdOfWorktreePath(paths, `/home/dev/.notea/worktrees/${UUID}/nested`)).toBeNull();
    expect(taskIdOfWorktreePath(paths, '/home/dev/project')).toBeNull();
    expect(taskIdOfWorktreePath(paths, '/home/dev/.notea/worktrees/not-a-uuid')).toBeNull();
    expect(TASK_ID_PATTERN.test(UUID)).toBe(true);
    expect(TASK_ID_PATTERN.test('../etc')).toBe(false);
  });
});

describe('GitWorktrees', () => {
  it('initialises a repository when the project is not one yet', async () => {
    const runner = new ScriptedCommandRunner()
      .on('git rev-parse --is-inside-work-tree', { exitCode: 128, stderr: 'not a git repository' })
      .on('git rev-parse --verify HEAD', { exitCode: 128 })
      .on('git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' });
    const git = new GitWorktrees(runner, paths);
    expect(await git.ensureRepository()).toEqual({ initialized: true, branch: 'main' });
    expect(runner.calls.map((c) => c.command)).toEqual([
      'git rev-parse --is-inside-work-tree',
      'git init -b main',
      'git rev-parse --verify HEAD',
      'git add -A && git -c user.name=Notea -c user.email=notea@local commit -q --allow-empty -m "Initial commit"',
      'git rev-parse --abbrev-ref HEAD',
    ]);
    expect(runner.calls.every((c) => c.cwd === paths.projectDir)).toBe(true);
  });

  it('creates a task worktree on a new branch, and reuses an existing one', async () => {
    const runner = new ScriptedCommandRunner()
      .on(/^test -d/, { exitCode: 1 }, { once: true })
      .on(/^git rev-parse --verify 'notea\/task\/t1'/, { exitCode: 128 });
    const git = new GitWorktrees(runner, paths);
    const created = await git.createTaskWorktree('t1', 'main');
    expect(created).toEqual({ path: taskWorktreePath(paths, 't1'), branch: taskBranch('t1'), reused: false });
    expect(runner.calls.at(-1)?.command).toBe(
      `git worktree add -b 'notea/task/t1' '/home/dev/.notea/worktrees/t1' 'main'`,
    );

    const again = await git.createTaskWorktree('t1', 'main');
    expect(again.reused).toBe(true);
  });

  it('commits only when there are changes, as the agent identity', async () => {
    const runner = new ScriptedCommandRunner().on('git status --porcelain', { stdout: ' M src/a.ts\n' }, { once: true });
    const git = new GitWorktrees(runner, paths);
    expect(await git.commitAll('/wt', 'Agent work', { name: "Agent O'Neil", email: 'agent@notea.local' })).toBe(true);
    expect(runner.calls.at(-1)?.command).toBe(
      `git add -A && git -c user.name='Agent O'\\''Neil' -c user.email='agent@notea.local' commit -q -m 'Agent work'`,
    );
    expect(await git.commitAll('/wt', 'nothing', { name: 'a', email: 'b' })).toBe(false);
  });

  it('refuses to fast-forward when the main tree is dirty or on another branch', async () => {
    const dirty = new ScriptedCommandRunner()
      .on('git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' })
      .on('git status --porcelain', { stdout: '?? junk\n' });
    await expect(new GitWorktrees(dirty, paths).fastForward('main', 'notea/task/t1')).rejects.toThrow(/uncommitted/);

    const elsewhere = new ScriptedCommandRunner().on('git rev-parse --abbrev-ref HEAD', { stdout: 'feature\n' });
    await expect(new GitWorktrees(elsewhere, paths).fastForward('main', 'notea/task/t1')).rejects.toThrow(/expected main/);
  });
});

describe('integrateTask', () => {
  const input = { taskId: 't1', worktreePath: '/wt', branch: 'notea/task/t1', baseBranch: 'main', checkCommand: 'npm test' };

  it('rebases, runs checks and fast-forwards', async () => {
    const runner = new ScriptedCommandRunner()
      .on(`git rev-list --count 'main'..HEAD`, { stdout: '2\n' }, { once: true })
      .on('git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' })
      .on('git status --porcelain', { stdout: '' })
      .on(`git rev-list --count 'main'..HEAD`, { stdout: '0\n' });
    const result = await integrateTask(new GitWorktrees(runner, paths), runner, input);
    expect(result).toMatchObject({ status: 'integrated', commits: 2 });
    const commands = runner.calls.map((c) => c.command);
    expect(commands).toContain(`git -c user.name=Notea -c user.email=notea@local rebase 'main'`);
    expect(commands).toContain('npm test');
    expect(commands).toContain(`git merge --ff-only 'notea/task/t1'`);
    expect(runner.calls.find((c) => c.command === 'npm test')?.cwd).toBe('/wt');
  });

  it('aborts and reports a conflict when the rebase fails', async () => {
    const runner = new ScriptedCommandRunner()
      .on(/rev-list --count/, { stdout: '1\n' })
      .on(/rebase 'main'/, { exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in src/a.ts' });
    const result = await integrateTask(new GitWorktrees(runner, paths), runner, input);
    expect(result.status).toBe('conflict');
    expect(result.log).toContain('CONFLICT');
    expect(runner.calls.map((c) => c.command)).toContain('git rebase --abort');
    expect(runner.calls.map((c) => c.command)).not.toContain('npm test');
  });

  it('stops before merging when checks fail', async () => {
    const runner = new ScriptedCommandRunner()
      .on(/rev-list --count/, { stdout: '1\n' })
      .on('npm test', { exitCode: 1, stdout: '1 failing' });
    const result = await integrateTask(new GitWorktrees(runner, paths), runner, input);
    expect(result).toMatchObject({ status: 'checks_failed', exitCode: 1 });
    expect(runner.calls.map((c) => c.command).some((c) => c.startsWith('git merge'))).toBe(false);
  });

  it('reports nothing to integrate for an empty branch', async () => {
    const runner = new ScriptedCommandRunner().on(/rev-list --count/, { stdout: '0\n' });
    const result = await integrateTask(new GitWorktrees(runner, paths), runner, input);
    expect(result.status).toBe('nothing_to_integrate');
  });
});

describe('PerKeyMutex', () => {
  it('serialises work per key and lets different keys interleave', async () => {
    const mutex = new PerKeyMutex();
    const order: string[] = [];
    const job = (key: string, name: string, ms: number) =>
      mutex.run(key, async () => {
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`${name}:end`);
      });
    await Promise.all([job('a', 'a1', 30), job('a', 'a2', 5), job('b', 'b1', 5)]);
    expect(order.indexOf('a1:end')).toBeLessThan(order.indexOf('a2:start'));
    expect(order.indexOf('b1:start')).toBeLessThan(order.indexOf('a1:end'));
  });

  it('forgets a key once nothing is running or queued for it', async () => {
    const mutex = new PerKeyMutex();
    const job = (key: string) => mutex.run(key, () => new Promise((resolve) => setTimeout(resolve, 5)));
    await Promise.all([job('a'), job('a'), job('b')]);
    // One entry per workspace would otherwise stay for the life of the worker.
    expect(mutex.size).toBe(0);
    // The released key still serialises new work.
    await Promise.all([job('a'), job('a')]);
    expect(mutex.size).toBe(0);
  });
});
