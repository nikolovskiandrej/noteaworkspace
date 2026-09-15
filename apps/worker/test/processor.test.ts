/**
 * Drives the task lifecycle against a real Postgres (DATABASE_URL) with a fake
 * workspace connection (scripted git), a fake runtime and no orchestrator.
 */
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedCommandRunner, type AgentRunEvent, type AgentRunHandle, type AgentRuntime, type WorkspaceSession } from '@notea/agents';
import {
  agentRunEvents,
  agentRuns,
  agentTasks,
  createDatabase,
  runMigrations,
  users,
  workspaceEvents,
  workspaceMembers,
  workspaces,
  type DatabaseHandle,
} from '@notea/db';
import { claimNextTask, integrateApprovedTask, recoverStaleRuns, runTask, type ProcessorDeps } from '../src/processor';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

function fakeSession(): WorkspaceSession {
  return {
    createTerminal: async () => ({ sessionId: 'fake-session' }),
    killTerminal: async () => undefined,
    onTerminalOutput: () => () => undefined,
    onTerminalExit: () => () => undefined,
    writeHostFile: async () => undefined,
  };
}

function scriptedGit(options: { dirtyWorktree?: boolean } = { dirtyWorktree: true }): ScriptedCommandRunner {
  const runner = new ScriptedCommandRunner()
    .on('git rev-parse --is-inside-work-tree', { exitCode: 0 })
    .on('git rev-parse --verify HEAD', { exitCode: 0 })
    .on('git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' })
    .on(/^test -d/, { exitCode: 1 })
    .on(/^git rev-parse --verify 'notea\/task/, { exitCode: 128 });
  if (options.dirtyWorktree) runner.on('git status --porcelain', { stdout: ' M src/a.ts\n' }, { once: true });
  return runner
    .on('git status --porcelain', { stdout: '' })
    .on(/^git diff --stat/, { stdout: ' src/a.ts | 2 +-\n' })
    .on(/^git rev-list --count/, { stdout: '1\n' }, { once: true })
    .on(/^git rev-list --count/, { stdout: '1\n' }, { once: true })
    .on(/^git rev-list --count/, { stdout: '0\n' });
}

function fakeRuntime(events: AgentRunEvent[]): AgentRuntime & { started: number } {
  const runtime = {
    id: 'generic-cli' as const,
    label: 'fake',
    provider: null,
    started: 0,
    supports: () => true,
    async start(): Promise<AgentRunHandle> {
      runtime.started += 1;
      let cancelled = false;
      const iterable: AsyncIterable<AgentRunEvent> = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'started', sessionId: 'fake-session', at: new Date().toISOString() };
          for (const event of events) {
            if (cancelled) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
            yield event;
          }
          if (cancelled) yield { type: 'finished', outcome: 'cancelled', summary: null, exitCode: null, at: new Date().toISOString() };
        },
      };
      return {
        sessionId: 'fake-session',
        events: iterable,
        cancel: async () => {
          cancelled = true;
        },
      };
    },
  };
  return runtime;
}

describeDb('task processor', () => {
  let handle: DatabaseHandle;
  let userId: string;
  let workspaceId: string;
  let runner: ScriptedCommandRunner;
  const suffix = randomUUID().slice(0, 8);
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

  const deps = (runtime: AgentRuntime, overrides: Partial<ProcessorDeps> = {}): ProcessorDeps => ({
    db: handle.db,
    runtimes: new Map([[runtime.id, runtime]]),
    connect: async () => ({ session: fakeSession(), runner, close: () => undefined }),
    credentialsKey: null,
    workerId: 'test-worker',
    log,
    heartbeatMs: 20,
    ...overrides,
  });

  beforeAll(async () => {
    handle = createDatabase(url as string, { max: 3 });
    await runMigrations(handle.db);
    const [user] = await handle.db.insert(users).values({ email: `worker-${suffix}@example.com`, name: 'W' }).returning();
    userId = user!.id;
    const [workspace] = await handle.db
      .insert(workspaces)
      .values({ slug: `worker-${suffix}`, name: 'Worker WS', ownerId: userId, coordinationPolicy: { overlap: 'block', integration: 'human', checkCommand: 'npm test', baseBranch: 'main' } })
      .returning();
    workspaceId = workspace!.id;
    await handle.db.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
  });

  afterAll(async () => {
    await handle.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await handle.db.delete(users).where(eq(users.id, userId));
    await handle.close();
  });

  // Each test starts without leftover tasks so claims are deterministic.
  beforeEach(async () => {
    await handle.db.delete(agentTasks).where(eq(agentTasks.workspaceId, workspaceId));
  });

  async function createTask(input: { title: string; scope?: string[]; status?: 'queued' | 'draft' }) {
    const [task] = await handle.db
      .insert(agentTasks)
      .values({
        workspaceId,
        title: input.title,
        description: 'do it',
        scope: input.scope ?? [],
        runtime: 'generic-cli',
        agentName: 'Fake Agent',
        command: 'true',
        status: input.status ?? 'queued',
        createdBy: userId,
      })
      .returning();
    return task!;
  }

  it('claims, runs, persists events, commits, and moves to needs_review', async () => {
    runner = scriptedGit();
    const runtime = fakeRuntime([
      { type: 'message', role: 'assistant', text: 'Working', at: new Date().toISOString() },
      { type: 'tool_call', name: 'Edit', input: { file_path: 'src/a.ts' }, at: new Date().toISOString() },
      { type: 'usage', inputTokens: 100, outputTokens: 50, costUsd: 0.02, at: new Date().toISOString() },
      { type: 'finished', outcome: 'completed', summary: 'Implemented the thing', exitCode: 0, at: new Date().toISOString() },
    ]);
    const created = await createTask({ title: `Task A ${suffix}`, scope: ['src/**'] });
    const d = deps(runtime);

    const claimed = await claimNextTask(d);
    expect(claimed?.id).toBe(created.id);
    expect(claimed?.status).toBe('running');
    expect(await claimNextTask(d)).toBeNull();

    await runTask(d, claimed!);

    const task = await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, created.id) });
    expect(task).toMatchObject({
      status: 'needs_review',
      branch: `notea/task/${created.id}`,
      worktreePath: `/home/dev/.notea/worktrees/${created.id}`,
      summary: 'Implemented the thing',
      diffStat: 'src/a.ts | 2 +-',
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 },
    });
    const commands = runner.calls.map((c) => c.command);
    expect(commands.some((c) => c.startsWith(`git worktree add -b 'notea/task/${created.id}'`))).toBe(true);
    expect(commands.some((c) => c.includes(`commit -q -m 'Task: Task A ${suffix} (agent run 1)'`))).toBe(true);

    const run = await handle.db.query.agentRuns.findFirst({ where: eq(agentRuns.taskId, created.id) });
    expect(run).toMatchObject({ status: 'completed', sessionId: 'fake-session', workerId: 'test-worker', attempt: 1 });
    const events = await handle.db.query.agentRunEvents.findMany({ where: eq(agentRunEvents.runId, run!.id), orderBy: agentRunEvents.seq });
    expect(events.map((e) => e.type)).toEqual(['started', 'message', 'tool_call', 'usage', 'finished']);
    const activity = await handle.db.query.workspaceEvents.findMany({ where: eq(workspaceEvents.workspaceId, workspaceId), orderBy: desc(workspaceEvents.id), limit: 2 });
    expect(activity.map((e) => e.type)).toEqual(['task.run_finished', 'task.run_started']);
  });

  it('blocks a queued task whose scope overlaps a running task, then integrates the approved one', async () => {
    runner = scriptedGit();
    const runtime = fakeRuntime([{ type: 'finished', outcome: 'completed', summary: 'ok', exitCode: 0, at: new Date().toISOString() }]);
    const d = deps(runtime);
    const runningTask = await createTask({ title: `Running ${suffix}`, scope: ['src/api/**'] });
    await handle.db.update(agentTasks).set({ status: 'running' }).where(eq(agentTasks.id, runningTask.id));
    const overlapping = await createTask({ title: `Overlap ${suffix}`, scope: ['src/api/users.ts'] });
    const disjoint = await createTask({ title: `Disjoint ${suffix}`, scope: ['docs/**'] });

    const claimed = await claimNextTask(d);
    expect(claimed?.id).toBe(disjoint.id);
    expect((await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, overlapping.id) }))?.status).toBe('queued');
    await runTask(d, claimed!);
    await handle.db.update(agentTasks).set({ status: 'cancelled' }).where(eq(agentTasks.id, runningTask.id));

    // Approve and integrate: rebase, `npm test`, fast-forward, worktree removed.
    await handle.db.update(agentTasks).set({ status: 'approved', approvedBy: userId, approvedAt: new Date() }).where(eq(agentTasks.id, disjoint.id));
    runner = scriptedGit({ dirtyWorktree: false });
    await integrateApprovedTask(d, (await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, disjoint.id) }))!);
    const done = await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, disjoint.id) });
    expect(done?.status).toBe('done');
    expect(done?.lastLog).toContain('integrated');
    const commands = runner.calls.map((c) => c.command);
    expect(commands).toContain('npm test');
    expect(commands).toContain(`git merge --ff-only 'notea/task/${disjoint.id}'`);
    expect(commands.some((c) => c.startsWith('git worktree remove'))).toBe(true);
  });

  it('marks a task failed when the runtime throws, and recovers stale runs', async () => {
    runner = scriptedGit();
    const broken: AgentRuntime = { id: 'generic-cli', label: 'broken', provider: null, supports: () => true, start: async () => { throw new Error('boom'); } };
    const d = deps(broken);
    const task = await createTask({ title: `Broken ${suffix}` });
    const claimed = await claimNextTask(d);
    await runTask(d, claimed!);
    const failed = await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) });
    expect(failed).toMatchObject({ status: 'failed', lastLog: 'boom' });

    const staleTask = await createTask({ title: `Stale ${suffix}` });
    await handle.db.update(agentTasks).set({ status: 'running' }).where(eq(agentTasks.id, staleTask.id));
    await handle.db.insert(agentRuns).values({ taskId: staleTask.id, workspaceId, status: 'running', workerId: 'dead', heartbeatAt: new Date(Date.now() - 10 * 60 * 1000) });
    expect(await recoverStaleRuns(d)).toBe(1);
    expect((await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, staleTask.id) }))?.status).toBe('failed');
    expect(await recoverStaleRuns(d)).toBe(0);
  });

  it('cancels a running task when its status is set to cancelled', async () => {
    runner = scriptedGit();
    const slowEvents: AgentRunEvent[] = Array.from({ length: 40 }, () => ({ type: 'log', level: 'info', text: 'tick', at: new Date().toISOString() }));
    const d = deps(fakeRuntime(slowEvents));
    const task = await createTask({ title: `Cancel ${suffix}` });
    const claimed = await claimNextTask(d);
    const running = runTask(d, claimed!);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await handle.db.update(agentTasks).set({ status: 'cancelled' }).where(eq(agentTasks.id, task.id));
    await running;
    const after = await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) });
    expect(after?.status).toBe('cancelled');
    const run = await handle.db.query.agentRuns.findFirst({ where: eq(agentRuns.taskId, task.id) });
    expect(run?.status).toBe('cancelled');
  });
});
