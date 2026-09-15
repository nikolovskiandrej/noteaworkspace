# Notea Workspace — Agent System

Last updated: 2026-09-15 (session 2). Status: **implemented** (packages/agents, apps/worker, web tasks UI) and **verified in Docker with the generic runtime**; the Claude Code runtime is implemented and unit-tested but has not yet run against the real CLI.

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

## 5. Claude Code runtime
Command: `cd <worktree> && claude -p "$(cat brief.md)" --output-format stream-json --verbose [--model X] [--max-turns N] --dangerously-skip-permissions`. Parser (`parseClaudeStreamLine`): `assistant`/`user` records → `message` and `tool_call` (+ `file_changed` for Edit/Write/MultiEdit/NotebookEdit), `result` → `usage` + `finished`, everything else → `log`. **Verify against CLI 2.1.272 on the first real run**; add real output samples to the tests.

## 6. Isolation (implemented)
`GitWorktrees`: `ensureRepository` (git init + initial commit if needed), `createTaskWorktree` (idempotent; reuses an existing worktree/branch), `commitAll` as the agent identity, `commitsAhead`, `diffStat`, `rebaseOnto` (aborts on conflict), `fastForward` (refuses if the main tree is dirty or on another branch), `removeTaskWorktree`. Worktrees have no `node_modules`; agents install if they need to (open question).

## 7. Coordination (implemented)
- **Task statuses**: `draft → queued → running → needs_review → approved → integrating → done`, with `failed`, `cancelled`, `needs_rebase`, `checks_failed` and legal re-queues (`packages/agents/src/tasks.ts`).
- **Scope leases**: at claim time the worker compares the candidate's scope with running/integrating tasks in the workspace (`scopesOverlap`, conservative glob semantics); policy `block` keeps it queued, `warn` runs it. Empty scope means the whole project.
- **Integration** (`integrateTask`): rebase → optional check command → fast-forward; serialised per workspace with `PerKeyMutex`. Outcomes map to `done`, `needs_rebase`, `checks_failed`, `failed`.
- **Approvals**: `integration: human` (default) requires an editor/owner to approve; `auto` approves completed runs.
- **Humans**: can cancel (running tasks are interrupted within the heartbeat interval), re-run, delete, watch the agent terminal live, and edit the policy (owner).

## 8. Brief (implemented)
`buildTaskBrief`: task, worktree/branch rules, scope, reserved paths of other running tasks, environment-level change warning, pointers to `AGENTS.md`/`docs/CURRENT_STATE.md`, check command, finish instructions. Written to `/home/dev/.notea/runs/<runId>/brief.md` and passed to the CLI.

## 9. Credentials (implemented)
Stored encrypted per user; selected per task; the worker decrypts with `CREDENTIALS_KEY` and injects `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` into the run's terminal session only (`term.create.env`). Without a credential the CLI's own login on the volume is used.

## 10. Usage and cost (partial)
`usage` events (Claude Code `result` records) are summed per run and stored on the task. No budgets, no per-user reports yet.

## 11. Failure handling (implemented)
Runtime exceptions → run/task `failed` with the message; process exit ≠ 0 → `failed`; max-minutes timeout → `timeout`; cancellation → `cancelled`; worker crash → stale-run recovery marks runs failed after 2 minutes without a heartbeat; container restart mid-run → the run fails, the worktree/branch persist, re-run continues on the same branch.

## 12. Open questions
1. `node_modules` in worktrees. 2. Runner placement (beside orchestrator vs inside container). 3. Deleting task branches after integration. 4. Live streaming of run events to the UI (currently 5 s refresh). 5. Structured parsing for Codex/Gemini.
