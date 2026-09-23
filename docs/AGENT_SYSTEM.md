# Notea Workspace — Agent System

Last updated: 2026-09-15 (session 6). Status: **implemented** (packages/agents, apps/worker, web tasks UI) and **verified in Docker**. All three CLI runtimes have been executed against the real binaries in a workspace container; each starts, is parsed correctly and stops at its credential check. Cancellation and the max-minutes timeout are verified end to end against real container processes. Session 6 made every agent process run as **the Unix uid of the member whose task it is**, and drove two members' tasks through the whole pipeline concurrently. What has never run is an *authenticated* agent task — no provider credential exists on this machine.

## 1. Principles (unchanged)
Agents are participants; isolation by worktree, integration by queue; scopes declared, leases advisory, integration authoritative; the repository is the memory; provider-agnostic; humans can always see, stop and approve.

## 2. Layering (as implemented)

```
Provider        packages/agents/src/providers.ts   anthropic | openai | google
AuthMode        subscription (CLAUDE_CODE_OAUTH_TOKEN, no API charges) | api_key (metered)
Credential      provider_credentials (encrypted, one owner, one mode) or a CLI login in the
                member's private agent HOME
Model           ModelRef {provider, modelId}; catalog entries may be marked unverified
AgentRuntime    claude-code-cli (headless, parsed) | codex-cli | gemini-cli | generic-cli (unparsed)
Identity        users.agent_uid — the Unix uid the member's agent processes run as
Workspace       the container; runs execute as that uid through the orchestrator
Task            agent_tasks row: description, scope, runtime, model, credential, branch, status, usage
Project         /home/dev/project (main tree) + /home/dev/.notea/worktrees/<taskId>
```

## 3. Modes
- **Interactive** (implemented in session 12, D-045): every member who can write has their own Claude terminal on the workspace page — `claude`, interactive, in the main tree, as their `users.agent_uid` with their private HOME, so the login they make in it (`/login`, their own account) is theirs alone and their task runs can use it too. Everyone watches every terminal live; only its member types into it. The orchestrator holds the pty (`ARCHITECTURE.md` §4b). This is now how prompts are meant to be given; tasks are for work in the background.
- **Headless task run** (implemented): the worker starts the runtime as the task owner's uid through the orchestrator; output is parsed into events and stored on the run, and the tasks panel shows them. This is the path that carries credentials.
- **API loop** (later): same interface, Notea-owned tools.

### 3a. Where a run executes (session 6)
`IsolatedAgentSession` (packages/agents) implements both `WorkspaceSession` and
`CommandRunner` over the orchestrator's `POST /workspaces/:id/agent-exec`, so the
runtimes did not change and remain unaware of isolation. Each exec:

- runs as `users.agent_uid` of `agent_tasks.created_by`, with gid `dev`;
- gets a private HOME at `/home/dev/.notea/agents/<uid>`, created `0700`;
- runs with `umask 002`, so the shared group can still integrate and clean up;
- carries exactly one credential variable and has every other one cleared;
- carries `safe.directory` through `GIT_CONFIG_*`, because the repository belongs to
  `dev` and git otherwise refuses to work in it.

Cancellation signals the process *group* (the wrapper runs under `setsid` and records
its pid), so a CLI's child tools die with it. The trade compared with session 5: a run
is no longer a PTY session a human can attach to live — the run's event log is what the
UI shows. Bringing live attachment back means teaching the daemon to adopt a process it
did not spawn, and is not worth reopening the credential exposure for.

## 4. Runtime interface (actual)
`packages/agents/src/types.ts`: `AgentRuntime { id, label, provider, supports(model), start(ctx, session) → AgentRunHandle { sessionId, events: AsyncIterable<AgentRunEvent>, cancel() } }`. `WorkspaceSession` is the small surface runtimes need (create/kill terminal, output/exit listeners, write a host file); `ClientWorkspaceSession` implements it over `WorkspaceClient`. `startTerminalRun` turns a command into an event stream with a max-minutes timeout.

## 5. CLI runtimes (command lines verified against the installed binaries)

| Runtime | Command | Parsing |
|---|---|---|
| `claude-code-cli` | `claude -p "$(cat brief.md)" --output-format stream-json --verbose [--model X] [--max-budget-usd N] --dangerously-skip-permissions < /dev/null` | `parseClaudeStreamLine`: `assistant`/`user` → `message` + `tool_call` (+ `file_changed` for Edit/Write/MultiEdit/NotebookEdit), `result` → `usage` + `finished`, else `log` |
| `codex-cli` | `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [-m X] "$(cat brief.md)" < /dev/null` | `parseCodexLine`: `item.completed/started` → message / tool_call / file_changed, `turn.completed` → `usage`, `error`/`turn.failed` → error logs |
| `gemini-cli` | `gemini --approval-mode yolo [-m X] -p "$(cat brief.md)" < /dev/null` | text lines → log events; the command line first seeds `$HOME/.gemini/settings.json` (if absent) with folder trust disabled, because Gemini silently downgrades approval mode in untrusted folders. It is `$HOME` of the run itself — the member's private `~/.notea/agents/<uid>` — since the agent uid cannot write `/home/dev` and the CLI never reads it |

`--max-turns` does **not** exist in claude-code 2.1.272; the spend cap is `--max-budget-usd`, fed from the task's `maxBudgetUsd`. The `max_turns` column is retained but unused.

**Two `finished` events are normal.** The `result` record produces one, and process exit produces another; the worker keeps the last, so the exit code is authoritative. A CLI can report a *success-shaped* result that is actually a failure — claude-code emits `{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}` and then exits 1 — so the parser honours `is_error`, a non-zero exit overrides a success, and the exit-time event carries the earlier record's summary forward (`state.summary`) so the failure keeps its explanation instead of surfacing as a bare "failed". Fixtures from that real output are in `packages/agents/test/runtimes.test.ts`.

## 6. Isolation (implemented)
`GitWorktrees`: `ensureRepository` (git init + initial commit if needed), `createTaskWorktree` (idempotent; reuses an existing worktree/branch), `commitAll` as the agent identity, `commitsAhead`, `diffStat`, `rebaseOnto` (aborts on conflict), `fastForward` (refuses if the main tree is dirty or on another branch), `removeTaskWorktree` (removes the worktree and any leftover directory; the branch is a separate call). It also exposes the read/query helpers the reaper needs — `listWorktrees`/`parseWorktreeList`, `listTaskBranches`, `listWorktreeDirectories`, `taskIdOfBranch`/`taskIdOfWorktreePath`, `isMergedInto`, `isDirectoryInUse` (`/proc/<pid>/cwd`) — plus `deleteBranch` and `archiveTaskBranch` (`refs/notea/archive/<id>`). Worktrees have no `node_modules`; agents install if they need to (open question). Run-artefact paths (the brief) come from `layout.ts` (`runBriefPath`), not hardcoded strings.

## 7. Coordination (implemented)
- **Task statuses**: `draft → queued → running → needs_review → approved → integrating → done`, with `failed`, `cancelled`, `needs_rebase`, `checks_failed` and legal re-queues (`packages/agents/src/tasks.ts`).
- **Scope leases**: at claim time the worker compares the candidate's scope with running/integrating tasks in the workspace (`scopesOverlap`, conservative glob semantics); policy `block` keeps it queued, `warn` runs it. Empty scope means the whole project.
- **Integration** (`integrateTask`): rebase → optional check command → fast-forward; serialised per workspace with `PerKeyMutex`. Outcomes map to `done`, `needs_rebase`, `checks_failed`, `failed`. The outcome is recorded before the worktree is removed, so a failed cleanup cannot turn an integrated task into `failed`. An integration its worker abandoned (lease free or expired, claim older than a lease, not running in this process) goes back to `approved` and is retried (D-042).
- **Approvals**: `integration: human` (default) requires an editor/owner to approve; `auto` approves completed runs.
- **Humans**: can cancel (running tasks are interrupted within the heartbeat interval), re-run, delete, watch the agent terminal live, and edit the policy (owner).
- **Cleanup (reaper)**: the worker reaps orphaned git debris on its own cadence (`WORKER_REAP_INTERVAL_MS`, default 60 s). It removes the worktree and branch of a *deleted* task (the branch tip archived to `refs/notea/archive/<id>` first) and the branch of an integrated (`done`) task once it is merged into the base. It keeps the worktrees of re-runnable tasks (`failed`, `cancelled`, `needs_review`, `needs_rebase`, `checks_failed`, `queued`, `draft`), never touches `main` or a worktree a shell is using, and skips a workspace entirely while any task there is active. (The in-use check reads `/proc/<pid>/cwd` as `dev`, so it sees human shells; agent processes run under their members' uids and are invisible to it by design — the active-task skip is what protects them.) `apps/worker/src/reaper.ts`; decision D-038.

## 8. Brief (implemented)
`buildTaskBrief`: task, worktree/branch rules, scope, reserved paths of other running tasks, environment-level change warning, pointers to `AGENTS.md`/`docs/CURRENT_STATE.md`, check command, finish instructions. Written to `/home/dev/.notea/runs/<runId>/brief.md` and passed to the CLI.

## 9. Credentials and authentication modes (implemented)
A credential belongs to exactly one user, carries an `auth_mode`, and is decrypted by
the worker with `CREDENTIALS_KEY` for one run, into a process running as that member's
own uid. The worker re-checks ownership (`credential.userId === task.createdBy`) and
fails the run rather than borrowing another member's credential.

| Mode | Variable | How the member gets it | Billing |
|---|---|---|---|
| `subscription` | `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` — Anthropic's own command for headless use of a Claude subscription | the member's plan; no API charges |
| `api_key` | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | the provider's console | pay-as-you-go |

Exactly one is ever set, and `conflictingEnvNames` is cleared inside the container:
claude-code prefers the OAuth token when both are present, so setting both would let a
subscription quietly become metered usage. Verified against claude-code 2.1.272:
`claude auth status --json` reports `authMethod` `oauth_token`, `api_key` (with
`apiKeySource`) or `none`, and **Settings → AI & Claude** can run exactly that inside a
container under the member's own uid and show what the CLI says. Notea implements no
authentication flow of its own and never handles a Claude password or browser session.

Without a credential, the CLI's own login in the member's private agent HOME is used.

## 10. Usage and cost (partial)
`usage` events (Claude Code `result` records) are summed per run and stored on the task. No budgets, no per-user reports yet.

## 11. Failure handling (implemented)
Runtime exceptions → run/task `failed` with the message, and a run that fails while its agent is still going (an event that cannot be stored, a lost database connection) cancels the agent first; process exit ≠ 0 → `failed`; max-minutes timeout → `timeout`; cancellation → `cancelled`; worker crash → stale-run recovery marks runs failed after 2 minutes without a heartbeat, and interrupted integrations are retried (D-042); container restart mid-run → the run fails, the worktree/branch persist, re-run continues on the same branch.

The event stream always terminates. `startTerminalRun` kills the session at the max-minutes deadline and, if the session's exit notification does not arrive within `EXIT_GRACE_MS` (10 s), ends the stream itself — the same fallback covers cancellation. Without it a lost exit notification would block the worker's `for await` forever while its heartbeat kept refreshing, so the task would sit in `running` permanently and stale-run recovery, which looks for a *stopped* heartbeat, would never reclaim it.

The transport gets a hard deadline too: `startTerminalRun` passes `maxMinutes` + 60 s (`BACKSTOP_MARGIN_MS`) to `createTerminal`, which the isolated session forwards to the orchestrator. Its own default is 10 minutes, so before session 10, when nothing was passed, every agent run longer than that was killed by the orchestrator and reported as `failed`. The stream itself is kept alive: the orchestrator sends a `keepalive` frame every 30 s, because Node's fetch abandons a response body that is silent for 300 s and an agent inside one long tool call prints nothing for that long. If the stream is lost anyway, neither end leaves the process running unwatched: `IsolatedAgentSession` stops a process whose stream ended without an exit frame (retrying for ~30 s through an orchestrator restart), and the orchestrator kills an agent exec whose streaming caller disconnects. Git commands the worker runs through the workspace connection cannot hang either: `runExec` rejects when the connection drops, because the agent kills that connection's processes and their exit has nowhere to go.

Verified end to end against real container processes (session 4): a cancelled task killed its `sleep 300` and recorded `cancelled`; a task with `max_minutes = 1` ended exactly 60 s after start with outcome `timeout` and its process gone.

## 12. Open questions
1. `node_modules` in worktrees. 2. Runner placement (beside orchestrator vs inside container). 3. ~~Deleting task branches after integration~~ — resolved: the reaper deletes merged integrated branches and archives+deletes deleted-task branches (D-038). 4. Live streaming of run events to the UI (currently 5 s refresh). 5. Structured parsing for Codex/Gemini.
