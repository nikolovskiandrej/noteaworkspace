/**
 * Control-plane schema. See docs/DATABASE_SCHEMA.md for the rationale.
 *
 * Not stored here on purpose: runtime state (Docker is the source of truth), terminal
 * sessions and presence (live in the workspace agent), project knowledge (lives in
 * the repository).
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { WorkspaceResources } from '@notea/protocol';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stored lower-cased; normalise before querying. */
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  ...timestamps,
});

export const workspaceRole = pgEnum('workspace_role', ['owner', 'editor', 'viewer']);

export const workspaces = pgTable(
  'workspaces',
  {
    /** Also the orchestrator's workspaceId (UUIDs match its id pattern). */
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    image: text('image').notNull().default('notea/workspace:dev'),
    resources: jsonb('resources').$type<Partial<WorkspaceResources>>(),
    repoUrl: text('repo_url'),
    /** Cache of the last orchestrator status seen by the control plane (list views). */
    lastKnownStatus: text('last_known_status'),
    /** Multi-agent coordination settings; see docs/AGENT_SYSTEM.md. */
    coordinationPolicy: jsonb('coordination_policy').$type<CoordinationPolicy>(),
    ...timestamps,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('workspaces_owner_idx').on(t.ownerId)],
);

export interface CoordinationPolicy {
  /** What to do when a queued task's scope overlaps a running task's scope. */
  overlap: 'warn' | 'block';
  /** Whether finished tasks need a human approval before integration. */
  integration: 'auto' | 'human';
  /** Shell command run in the rebased worktree before merging (null = no checks). */
  checkCommand: string | null;
  /** Branch that tasks are based on and integrated into. */
  baseBranch: string;
}

export const DEFAULT_COORDINATION_POLICY: CoordinationPolicy = {
  overlap: 'block',
  integration: 'human',
  checkCommand: null,
  baseBranch: 'main',
};

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('workspace_members_user_idx').on(t.userId)],
);

export const workspaceEvents = pgTable(
  'workspace_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** user | agent | system */
    actorKind: text('actor_kind').notNull(),
    actorId: uuid('actor_id'),
    type: text('type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workspace_events_ws_idx').on(t.workspaceId, t.id)],
);

// ---------------------------------------------------------------------------
// Agents: credentials, tasks, runs, run events
// ---------------------------------------------------------------------------

export const taskStatus = pgEnum('task_status', [
  'draft',
  'queued',
  'running',
  'needs_review',
  'approved',
  'integrating',
  'needs_rebase',
  'checks_failed',
  'done',
  'failed',
  'cancelled',
]);

/** Provider API keys, encrypted with AES-256-GCM under CREDENTIALS_KEY (never stored in clear). */
export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    /** `v1:<iv b64>:<tag b64>:<ciphertext b64>` */
    encryptedSecret: text('encrypted_secret').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [index('provider_credentials_user_idx').on(t.userId)],
);

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    /** Path globs the task expects to touch; empty = whole project. */
    scope: jsonb('scope').notNull().$type<string[]>().default(sql`'[]'::jsonb`),
    runtime: text('runtime').notNull(),
    provider: text('provider'),
    modelId: text('model_id'),
    credentialId: uuid('credential_id').references(() => providerCredentials.id, { onDelete: 'set null' }),
    /** Display name of the agent participant, e.g. "Claude (login)". */
    agentName: text('agent_name').notNull(),
    /** For the generic-cli runtime: the command line to run in the worktree. */
    command: text('command'),
    baseBranch: text('base_branch').notNull().default('main'),
    branch: text('branch'),
    worktreePath: text('worktree_path'),
    status: taskStatus('status').notNull().default('draft'),
    maxMinutes: integer('max_minutes').notNull().default(30),
    maxTurns: integer('max_turns'),
    /** Final summary from the last run (agent's own words). */
    summary: text('summary'),
    diffStat: text('diff_stat'),
    /** Log of the last integration attempt or the last error. */
    lastLog: text('last_log'),
    usage: jsonb('usage').$type<TaskUsage>(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('agent_tasks_ws_status_idx').on(t.workspaceId, t.status), index('agent_tasks_status_created_idx').on(t.status, t.createdAt)],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull().default(1),
    /** running | completed | failed | cancelled | timeout */
    status: text('status').notNull().default('running'),
    /** Terminal session id inside the workspace (watchable in the UI while running). */
    sessionId: text('session_id'),
    workerId: text('worker_id'),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    exitCode: integer('exit_code'),
    summary: text('summary'),
    usage: jsonb('usage').$type<TaskUsage>(),
  },
  (t) => [index('agent_runs_task_idx').on(t.taskId), index('agent_runs_status_idx').on(t.status)],
);

export const agentRunEvents = pgTable(
  'agent_run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_run_events_run_seq_idx').on(t.runId, t.seq)],
);

export type ProviderCredential = typeof providerCredentials.$inferSelect;
export type AgentTask = typeof agentTasks.$inferSelect;
export type NewAgentTask = typeof agentTasks.$inferInsert;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentRunEventRow = typeof agentRunEvents.$inferSelect;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceEvent = typeof workspaceEvents.$inferSelect;
