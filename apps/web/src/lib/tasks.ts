import { and, asc, desc, eq } from 'drizzle-orm';
import { PROVIDERS, assertTransition, createRuntimeRegistry, findModel, type ProviderId, type RuntimeId, type TaskStatus } from '@notea/agents';
import {
  DEFAULT_COORDINATION_POLICY,
  agentRunEvents,
  agentRuns,
  agentTasks,
  providerCredentials,
  workspaces,
  type AgentRun,
  type AgentRunEventRow,
  type AgentTask,
  type CoordinationPolicy,
  type Database,
} from '@notea/db';
import { ForbiddenError, NotFoundError, requireMembership } from './authz';
import { recordEvent } from './workspaces';

const RUNTIMES = createRuntimeRegistry();

export interface RuntimeOption {
  id: RuntimeId;
  label: string;
  provider: ProviderId | null;
}

export function runtimeOptions(): RuntimeOption[] {
  return [...RUNTIMES.values()].map((r) => ({ id: r.id, label: r.label, provider: r.provider }));
}

export function modelOptions() {
  return Object.values(PROVIDERS).flatMap((p) => p.models.map((m) => ({ provider: p.id, modelId: m.id, label: `${p.name} · ${m.label}${m.unverified ? ' (unverified id)' : ''}` })));
}

export interface CreateTaskInput {
  title: string;
  description: string;
  runtime: string;
  /** `provider:modelId` or empty. */
  model?: string;
  credentialId?: string;
  scope?: string;
  command?: string;
  agentName?: string;
  maxMinutes?: number;
}

export function parseScope(raw: string | undefined): string[] {
  if (!raw) return [];
  const items = raw
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
  if (items.length > 20) throw new Error('at most 20 scope patterns');
  for (const item of items) {
    if (item.includes('..') || item.startsWith('/')) throw new Error(`invalid scope pattern: ${item}`);
  }
  return [...new Set(items)];
}

export async function createTask(db: Database, userId: string, workspaceId: string, input: CreateTaskInput): Promise<AgentTask> {
  await requireMembership(db, workspaceId, userId, 'editor');
  const title = input.title.trim();
  if (title.length < 1 || title.length > 200) throw new Error('title must be 1-200 characters');
  const description = input.description.trim();
  if (description.length < 1 || description.length > 20_000) throw new Error('description must be 1-20000 characters');
  const runtime = RUNTIMES.get(input.runtime as RuntimeId);
  if (!runtime) throw new Error('unknown runtime');

  let provider: ProviderId | null = null;
  let modelId: string | null = null;
  if (input.model) {
    const [p, ...rest] = input.model.split(':');
    const ref = { provider: p as ProviderId, modelId: rest.join(':') };
    if (!findModel(ref)) throw new Error('unknown model');
    if (!runtime.supports(ref)) throw new Error(`${runtime.label} cannot use ${ref.provider} models`);
    provider = ref.provider;
    modelId = ref.modelId;
  } else if (runtime.provider) {
    provider = runtime.provider;
  }

  let credentialId: string | null = null;
  if (input.credentialId) {
    const credential = await db.query.providerCredentials.findFirst({
      where: and(eq(providerCredentials.id, input.credentialId), eq(providerCredentials.userId, userId)),
    });
    if (!credential) throw new NotFoundError('credential not found');
    if (provider && credential.provider !== provider) throw new Error(`credential is for ${credential.provider}, task uses ${provider}`);
    credentialId = credential.id;
  }
  const command = input.command?.trim() || null;
  if (runtime.id === 'generic-cli' && !command) throw new Error('the generic runtime needs a command');
  const maxMinutes = Math.min(Math.max(Math.round(input.maxMinutes ?? 30), 1), 240);

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { coordinationPolicy: true } });
  const policy = { ...DEFAULT_COORDINATION_POLICY, ...(workspace?.coordinationPolicy ?? {}) };

  const [task] = await db
    .insert(agentTasks)
    .values({
      workspaceId,
      title,
      description,
      scope: parseScope(input.scope),
      runtime: runtime.id,
      provider,
      modelId,
      credentialId,
      agentName: input.agentName?.trim() || runtime.label.replace(/ \(.*\)$/, ''),
      command,
      baseBranch: policy.baseBranch,
      status: 'queued',
      maxMinutes,
      createdBy: userId,
    })
    .returning();
  if (!task) throw new Error('failed to create task');
  await recordEvent(db, { workspaceId, actorKind: 'user', actorId: userId, type: 'task.created', payload: { taskId: task.id, title, runtime: runtime.id } });
  return task;
}

async function loadTask(db: Database, userId: string, taskId: string, minimumRole: 'editor' | 'owner' = 'editor'): Promise<AgentTask> {
  const task = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, taskId) });
  if (!task) throw new NotFoundError('task not found');
  await requireMembership(db, task.workspaceId, userId, minimumRole);
  return task;
}

async function transition(db: Database, userId: string, task: AgentTask, to: TaskStatus, extra: Partial<typeof agentTasks.$inferInsert> = {}): Promise<void> {
  assertTransition(task.status, to);
  const updated = await db
    .update(agentTasks)
    .set({ status: to, updatedAt: new Date(), ...extra })
    .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, task.status)))
    .returning({ id: agentTasks.id });
  if (updated.length === 0) throw new Error('task changed meanwhile; reload and try again');
  await recordEvent(db, { workspaceId: task.workspaceId, actorKind: 'user', actorId: userId, type: `task.${to}`, payload: { taskId: task.id, from: task.status } });
}

/** Editors and owners can approve; the integration itself is done by the worker. */
export async function approveTask(db: Database, userId: string, taskId: string): Promise<void> {
  const task = await loadTask(db, userId, taskId);
  await transition(db, userId, task, 'approved', { approvedBy: userId, approvedAt: new Date() });
}

export async function cancelTask(db: Database, userId: string, taskId: string): Promise<void> {
  const task = await loadTask(db, userId, taskId);
  await transition(db, userId, task, 'cancelled');
}

/** Re-runs a task from a terminal-ish state (failed, needs_rebase, checks_failed, cancelled, needs_review). */
export async function requeueTask(db: Database, userId: string, taskId: string): Promise<void> {
  const task = await loadTask(db, userId, taskId);
  await transition(db, userId, task, 'queued', { lastLog: null });
}

export async function deleteTask(db: Database, userId: string, taskId: string): Promise<void> {
  const task = await loadTask(db, userId, taskId, 'owner');
  if (task.status === 'running' || task.status === 'integrating') throw new ForbiddenError('stop the task before deleting it');
  await db.delete(agentTasks).where(eq(agentTasks.id, task.id));
  await recordEvent(db, { workspaceId: task.workspaceId, actorKind: 'user', actorId: userId, type: 'task.deleted', payload: { taskId: task.id } });
}

export async function updatePolicy(db: Database, userId: string, workspaceId: string, input: Partial<CoordinationPolicy>): Promise<void> {
  await requireMembership(db, workspaceId, userId, 'owner');
  const current = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { coordinationPolicy: true } });
  const next: CoordinationPolicy = { ...DEFAULT_COORDINATION_POLICY, ...(current?.coordinationPolicy ?? {}), ...input };
  if (!['warn', 'block'].includes(next.overlap)) throw new Error('invalid overlap policy');
  if (!['auto', 'human'].includes(next.integration)) throw new Error('invalid integration policy');
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(next.baseBranch)) throw new Error('invalid base branch');
  if (next.checkCommand !== null && next.checkCommand.length > 1000) throw new Error('check command too long');
  await db.update(workspaces).set({ coordinationPolicy: next, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
  await recordEvent(db, { workspaceId, actorKind: 'user', actorId: userId, type: 'policy.updated', payload: { ...next } });
}

export interface TaskView {
  task: AgentTask;
  latestRun: AgentRun | null;
  events: AgentRunEventRow[];
}

export async function listTasksForWorkspace(db: Database, workspaceId: string, options: { eventsForTaskIds?: string[]; maxEvents?: number } = {}): Promise<TaskView[]> {
  const tasks = await db.query.agentTasks.findMany({ where: eq(agentTasks.workspaceId, workspaceId), orderBy: desc(agentTasks.createdAt), limit: 100 });
  const views: TaskView[] = [];
  for (const task of tasks) {
    const latestRun = (await db.query.agentRuns.findFirst({ where: eq(agentRuns.taskId, task.id), orderBy: desc(agentRuns.attempt) })) ?? null;
    let events: AgentRunEventRow[] = [];
    if (latestRun && (!options.eventsForTaskIds || options.eventsForTaskIds.includes(task.id))) {
      events = await db.query.agentRunEvents.findMany({
        where: eq(agentRunEvents.runId, latestRun.id),
        orderBy: asc(agentRunEvents.seq),
        limit: options.maxEvents ?? 80,
      });
    }
    views.push({ task, latestRun, events });
  }
  return views;
}
