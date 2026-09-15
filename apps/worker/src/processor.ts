import { and, asc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  GitWorktrees,
  PerKeyMutex,
  buildTaskBrief,
  credentialEnv,
  decryptSecret,
  effectiveScope,
  integrateTask,
  scopesOverlap,
  taskBranch,
  taskWorktreePath,
  DEFAULT_GIT_PATHS,
  type AgentRunContext,
  type AgentRunEvent,
  type AgentRuntime,
  type ProviderId,
  type RuntimeId,
} from '@notea/agents';
import {
  DEFAULT_COORDINATION_POLICY,
  agentRunEvents,
  agentRuns,
  agentTasks,
  providerCredentials,
  workspaceEvents,
  workspaces,
  type AgentTask,
  type CoordinationPolicy,
  type Database,
  type TaskUsage,
} from '@notea/db';
import type { ClientIdentity } from '@notea/protocol';
import { acquireIntegrationLease, releaseIntegrationLease } from './integration-lease';
import type { ConnectWorkspace } from './workspace-connection';

export interface ProcessorLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface ProcessorDeps {
  db: Database;
  runtimes: Map<RuntimeId, AgentRuntime>;
  connect: ConnectWorkspace;
  credentialsKey: Buffer | null;
  workerId: string;
  log: ProcessorLogger;
  /** Milliseconds between run heartbeats and cancellation checks. */
  heartbeatMs?: number;
  now?: () => Date;
}

const STALE_RUN_MS = 2 * 60 * 1000;

function policyOf(row: { coordinationPolicy: CoordinationPolicy | null }): CoordinationPolicy {
  return { ...DEFAULT_COORDINATION_POLICY, ...(row.coordinationPolicy ?? {}) };
}

async function recordEvent(db: Database, workspaceId: string, type: string, payload: Record<string, unknown>, actorId: string | null = null) {
  await db.insert(workspaceEvents).values({ workspaceId, actorKind: 'agent', actorId, type, payload });
}

function agentIdentity(task: AgentTask): ClientIdentity {
  return { id: `agent-${task.id}`, userId: `agent:${task.id}`, name: task.agentName, kind: 'agent', role: 'editor' };
}

/**
 * Claims the oldest queued task whose scope does not collide with a running task
 * in the same workspace (when the workspace policy is `block`). Returns null when
 * nothing is claimable.
 */
export async function claimNextTask(deps: ProcessorDeps): Promise<AgentTask | null> {
  const { db } = deps;
  const candidates = await db.query.agentTasks.findMany({ where: eq(agentTasks.status, 'queued'), orderBy: asc(agentTasks.createdAt), limit: 20 });
  for (const candidate of candidates) {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, candidate.workspaceId) });
    if (!workspace || workspace.deletedAt) continue;
    const policy = policyOf(workspace);
    if (policy.overlap === 'block') {
      const running = await db.query.agentTasks.findMany({
        where: and(eq(agentTasks.workspaceId, candidate.workspaceId), inArray(agentTasks.status, ['running', 'integrating'])),
      });
      const blocked = running.some((other) => scopesOverlap(effectiveScope(candidate.scope), effectiveScope(other.scope)));
      if (blocked) continue;
    }
    const [claimed] = await db
      .update(agentTasks)
      .set({ status: 'running', startedAt: deps.now?.() ?? new Date(), updatedAt: deps.now?.() ?? new Date(), lastLog: null })
      .where(and(eq(agentTasks.id, candidate.id), eq(agentTasks.status, 'queued')))
      .returning();
    if (claimed) return claimed;
  }
  return null;
}

/** Runs one claimed task to completion: worktree, brief, runtime, events, commit, review. */
export async function runTask(deps: ProcessorDeps, task: AgentTask): Promise<void> {
  const { db, log } = deps;
  const now = deps.now ?? (() => new Date());
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, task.workspaceId) });
  if (!workspace) throw new Error('workspace not found');
  const policy = policyOf(workspace);
  const baseBranch = task.baseBranch || policy.baseBranch;

  const previous = await db.query.agentRuns.findMany({ where: eq(agentRuns.taskId, task.id) });
  const [run] = await db
    .insert(agentRuns)
    .values({ taskId: task.id, workspaceId: task.workspaceId, attempt: previous.length + 1, status: 'running', workerId: deps.workerId })
    .returning();
  if (!run) throw new Error('failed to create run');

  const identity = agentIdentity(task);
  let connection: Awaited<ReturnType<ConnectWorkspace>> | null = null;
  let seq = 0;
  // Widened via assertion: TypeScript otherwise narrows these to `null` inside the loop.
  let usage = null as TaskUsage | null;
  let finished = null as Extract<AgentRunEvent, { type: 'finished' }> | null;
  let cancelled = false;

  const persistEvent = async (event: AgentRunEvent) => {
    seq += 1;
    const { type, at, ...payload } = event;
    await db.insert(agentRunEvents).values({ runId: run.id, seq, type, payload: { ...payload, at } });
  };

  try {
    connection = await deps.connect(task.workspaceId, identity);
    const git = new GitWorktrees(connection.runner, DEFAULT_GIT_PATHS);
    await git.ensureRepository();
    const worktree = await git.createTaskWorktree(task.id, baseBranch);
    await db
      .update(agentTasks)
      .set({ branch: worktree.branch, worktreePath: worktree.path, updatedAt: now() })
      .where(eq(agentTasks.id, task.id));

    const others = await db.query.agentTasks.findMany({
      where: and(eq(agentTasks.workspaceId, task.workspaceId), eq(agentTasks.status, 'running'), ne(agentTasks.id, task.id)),
    });
    const brief = buildTaskBrief({
      taskTitle: task.title,
      taskDescription: task.description,
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseBranch,
      projectDir: DEFAULT_GIT_PATHS.projectDir,
      scope: task.scope,
      reservedPaths: others.flatMap((o) => o.scope),
      checkCommand: policy.checkCommand,
      portRange: null,
    });

    let env: Record<string, string> = {};
    if (task.credentialId) {
      const credential = await db.query.providerCredentials.findFirst({ where: eq(providerCredentials.id, task.credentialId) });
      if (!credential) throw new Error('the selected credential no longer exists');
      if (!deps.credentialsKey) throw new Error('CREDENTIALS_KEY is not configured on the worker');
      env = credentialEnv(credential.provider as ProviderId, decryptSecret(credential.encryptedSecret, deps.credentialsKey));
      await db.update(providerCredentials).set({ lastUsedAt: now() }).where(eq(providerCredentials.id, credential.id));
    }

    const runtime = deps.runtimes.get(task.runtime as RuntimeId);
    if (!runtime) throw new Error(`unknown runtime ${task.runtime}`);
    const ctx: AgentRunContext = {
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      worktreePath: worktree.path,
      branch: worktree.branch,
      brief,
      model: task.provider && task.modelId ? { provider: task.provider as ProviderId, modelId: task.modelId } : null,
      credentialEnv: env,
      identity,
      limits: { maxMinutes: task.maxMinutes, maxTurns: task.maxTurns ?? undefined },
      command: task.command ?? undefined,
    };
    const handle = await runtime.start(ctx, connection.session);
    await db.update(agentRuns).set({ sessionId: handle.sessionId, heartbeatAt: now() }).where(eq(agentRuns.id, run.id));
    await recordEvent(db, task.workspaceId, 'task.run_started', { taskId: task.id, runId: run.id, sessionId: handle.sessionId, agentName: task.agentName }, null);
    log.info('run started', { taskId: task.id, runId: run.id, sessionId: handle.sessionId });

    const heartbeat = setInterval(() => {
      void (async () => {
        await db.update(agentRuns).set({ heartbeatAt: now() }).where(eq(agentRuns.id, run.id));
        const current = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id), columns: { status: true } });
        if (current?.status === 'cancelled' && !cancelled) {
          cancelled = true;
          await handle.cancel();
        }
      })().catch((err: unknown) => log.warn('heartbeat failed', { error: String(err) }));
    }, deps.heartbeatMs ?? 15_000);

    try {
      for await (const event of handle.events) {
        await persistEvent(event);
        if (event.type === 'usage') {
          usage = {
            inputTokens: (usage?.inputTokens ?? 0) + event.inputTokens,
            outputTokens: (usage?.outputTokens ?? 0) + event.outputTokens,
            costUsd: event.costUsd === null && usage?.costUsd == null ? null : (usage?.costUsd ?? 0) + (event.costUsd ?? 0),
          };
        }
        if (event.type === 'finished') finished = event;
      }
    } finally {
      clearInterval(heartbeat);
    }

    // Preserve the agent's work even if it forgot to commit.
    const committed = await git.commitAll(worktree.path, `Task: ${task.title} (agent run ${run.attempt})`, {
      name: task.agentName,
      email: `agent+${task.id}@notea.local`,
    });
    const diffStat = await git.diffStat(worktree.path, baseBranch).catch(() => '');
    const outcome = cancelled ? 'cancelled' : (finished?.outcome ?? 'failed');
    const summary = finished?.summary ?? null;

    await db
      .update(agentRuns)
      .set({ status: outcome, endedAt: now(), exitCode: finished?.exitCode ?? null, summary, usage })
      .where(eq(agentRuns.id, run.id));

    const currentTask = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id), columns: { status: true } });
    const nextStatus =
      currentTask?.status === 'cancelled' || outcome === 'cancelled'
        ? 'cancelled'
        : outcome === 'completed'
          ? policy.integration === 'auto'
            ? 'approved'
            : 'needs_review'
          : 'failed';
    await db
      .update(agentTasks)
      .set({
        status: nextStatus,
        summary,
        diffStat,
        usage,
        finishedAt: now(),
        updatedAt: now(),
        lastLog: outcome === 'completed' ? null : `run ${run.attempt} ended with outcome ${outcome}`,
      })
      .where(eq(agentTasks.id, task.id));
    await recordEvent(db, task.workspaceId, 'task.run_finished', { taskId: task.id, runId: run.id, outcome, committed, nextStatus, usage });
    log.info('run finished', { taskId: task.id, runId: run.id, outcome, nextStatus });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('run failed', { taskId: task.id, runId: run.id, error: message });
    await db.update(agentRuns).set({ status: 'failed', endedAt: now(), summary: message }).where(eq(agentRuns.id, run.id));
    await db
      .update(agentTasks)
      .set({ status: 'failed', lastLog: message, finishedAt: now(), updatedAt: now() })
      .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'running')));
    await recordEvent(db, task.workspaceId, 'task.run_failed', { taskId: task.id, runId: run.id, error: message });
  } finally {
    connection?.close();
  }
}

const integrationMutex = new PerKeyMutex();

/** Integrates one approved task (serialised per workspace). */
export async function integrateApprovedTask(deps: ProcessorDeps, task: AgentTask): Promise<void> {
  const { db, log } = deps;
  const now = deps.now ?? (() => new Date());
  // Cross-process safety: one worker per workspace at a time (in-process mutex below
  // handles concurrency within this worker). If another worker holds the lease the
  // task stays `approved` and is retried on a later tick.
  if (!(await acquireIntegrationLease(db, task.workspaceId, deps.workerId, now()))) return;

  const [claimed] = await db
    .update(agentTasks)
    .set({ status: 'integrating', updatedAt: now() })
    .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'approved')))
    .returning();
  if (!claimed) {
    await releaseIntegrationLease(db, task.workspaceId, deps.workerId);
    return;
  }

  await integrationMutex.run(task.workspaceId, async () => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, task.workspaceId) });
    const policy = policyOf(workspace ?? { coordinationPolicy: null });
    const baseBranch = task.baseBranch || policy.baseBranch;
    const worktreePath = task.worktreePath ?? taskWorktreePath(DEFAULT_GIT_PATHS, task.id);
    const branch = task.branch ?? taskBranch(task.id);
    let connection: Awaited<ReturnType<ConnectWorkspace>> | null = null;
    try {
      connection = await deps.connect(task.workspaceId, { ...agentIdentity(task), name: `integration: ${task.title}` });
      const git = new GitWorktrees(connection.runner, DEFAULT_GIT_PATHS);
      const result = await integrateTask(git, connection.runner, {
        taskId: task.id,
        worktreePath,
        branch,
        baseBranch,
        checkCommand: policy.checkCommand,
      });
      const nextStatus =
        result.status === 'integrated' || result.status === 'nothing_to_integrate'
          ? 'done'
          : result.status === 'conflict'
            ? 'needs_rebase'
            : result.status === 'checks_failed'
              ? 'checks_failed'
              : 'failed';
      if (nextStatus === 'done') await git.removeTaskWorktree(task.id, { deleteBranch: false });
      await db
        .update(agentTasks)
        .set({ status: nextStatus, lastLog: result.log, updatedAt: now(), finishedAt: nextStatus === 'done' ? now() : task.finishedAt })
        .where(eq(agentTasks.id, task.id));
      await recordEvent(db, task.workspaceId, 'task.integration', { taskId: task.id, result: result.status, nextStatus });
      log.info('integration finished', { taskId: task.id, result: result.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.update(agentTasks).set({ status: 'failed', lastLog: message, updatedAt: now() }).where(eq(agentTasks.id, task.id));
      await recordEvent(db, task.workspaceId, 'task.integration', { taskId: task.id, result: 'error', error: message });
      log.error('integration failed', { taskId: task.id, error: message });
    } finally {
      connection?.close();
      await releaseIntegrationLease(db, task.workspaceId, deps.workerId);
    }
  });
}

/** Marks runs whose worker stopped heartbeating as failed so their tasks can be requeued. */
export async function recoverStaleRuns(deps: ProcessorDeps): Promise<number> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - STALE_RUN_MS);
  const stale = await db.query.agentRuns.findMany({ where: and(eq(agentRuns.status, 'running'), lt(agentRuns.heartbeatAt, cutoff)) });
  for (const run of stale) {
    await db.update(agentRuns).set({ status: 'failed', endedAt: now(), summary: 'worker stopped heartbeating' }).where(eq(agentRuns.id, run.id));
    await db
      .update(agentTasks)
      .set({ status: 'failed', lastLog: 'worker stopped heartbeating; requeue to retry', updatedAt: now() })
      .where(and(eq(agentTasks.id, run.taskId), eq(agentTasks.status, 'running')));
    await recordEvent(db, run.workspaceId, 'task.run_failed', { taskId: run.taskId, runId: run.id, error: 'stale worker' });
  }
  return stale.length;
}

export async function findApprovedTasks(db: Database, limit = 10): Promise<AgentTask[]> {
  return db.query.agentTasks.findMany({ where: eq(agentTasks.status, 'approved'), orderBy: asc(agentTasks.approvedAt), limit });
}

/** Number of runs this worker currently owns (for capacity checks). */
export async function countOwnRunningRuns(db: Database, workerId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(and(eq(agentRuns.status, 'running'), eq(agentRuns.workerId, workerId)));
  return row?.count ?? 0;
}
