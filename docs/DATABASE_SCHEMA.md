# Notea Workspace — Database Schema

Last updated: 2026-09-15 (session 2). Status: **implemented** in `packages/db/src/schema.ts`; migrations `drizzle/0000_hot_risque.sql` (M1 tables) and `drizzle/0001_high_dazzler.sql` (agents). Postgres 17, Drizzle ORM, postgres.js. Ids are UUIDs (`gen_random_uuid()`), timestamps `timestamptz`.

## Not in the database
Runtime state (Docker), terminal sessions and presence (agent), project knowledge (repository), file contents (workspace volume).

## Tables

### users
id · email (lower-cased, unique) · name · password_hash (scrypt, nullable) · created_at · updated_at

### workspaces
id (= orchestrator workspaceId) · slug (unique) · name · owner_id → users · image (default `notea/workspace:dev`) · resources jsonb · repo_url · last_known_status · **coordination_policy jsonb** `{overlap: 'warn'|'block', integration: 'auto'|'human', checkCommand: string|null, baseBranch: string}` (defaults: block, human, null, main) · created_at · updated_at · deleted_at (soft delete). Index on owner_id.

### workspace_members
(workspace_id, user_id) pk · role enum `workspace_role` (owner|editor|viewer) · invited_by · created_at. Index on user_id. The owner always has an `owner` row.

### workspace_events (activity/audit, append-only)
id bigserial · workspace_id · actor_kind (user|agent|system) · actor_id (nullable uuid) · type · payload jsonb · created_at. Index (workspace_id, id). Types in use: `workspace.created|started|stopped|deleted`, `member.added|removed`, `task.created|<status>|deleted|run_started|run_finished|run_failed|integration`, `policy.updated`.

### provider_credentials
id · user_id → users (cascade) · provider (anthropic|openai|google) · label · encrypted_secret (`v1:<iv>:<tag>:<ciphertext>`, AES-256-GCM) · created_at · last_used_at. Index on user_id.

### agent_tasks
id · workspace_id (cascade) · title · description · scope jsonb string[] · runtime (claude-code-cli|codex-cli|gemini-cli|generic-cli) · provider · model_id · credential_id → provider_credentials (set null) · agent_name · command (generic-cli) · base_branch (default main) · branch · worktree_path · status enum `task_status` (draft|queued|running|needs_review|approved|integrating|needs_rebase|checks_failed|done|failed|cancelled) · max_minutes (default 30) · max_turns · summary · diff_stat · last_log · usage jsonb `{inputTokens, outputTokens, costUsd}` · created_by · approved_by · approved_at · started_at · finished_at · created_at · updated_at. Indexes (workspace_id, status), (status, created_at).

### agent_runs
id · task_id (cascade) · workspace_id (cascade) · attempt · status (running|completed|failed|cancelled|timeout) · session_id (terminal session in the workspace) · worker_id · heartbeat_at · started_at · ended_at · exit_code · summary · usage jsonb. Indexes on task_id and status.

### agent_run_events
id bigserial · run_id (cascade) · seq · type (started|message|tool_call|file_changed|usage|log|finished) · payload jsonb (event fields + `at`) · created_at. Index (run_id, seq).

## Invariants
- Deleting a workspace calls the orchestrator (`deleteVolume=true`) before soft-deleting the row; members, events, tasks, runs cascade on hard delete.
- Task status changes go through `assertTransition` (packages/agents) in the web service; the worker uses compare-and-set updates (`WHERE status = …`) so concurrent transitions cannot clobber each other.
- Only one worker should integrate a given workspace at a time (in-process mutex today; use `pg_advisory_xact_lock(hashtext(workspace_id))` when running several workers).

## Designed, not implemented
`workspace_invites` (invite links), per-user usage aggregates, `integration_queue` (folded into task statuses), `runtime_hosts` (multi-host).

## Migrations
`npm run generate -w @notea/db` after editing the schema; `npm run migrate -w @notea/db` applies (reads `DATABASE_URL` from the environment or the root `.env`). Dev database: `docker compose -p notea-dev -f infra/compose/docker-compose.dev.yml up -d` (host port 55432).
