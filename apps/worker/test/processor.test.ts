/**
 * Drives the task lifecycle against a real Postgres (DATABASE_URL) with a fake
 * workspace connection (scripted git), a fake runtime and no orchestrator.
 */
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedCommandRunner, type AgentRunEvent, type AgentRunHandle, type AgentRuntime, type CommandRunner, type WorkspaceSession } from '@notea/agents';
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
import {
  RunSlots,
  claimNextTask,
  integrateApprovedTask,
  recoverStaleIntegrations,
  recoverStaleRuns,
  runTask,
  startDueRuns,
  type ProcessorDeps,
} from '../src/processor';
import { acquireIntegrationLease, integrationLeaseHolder } from '../src/integration-lease';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

function fakeSession(): WorkspaceSession {
  return {
    createTerminal: async () => ({ sessionId: 'fake-session' }),
    killTerminal: async () => undefined,
    onTerminalOutput: () => () => undefined,
    onTerminalExit: () => () => undefined,
    writeHostFile: async () => undefined,
    ensureHostFile: async () => undefined,
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
    isolate: () => fakeSession(),
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

  it('never starts more concurrent runs than the limit, even before any run row exists', async () => {
    runner = scriptedGit();
    const d = deps(fakeRuntime([]));
    // Distinct scopes so the workspace's `block` overlap policy is not what limits us.
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await createTask({ title: `Parallel ${name} ${suffix}`, scope: [`${name}/**`] });
    }

    // Runs that never settle: `runTask` normally writes its `agent_runs` row several
    // round trips after the claim, so a database-backed count would still read zero
    // here and let every queued task be claimed at once.
    const pending: Array<() => void> = [];
    const slots = new RunSlots(2);
    const started = await startDueRuns(d, slots, () => new Promise<void>((resolve) => pending.push(resolve)));

    expect(started).toHaveLength(2);
    expect(slots.size).toBe(2);
    expect(slots.free).toBe(0);
    const running = await handle.db.query.agentTasks.findMany({ where: eq(agentTasks.workspaceId, workspaceId) });
    expect(running.filter((t) => t.status === 'running')).toHaveLength(2);
    expect(running.filter((t) => t.status === 'queued')).toHaveLength(3);

    // Finishing one run frees exactly one slot for the next tick.
    pending.pop()?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slots.free).toBe(1);
    const more = await startDueRuns(d, slots, () => new Promise<void>((resolve) => pending.push(resolve)));
    expect(more).toHaveLength(1);

    for (const resolve of pending) resolve();
  });

  it('defers integration and restores the task when another worker holds the lease', async () => {
    runner = scriptedGit();
    const d = deps(fakeRuntime([]));
    const task = await createTask({ title: `Leased ${suffix}` });
    await handle.db
      .update(agentTasks)
      .set({ status: 'approved', branch: 'notea/task/x', worktreePath: '/home/dev/.notea/worktrees/x' })
      .where(eq(agentTasks.id, task.id));

    expect(await acquireIntegrationLease(handle.db, workspaceId, 'other-worker')).toBe(true);
    await integrateApprovedTask(d, (await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) }))!);

    // Handed back for a later tick rather than integrated without the cross-process lock.
    expect((await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) }))?.status).toBe('approved');
    expect((await integrationLeaseHolder(handle.db, workspaceId))?.workerId).toBe('other-worker');

    await handle.db.update(workspaces).set({ integrationLockedBy: null, integrationLockedUntil: null }).where(eq(workspaces.id, workspaceId));
  });

  it('stops a started agent when the run fails before the agent has finished', async () => {
    runner = scriptedGit();
    let cancels = 0;
    const runtime: AgentRuntime = {
      id: 'generic-cli',
      label: 'unstorable',
      provider: null,
      supports: () => true,
      async start(): Promise<AgentRunHandle> {
        return {
          sessionId: 'fake-session',
          events: (async function* (): AsyncGenerator<AgentRunEvent> {
            yield { type: 'started', sessionId: 'fake-session', at: new Date().toISOString() };
            // BigInt has no JSON form, so storing this event throws mid-run.
            yield { type: 'tool_call', name: 'Bash', input: { size: 1n }, at: new Date().toISOString() };
            await new Promise(() => undefined); // the agent itself would keep going
          })(),
          cancel: async () => {
            cancels += 1;
          },
        };
      },
    };
    const d = deps(runtime);
    const task = await createTask({ title: `Unstorable ${suffix}` });
    await runTask(d, (await claimNextTask(d))!);
    // Otherwise the CLI keeps working, and spending, behind a task that reads `failed`.
    expect(cancels).toBe(1);
    expect((await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) }))?.status).toBe('failed');
  });

  it('keeps an integrated task done when removing its worktree fails afterwards', async () => {
    runner = scriptedGit({ dirtyWorktree: false });
    const task = await createTask({ title: `Removal ${suffix}` });
    await handle.db
      .update(agentTasks)
      .set({ status: 'approved', branch: `notea/task/${task.id}`, worktreePath: `/home/dev/.notea/worktrees/${task.id}` })
      .where(eq(agentTasks.id, task.id));
    // The workspace connection drops right after the fast-forward.
    const dropping: CommandRunner = {
      run: async (command, options) => {
        if (command.startsWith('git worktree remove')) throw new Error('connection closed before the process exited (1006)');
        return runner.run(command, options);
      },
    };
    const d = deps(fakeRuntime([]), { connect: async () => ({ session: fakeSession(), runner: dropping, close: () => undefined }) });
    await integrateApprovedTask(d, (await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) }))!);
    // The base branch has the commits; reporting `failed` would invite running it again.
    expect((await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) }))?.status).toBe('done');
    expect(runner.calls.map((c) => c.command)).toContain(`git merge --ff-only 'notea/task/${task.id}'`);
  });

  it('hands an integration abandoned by a stopped worker back to approved', async () => {
    const d = deps(fakeRuntime([]));
    const task = await createTask({ title: `Abandoned ${suffix}` });
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const setTask = (updatedAt: Date) =>
      handle.db.update(agentTasks).set({ status: 'integrating', updatedAt }).where(eq(agentTasks.id, task.id));
    const setLease = (by: string | null, until: Date | null) =>
      handle.db.update(workspaces).set({ integrationLockedBy: by, integrationLockedUntil: until }).where(eq(workspaces.id, workspaceId));
    const status = async () => (await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) }))?.status;

    try {
      // Claimed two hours ago by a worker that died holding a lease that has since expired.
      await setTask(longAgo);
      await setLease('dead-worker', new Date(Date.now() - 60_000));
      expect(await recoverStaleIntegrations(d)).toBeGreaterThanOrEqual(1);
      expect(await status()).toBe('approved');
      expect(await recoverStaleIntegrations(d)).toBe(0);

      // A live lease: another worker may still be integrating it.
      await setTask(longAgo);
      await setLease('other-worker', new Date(Date.now() + 60_000));
      expect(await recoverStaleIntegrations(d)).toBe(0);
      expect(await status()).toBe('integrating');

      // A fresh claim is not abandoned, even with the lease free between a worker's tasks.
      await setTask(new Date());
      await setLease(null, null);
      expect(await recoverStaleIntegrations(d)).toBe(0);
      expect(await status()).toBe('integrating');
    } finally {
      await setLease(null, null);
    }
  });

  it('releases the integration lease once integration finishes', async () => {
    runner = scriptedGit();
    const d = deps(fakeRuntime([]));
    const task = await createTask({ title: `Lease release ${suffix}` });
    await handle.db
      .update(agentTasks)
      .set({ status: 'approved', branch: 'notea/task/y', worktreePath: '/home/dev/.notea/worktrees/y' })
      .where(eq(agentTasks.id, task.id));

    await integrateApprovedTask(d, (await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) }))!);

    expect(await integrationLeaseHolder(handle.db, workspaceId)).toBeNull();
  });
});
