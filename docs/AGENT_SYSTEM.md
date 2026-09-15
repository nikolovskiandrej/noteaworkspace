# Notea Workspace — Agent System

Last updated: 2026-09-15 (session 5). Status: **implemented** (packages/agents, apps/worker, web tasks UI) and **verified in Docker**. All three CLI runtimes have been executed against the real binaries in a workspace container; each starts, is parsed correctly and stops at its credential check. Cancellation and the max-minutes timeout are verified end to end against real container processes. What has never run is an *authenticated* agent task — no provider credential exists on this machine.

## 1. Principles (unchanged)
Agents are participants; isolation by worktree, integration by queue; scopes declared, leases advisory, integration authoritative; the repository is the memory; provider-agnostic; humans can always see, stop and approve.

## 2. Layering (as implemented)

```
Provider        packages/agents/src/providers.ts   anthropic | openai | google → credential env var, model catalog
Credential      provider_credentials (encrypted) or a CLI login on the workspace volume
Model           ModelRef {provider, modelId}; catalog entries may be marked unverified
AgentRuntime    claude-code-cli (headless, parsed) | codex-cli | gemini-cli | generic-cli (unparsed)
Workspace       the container; runs execute in a terminal session created through the protocol
Task            agent_tasks row: description, scope, runtime, model, credential, branch, status, usage
Project         /home/dev/project (main tree) + /home/dev/.notea/worktrees/<taskId>
```

## 3. Modes
- **Interactive** (available today by hand): open a terminal, run `claude`/`codex`/`gemini`; everyone can watch. Not yet tied to a task record.
- **Headless task run** (implemented): the worker starts the runtime in a terminal session with the brief; output is parsed into events; the session is visible in the UI as `agent: <name>`.
- **API loop** (later): same interface, Notea-owned tools.

## 4. Runtime interface (actual)
`packages/agents/src/types.ts`: `AgentRuntime { id, label, provider, supports(model), start(ctx, session) → AgentRunHandle { sessionId, events: AsyncIterable<AgentRunEvent>, cancel() } }`. `WorkspaceSession` is the small surface runtimes need (create/kill terminal, output/exit listeners, write a host file); `ClientWorkspaceSession` implements it over `WorkspaceClient`. `startTerminalRun` turns a command into an event stream with a max-minutes timeout.

## 5. CLI runtimes (command lines verified against the installed binaries)

| Runtime | Command | Parsing |
|---|---|---|
| `claude-code-cli` | `claude -p "$(cat brief.md)" --output-format stream-json --verbose [--model X] [--max-budget-usd N] --dangerously-skip-permissions < /dev/null` | `parseClaudeStreamLine`: `assistant`/`user` → `message` + `tool_call` (+ `file_changed` for Edit/Write/MultiEdit/NotebookEdit), `result` → `usage` + `finished`, else `log` |
| `codex-cli` | `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [-m X] "$(cat brief.md)" < /dev/null` | `parseCodexLine`: `item.completed/started` → message / tool_call / file_changed, `turn.completed` → `usage`, `error`/`turn.failed` → error logs |
| `gemini-cli` | `gemini --approval-mode yolo [-m X] -p "$(cat brief.md)" < /dev/null` | text lines → log events; seeds `~/.gemini/settings.json` with folder trust disabled, because Gemini silently downgrades approval mode in untrusted folders |

`--max-turns` does **not** exist in claude-code 2.1.272; the spend cap is `--max-budget-usd`, fed from the task's `maxBudgetUsd`. The `max_turns` column is retained but unused.

**Two `finished` events are normal.** The `result` record produces one, and process exit produces another; the worker keeps the last, so the exit code is authoritative. A CLI can report a *success-shaped* result that is actually a failure — claude-code emits `{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}` and then exits 1 — so the parser honours `is_error`, a non-zero exit overrides a success, and the exit-time event carries the earlier record's summary forward (`state.summary`) so the failure keeps its explanation instead of surfacing as a bare "failed". Fixtures from that real output are in `packages/agents/test/runtimes.test.ts`.

## 6. Isolation (implemented)
`GitWorktrees`: `ensureRepository` (git init + initial commit if needed), `createTaskWorktree` (idempotent; reuses an existing worktree/branch), `commitAll` as the agent identity, `commitsAhead`, `diffStat`, `rebaseOnto` (aborts on conflict), `fastForward` (refuses if the main tree is dirty or on another branch), `removeTaskWorktree` (removes the worktree and any leftover directory; the branch is a separate call). It also exposes the read/query helpers the reaper needs — `listWorktrees`/`parseWorktreeList`, `listTaskBranches`, `listWorktreeDirectories`, `taskIdOfBranch`/`taskIdOfWorktreePath`, `isMergedInto`, `isDirectoryInUse` (`/proc/<pid>/cwd`) — plus `deleteBranch` and `archiveTaskBranch` (`refs/notea/archive/<id>`). Worktrees have no `node_modules`; agents install if they need to (open question). Run-artefact paths (the brief) come from `layout.ts` (`runBriefPath`), not hardcoded strings.

## 7. Coordination (implemented)
- **Task statuses**: `draft → queued → running → needs_review → approved → integrating → done`, with `failed`, `cancelled`, `needs_rebase`, `checks_failed` and legal re-queues (`packages/agents/src/tasks.ts`).
- **Scope leases**: at claim time the worker compares the candidate's scope with running/integrating tasks in the workspace (`scopesOverlap`, conservative glob semantics); policy `block` keeps it queued, `warn` runs it. Empty scope means the whole project.
- **Integration** (`integrateTask`): rebase → optional check command → fast-forward; serialised per workspace with `PerKeyMutex`. Outcomes map to `done`, `needs_rebase`, `checks_failed`, `failed`.
- **Approvals**: `integration: human` (default) requires an editor/owner to approve; `auto` approves completed runs.
- **Humans**: can cancel (running tasks are interrupted within the heartbeat interval), re-run, delete, watch the agent terminal live, and edit the policy (owner).
- **Cleanup (reaper)**: the worker reaps orphaned git debris on its own cadence (`WORKER_REAP_INTERVAL_MS`, default 60 s). It removes the worktree and branch of a *deleted* task (the branch tip archived to `refs/notea/archive/<id>` first) and the branch of an integrated (`done`) task once it is merged into the base. It keeps the worktrees of re-runnable tasks (`failed`, `cancelled`, `needs_review`, `needs_rebase`, `checks_failed`, `queued`, `draft`), never touches a worktree a process is using or `main`, and skips a workspace entirely while any task there is active. `apps/worker/src/reaper.ts`; decision D-038.

## 8. Brief (implemented)
`buildTaskBrief`: task, worktree/branch rules, scope, reserved paths of other running tasks, environment-level change warning, pointers to `AGENTS.md`/`docs/CURRENT_STATE.md`, check command, finish instructions. Written to `/home/dev/.notea/runs/<runId>/brief.md` and passed to the CLI.

## 9. Credentials (implemented)
Stored encrypted per user; selected per task; the worker decrypts with `CREDENTIALS_KEY` and injects `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` into the run's terminal session only (`term.create.env`). Without a credential the CLI's own login on the volume is used.

## 10. Usage and cost (partial)
`usage` events (Claude Code `result` records) are summed per run and stored on the task. No budgets, no per-user reports yet.

## 11. Failure handling (implemented)
Runtime exceptions → run/task `failed` with the message; process exit ≠ 0 → `failed`; max-minutes timeout → `timeout`; cancellation → `cancelled`; worker crash → stale-run recovery marks runs failed after 2 minutes without a heartbeat; container restart mid-run → the run fails, the worktree/branch persist, re-run continues on the same branch.

The event stream always terminates. `startTerminalRun` kills the session at the max-minutes deadline and, if the session's exit notification does not arrive within `EXIT_GRACE_MS` (10 s), ends the stream itself — the same fallback covers cancellation. Without it a lost exit notification would block the worker's `for await` forever while its heartbeat kept refreshing, so the task would sit in `running` permanently and stale-run recovery, which looks for a *stopped* heartbeat, would never reclaim it.

Verified end to end against real container processes (session 4): a cancelled task killed its `sleep 300` and recorded `cancelled`; a task with `max_minutes = 1` ended exactly 60 s after start with outcome `timeout` and its process gone.

## 12. Open questions
1. `node_modules` in worktrees. 2. Runner placement (beside orchestrator vs inside container). 3. ~~Deleting task branches after integration~~ — resolved: the reaper deletes merged integrated branches and archives+deletes deleted-task branches (D-038). 4. Live streaming of run events to the UI (currently 5 s refresh). 5. Structured parsing for Codex/Gemini.
