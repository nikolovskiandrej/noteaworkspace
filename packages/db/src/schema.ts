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
    ...timestamps,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('workspaces_owner_idx').on(t.ownerId)],
);

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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceEvent = typeof workspaceEvents.$inferSelect;
