# Notea Workspace — Agent System

Last updated: 2026-09-15. Status: **designed**. Nothing in this document is implemented yet except the parts of the protocol that already treat agents as participants (`kind: "agent"`, roles, presence).

## 1. Purpose and principles

Multiple AI coding agents, from different providers, work inside one workspace alongside humans without chaos.

1. **Agents are participants.** An agent connects like a human (`ClientIdentity{kind:"agent"}`), gets terminal sessions everyone can watch, and appears in presence and the activity feed.
2. **Isolation by worktree, integration by queue.** Each task runs in its own git worktree on its own branch. Finished work is integrated one task at a time after checks. Nobody edits the main tree concurrently with agents by default.
3. **Scopes are declared, leases are advisory, integration is authoritative.** Overlap is detected early (warn/block) and resolved late (rebase + checks), because CLI agents cannot be forced to honour file locks.
4. **The repository is the memory.** Task briefs point agents at versioned project docs; the platform stores metadata and activity, not knowledge.
5. **Provider-agnostic.** Only provider adapters know vendor names. Everything above them speaks `AgentRuntime`.
6. **Humans can always see, stop and approve.**

## 2. Layering

```
Provider        anthropic | openai | google | …          (adapter: auth env vars, model catalog, cost table)
   ↓
Credential      user-owned key or CLI login, encrypted at rest, injected per run
   ↓
Model           id, provider, capabilities (tools, context, streaming), price
   ↓
AgentRuntime    how the model is driven: claude-code-cli | codex-cli | gemini-cli | api-loop (later)
   ↓
Workspace       the container; the runtime executes inside it (terminal session)
   ↓
Task            description, scope, worktree/branch, status, owner, runs
   ↓
Project         the git repository in /home/dev/project and its docs
```

## 3. Modes of operation

**Interactive mode (M4 first step).** A human starts an agent CLI (for example `claude`) in a terminal session that the platform tags with an agent identity and, optionally, a task. Everyone can watch or take over. This needs almost nothing beyond what exists: create a session with `command: "claude"`, `title`, `createdBy` of the agent identity, and a cwd of the task worktree. Credentials come from the CLI's own login stored on the persistent HOME (personal MVP) or from injected environment variables.

**Headless task mode (M4 second step).** The platform runs the CLI non-interactively with a task brief and consumes a structured event stream (JSONL) to populate the activity feed, cost and file-change summaries. The PTY is still used so humans can watch, but input comes from the runner. Examples of headless entry points to verify at implementation time (exact flags change between releases):
- Claude Code: `claude -p "<brief>" --output-format stream-json` plus hooks for tool events; `--permission-mode` and `--allowedTools` for policy.
- Codex CLI: `codex exec "<brief>" --json`.
- Gemini CLI: non-interactive prompt mode with JSON output.

**API-loop mode (later).** A Notea-owned loop over provider SDKs with Notea tools (terminal, files). Behind the same interface; gives full control over tools, permissions and cost, at the price of maintaining a harness.

## 4. `AgentRuntime` interface (proposed, `packages/agents`)

```ts
export interface AgentRunContext {
  workspaceId: string;
  taskId: string;
  worktreePath: string;          // /home/dev/.notea/worktrees/<taskId>
  branch: string;                // notea/task/<taskId>
  brief: string;                 // generated task brief (see §8)
  model: ModelRef;               // { provider, modelId }
  credentialEnv: Record<string, string>; // e.g. ANTHROPIC_API_KEY — injected into the session only
  identity: ClientIdentity;      // kind: "agent"
  limits: { maxMinutes: number; maxCostUsd?: number };
}

export type AgentRunEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'message'; role: 'assistant' | 'tool'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'file_changed'; path: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'finished'; outcome: 'completed' | 'failed' | 'cancelled' | 'timeout'; summary?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

export interface AgentRuntime {
  readonly id: 'claude-code-cli' | 'codex-cli' | 'gemini-cli' | 'api-loop';
  supports(model: ModelRef): boolean;
  start(ctx: AgentRunContext, workspace: WorkspaceClient): Promise<AgentRunHandle>;
}

export interface AgentRunHandle {
  events: AsyncIterable<AgentRunEvent>;
  send(input: string): Promise<void>;   // steer an interactive run
  cancel(): Promise<void>;
}
```

`WorkspaceClient` is a thin wrapper over the workspace WebSocket protocol (create session, input, attach, fs.*). The runner process that hosts runtimes lives next to the orchestrator in M4 (it connects with an agent connect token) and can move inside the container later without changing the interface.

## 5. Providers and credentials

- Provider adapters map a credential to environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) and expose a model catalog with capabilities and prices.
- Credentials are per user, stored encrypted (AES-256-GCM with `CREDENTIALS_KEY` from the environment) in `provider_credentials`; never written to the workspace volume by the platform; injected into the agent's terminal session environment only for the duration of a run (`term.create` will need an `env` field: **protocol v1.1 change, additive**).
- Personal MVP shortcut: users may simply log in to CLIs inside the workspace; those tokens live on the volume under HOME. Documented in `SECURITY_MODEL.md` as acceptable for personal use only.

## 6. Isolation: worktrees

Layout inside the container:

```
/home/dev/project                        main working tree (humans; integration target)
/home/dev/.notea/worktrees/<taskId>      one worktree per task, branch notea/task/<taskId>
/home/dev/.notea/runs/<runId>/           logs, event JSONL, brief.md
```

Rules:
- Created with `git worktree add -b notea/task/<id> <path> <base>` from the current integration branch (default `main`).
- Agents run with cwd = worktree. The brief says so explicitly and forbids touching `/home/dev/project` directly.
- Dependencies: a worktree has no `node_modules`; the runner executes the workspace's install command in the worktree before starting the agent (cost accepted; caches under HOME make it fast). Open question: symlinking `node_modules` from the main tree is faster but breaks when dependency changes are part of the task.
- Ports: tasks that run dev servers must use ports from a per-task range handed in the brief (`PORT` env), to avoid collisions.
- Cleanup: worktrees are removed after integration or on task abandonment; branches are kept until the task is closed.

## 7. Coordination

**Tasks** (`agent_tasks` table) carry: title, description, `scope` (list of path globs the task expects to touch), runtime, model, credential, base branch, branch, worktree path, status (`draft | queued | running | needs_review | needs_rebase | integrating | done | failed | cancelled`), created_by, approvals.

**Leases** are derived from scopes: when a task starts, its scope is compared with the scopes of other running tasks. Policy per workspace: `warn` (start anyway, mark both as overlapping in the UI) or `block` (queue until the other finishes). Global-scope items (`package.json`, lockfiles, migrations directory, CI config) count as overlapping with every task by default because they are environment-level changes.

**Integration queue** (single writer per workspace):
1. Take the oldest task in `needs_review` with required approvals (policy: `auto` or `human`).
2. `git fetch`; rebase `notea/task/<id>` onto the integration branch. Conflict → status `needs_rebase`, create a follow-up task for the same agent with the conflict context, stop.
3. Run the workspace check command (for example `npm test`) in the rebased worktree. Failure → `needs_review` with logs, stop.
4. Fast-forward the integration branch, record an activity event, remove the worktree, mark `done`.

**Humans** can approve, reject, take over (attach to the agent's terminal and type), cancel, or edit the task and requeue. Everything is an activity event.

**Environment-level operations** (dependency install, migrations, service restarts) are serialised through the same queue rather than raced in worktrees; the brief instructs agents to declare such needs instead of performing them when the policy is strict.

## 8. Project memory and task briefs

Versioned files in the project are the durable memory. Notea does not invent a new format; it standardises on what tools already read:

- `AGENTS.md` (cross-tool standard, read by Codex/Gemini and others) at the project root: what the project is, how to run/test, conventions.
- `CLAUDE.md` containing `@AGENTS.md` (or equivalent) so Claude Code reads the same file.
- `docs/PROJECT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/CURRENT_STATE.md`, `docs/DECISIONS.md`, `docs/HANDOFF.md` for depth.

Per run, the platform generates `brief.md` and passes it as the prompt:
1. Task title and description, acceptance criteria.
2. Coordination rules: worktree path, branch, forbidden paths, port range, how to finish (commit on the task branch; do not merge), how to report (a final summary line).
3. Pointers: "Read `AGENTS.md` and `docs/CURRENT_STATE.md` first."
4. Constraints from scope overlaps, if any.

After a run, the runner appends a short entry to `docs/CURRENT_STATE.md` on the task branch (what changed, what remains) so the next agent inherits it through integration. A platform-level summary also lands in the activity feed.

## 9. Cost and usage

Runtimes emit `usage` events (parsed from CLI JSON streams). The control plane aggregates per run/task/workspace/user in `agent_runs.usage`. Budget caps (`maxCostUsd`, `maxMinutes`) cancel a run and mark it `timeout`/`failed`.

## 10. Failure handling

- Agent CLI crashes: session exits → `term.exit` → run `failed` with the last output captured in scrollback and event log.
- Runaway/loop: max minutes and cost caps; the human can attach and interrupt (Ctrl-C) since the session is a normal PTY.
- Container restart mid-run: sessions vanish; runs are marked `failed`; the worktree and branch persist on the volume so the task can be resumed with a new run and a brief that says "continue".
- Orchestrator restart: no effect on running CLIs (sessions live in the container); the runner reconnects and re-attaches by session id.

## 11. Open questions for implementation time

1. Exact headless flags and JSON event shapes for each CLI (verify against the installed versions; pin CLI versions in the image).
2. Whether the runner process should live inside the container (simplest credential scoping, but then the agent process needs Docker-free access to Notea APIs) or beside the orchestrator (current proposal).
3. `node_modules` strategy for worktrees (§6).
4. How much of the integration queue to automate before human approval exists in the UI (recommendation: build approvals first, automation second).
