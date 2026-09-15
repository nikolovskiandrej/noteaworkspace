# Notea Workspace — Handoff

Written 2026-09-15, updated at the end of session 5 (worktree/branch reaper + agent-package cleanup). Self-contained; the conversation is not needed. Read `CURRENT_STATE.md` next, then `ARCHITECTURE.md`, `AGENT_SYSTEM.md`, `DECISIONS.md`.

## 1. Product summary

Self-hosted, browser-based shared development workspace: one persistent Linux container per project, shared terminals and files, several humans and several AI coding agents (any provider) working together with worktree isolation and human-approved integration. Personal use first. `PROJECT_SPEC.md`.

## 2. Current goal

Make the agent flow real with actual coding agents and harden collaboration:
1. Run the first *authenticated* Claude Code task (needs an Anthropic key stored under Settings → Credentials, or `claude login` in a workspace terminal) and confirm the stream-json parsing against CLI 2.1.272. The flags and the command line are already verified against the real CLI; what has never been exercised is a run that gets past authentication.
2. Same for the Codex and Gemini runtimes, which now have their own parsers rather than the generic one.
3. M2 leftovers: file watcher (`fs.changed` for terminal-side edits), invites by link. Sign-in rate limiting is done (commit `d50481f`).
4. M2 deployment: single-VPS compose with Caddy (see `IMPLEMENTATION_PLAN.md`).

## 3. Current architecture

Browser ⇄ Next.js control plane (`apps/web`, Postgres) ⇄ REST+API key ⇄ Orchestrator (`apps/orchestrator`, Docker) ⇄ workspace container running the agent (`packages/workspace-agent`). Browser and worker open WebSockets through the orchestrator bridge with short-lived JWTs. The worker (`apps/worker`) polls Postgres for tasks, connects to workspaces as an agent participant, and drives runtimes from `packages/agents`. Diagrams and flows: `ARCHITECTURE.md`.

## 4. Technology stack

Node 24, TypeScript 5.9, npm workspaces, zod 4, ws 8, node-pty 1.1, Fastify 5, dockerode 5, jose 6, Next.js 16.3 (App Router, Turbopack), React 19, Tailwind 4, Auth.js 5 beta (credentials), Drizzle 0.45 + postgres.js, Postgres 17, xterm.js 6, CodeMirror 6, vitest 4, esbuild, tsx. Image: Debian bookworm + Node 24 + git + build tools + Claude Code/Codex/Gemini CLIs.

## 5. Repository structure

`CURRENT_STATE.md` has the tree. Apps are processes (`orchestrator`, `web`, `worker`); packages are libraries; `infra` holds the image and compose files; `docs` is the truth.

## 6. Implemented and tested

Everything listed under "Implemented behaviour" in `CURRENT_STATE.md`: protocol 1.1, agent daemon, orchestrator (incl. image-upgrade recreation), control plane with auth/roles/workspaces/members/terminal/editor/tasks/credentials, agents package, worker (incl. the worktree/branch reaper). 145 unit/integration tests + Docker e2e + manual browser verification of both the workspace UI and the complete task pipeline.

## 7. Partially implemented

- Collaboration (M2): membership, roles, shared terminals, presence and `fs.changed` notices exist; missing: rate limiting, watcher for terminal-side edits, invite links, activity feed for connection events.
- Agent runtimes: all three have their own parsers and have been executed against the real CLIs, which stop at their credential check; no authenticated run has happened.
- Cost tracking: usage from Claude Code `result` records is aggregated per run/task; no budgets or per-user totals.

## 8. Not started

Previews (port detection + proxy), deployment tooling (compose prod, Caddy), invites by link, CRDT editing, ESLint, multi-host orchestration, billing.

## 9. Database

`DATABASE_SCHEMA.md`. Tables: users, workspaces (with `coordination_policy`), workspace_members, workspace_events, provider_credentials, agent_tasks, agent_runs, agent_run_events. Migrations `packages/db/drizzle/0000_*.sql`, `0001_*.sql`; apply with `npm run migrate -w @notea/db`.

## 10–12. Runtime, terminal, realtime

Unchanged from session 1 (`ARCHITECTURE.md` §4–6) plus: exec processes bound to the requesting connection; per-session env injection; containers recreated on start when the image tag points at a new image id.

## 13–15. Agents, providers, coordination

`AGENT_SYSTEM.md` (now describes what is implemented). Key files: `packages/agents/src/{types,providers,runtimes/claude-code,git,integration,tasks,brief}.ts`, `apps/worker/src/processor.ts`.

## 16. Security model

`SECURITY_MODEL.md`. New since session 1: credentials encrypted at rest (AES-256-GCM, `CREDENTIALS_KEY`), injected only into the agent's terminal session; exec env allow-list (reserved names rejected); agent runs use `--dangerously-skip-permissions` inside the container/worktree sandbox with human review before integration (D-025); tasks/policies gated by roles server-side.

## 17. Important decisions

`DECISIONS.md` D-001…D-037. Do not casually reverse: identify-first bridge (D-007), hardening (D-009), HOME volume (D-010), worktree-per-task + serialized integration (D-013), stateless orchestrator (D-005), runs as watchable terminal sessions (D-024), worker as a separate process (D-026).

## 18. Known bugs

None open. Session 5 resolved the worktree/branch leak (formerly technical debt) with a worker-side reaper, verified against the live container (D-038). Fixed in session 4, each with tests: connect tokens written to the orchestrator log (D-033); the worker exceeding its concurrency limit (D-034); the integration lease released while another task still needed it (D-035); a lost terminal-exit notification hanging a run forever (D-036); an overridden failure losing the CLI's explanation (D-037). Earlier sessions: Next 16 `allowedDevOrigins`, provider constructed during SSR, proxy matcher export name, stale container image after rebuild.

## 19. Technical debt

`CURRENT_STATE.md` "Known issues and technical debt" (13 items).

## 20. Blockers

**One, and it needs the owner: no provider credential exists on this machine.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY` are all unset and the `provider_credentials` table is empty, so every agent run stops at its CLI's auth check. Store a key under Settings → Credentials, or log a CLI in from a workspace terminal. Nothing else is blocked.

## 21. Tested / 22. Not tested

Tested: see §6 and the verification table in `CURRENT_STATE.md`, which now covers the browser UI, real cancellation, real timeouts and real (unauthenticated) runs of all three CLIs.

Not tested: an **authenticated** agent run of any provider — the one real gap; `network` connect mode on Linux; more than one worker process; long-running (hours) sessions; browser on mobile; recovery from a workspace connection dropped mid-run (the 10 s exit-grace fallback covers it in unit tests, not against a real severed connection).

## 23. Exact current state (session 5)

**A worker-side worktree/branch reaper was added, and the agent package's git layer was cleaned up.** `apps/worker/src/reaper.ts` runs on the worker tick (`WORKER_REAP_INTERVAL_MS`, default 60 s): it removes the worktree and branch of a deleted task (archiving the branch tip to `refs/notea/archive/<id>` first) and the merged branch of an integrated task, keeps re-runnable and active tasks, in-use worktrees and `main`, scans only running containers, and skips a workspace while any task there is active (D-038). Verified against the demo container: it reaped exactly the one leftover `done` branch and was idempotent. `GitWorktrees` gained the read/query/delete helpers this needs, `removeTaskWorktree` is now single-purpose, and `packages/agents/src/layout.ts` centralises run-artefact paths (the four runtimes use `runBriefPath` instead of hardcoding). Suite: agents 28 → 31 (git parser guards), worker 8 → 17, total 133 → 145, all green; typecheck and `next build` clean.

This built on an incomplete, uncommitted refactor of `git.ts` (the reaper helper toolkit) plus `layout.ts` found in the working tree at session start; that work was adopted and finished rather than discarded, and `processor.ts` was updated to the new single-arg `removeTaskWorktree`.

## 23a. Prior state (session 4)

**The migration was re-verified independently, and the agent pipeline was hardened.** Storage: Docker's data disk is at `D:\DockerDesktop\wsl` (confirmed from Docker's own settings API and the WSL registration), nothing of this project's remains on C:, and the repository contains no C: paths outside documentation. Environment: all four migrations applied and in sync with the journal, Postgres on 55432 with the other project's Postgres untouched on 5432, container hardening intact (non-root `dev`, `CapDrop ALL`, `no-new-privileges`, no bind mounts), all three agent CLIs present in the running container.

Verified for real, not with mocks: the browser UI end to end (sign-in session, file tree, editor save written through to the container, terminal as `dev`, presence, tasks panel); cancellation (a `sleep 300` task cancelled, process killed, run `cancelled`); the max-minutes timeout (a 1-minute task ended at exactly 60 s with outcome `timeout`); and real runs of all three CLIs, each stopping at its own credential check with correctly parsed events.

Five defects were found and fixed, each with tests: connect tokens were being written to the orchestrator log (D-033); the worker could exceed its concurrency limit and claim every queued task in one tick (D-034); the integration lease could be released while a second task still needed it (D-035); a lost terminal-exit notification would hang a run forever, out of reach of stale-run recovery (D-036); and an overridden failure lost the CLI's explanation (D-037). Suite: 24 files, all green — agents 28, workspace-agent 42, orchestrator 21 (+18 Docker e2e), web 13, protocol 6, workspace-client 6, worker 8, db 1.

## 23b. Previous state

**The disk problem is fixed.** Session 3 moved Docker's data disk, the npm cache and test scratch off C: onto D: (`ARCHITECTURE.md` §12); C: went from 1.01 GB free to 22.19 GB free, and a full `npm run build:image` now writes nothing to C:. The whole stack was re-verified on the new storage: typecheck, every test suite (including the db/worker suites against a real Postgres and the orchestrator's real-Docker e2e), a production `next build`, an image rebuild, container recreation with the HOME volume preserved, and a `generic-cli` task driven from `queued` to `done`.

The `demo-project` workspace exists in the dev database (`ebc7f427-…`); its container runs the freshly rebuilt image containing claude-code 2.1.272, codex-cli 0.154.0 and gemini-cli 0.59.0, and its volume holds the integrated agent commits. Background processes started for verification (orchestrator, web dev server, worker) are stopped at handoff.

## 24. Exact next step

**The only blocker is a credential, and it needs you.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY` are all unset and `provider_credentials` is empty, so every agent run stops at its CLI's auth check. Everything up to that boundary is verified.

1. Start the stack: `docker compose -p notea-dev -f infra/compose/docker-compose.dev.yml up -d`, then orchestrator, web and **exactly one** worker (§29).
2. Provide a credential — store an Anthropic key under Settings → Credentials, or run `claude login` in a workspace terminal.
3. Re-queue "Claude: add a CHANGELOG entry" and watch the first *authenticated* run: the agent should edit inside `/home/dev/.notea/worktrees/<taskId>`, the task should reach `needs_review` with a real diff stat, and approving it should rebase and fast-forward `main`. Add the real `assistant`/`tool_use`/`result` records as fixtures next to the unauthenticated ones already in `packages/agents/test/runtimes.test.ts`.
4. Then pick up, in rough order of value: live run events instead of the 5 s refresh (`IMPLEMENTATION_PLAN.md` step 3) and the M2 leftovers. The worktree/branch reaper is done (session 5, D-038).

Before sharing a workspace with anyone, read `SECURITY_MODEL.md` → Provider credentials: a collaborator with terminal access can read the key of a run in flight through `/proc`.

## 25. Files to inspect first

1. `packages/protocol/src/messages.ts` — the contract.
2. `apps/worker/src/processor.ts` — the task lifecycle end to end.
3. `packages/agents/src/runtimes/claude-code.ts`, `terminal-run.ts` — how a run executes and is parsed.
4. `packages/agents/src/git.ts`, `integration.ts` — isolation and integration.
5. `apps/web/src/lib/{workspaces,tasks,authz}.ts` — control-plane rules.
6. `apps/orchestrator/src/docker/workspace-runtime.ts` — container lifecycle.
7. `apps/web/src/components/{workspace-view,tasks-panel,terminal}.tsx` — UI.

## 26. Do not change casually

Listed in §17, plus: protocol message names (additive only), `/home/dev/project` layout, task status names (the UI, worker and tests depend on them), the rule that the worker never edits the main tree except through fast-forward integration.

## 27. Assumptions

Personal use on owner-controlled hosts; Docker available; collaborators are invited people; agent CLIs remain the primary runtimes; a human approves integration by default.

## 28. Environment and setup

`.env` at the repo root (`.env.example` lists every variable): orchestrator secrets, `DATABASE_URL`, `AUTH_SECRET`, `ORCHESTRATOR_URL`, `CREDENTIALS_KEY` (shared by web and worker), optional worker tuning. Next.js and the worker load the root `.env` automatically. Docker Desktop must be running.

Storage on this machine is deliberately off the C: drive — Docker's data disk is at `D:\DockerDesktop\wsl`, the npm cache at `D:\NoteaWorkspaceData\npm-cache`, test scratch at `<repo>\.tmp`. The first two are machine settings, not repository settings, so they do not follow a clone; `ARCHITECTURE.md` §12 has the layout, the reasoning and the exact procedure for changing Docker's location (use the GUI — editing `settings-store.json` by hand silently creates an empty disk).

## 29. Commands

| Purpose | Command |
|---|---|
| Dev Postgres | `docker compose -p notea-dev -f infra/compose/docker-compose.dev.yml up -d` |
| Migrate | `npm run migrate -w @notea/db` |
| Create a user | `npm run create-user -w @notea/web -- <email> <name> <password>` |
| Build image | `npm run build:image` |
| Orchestrator | `npm run dev:orchestrator` (or `npx tsx src/index.ts` in `apps/orchestrator`) |
| Web | `npm run dev -w @notea/web` → http://127.0.0.1:3000 |
| Worker | `npm run dev -w @notea/worker` |
| Tests | `npm run typecheck && npm test` (set `DATABASE_URL` for the db-backed suites) |
| Docker e2e | `npm run test:e2e -w @notea/orchestrator` |

## 30. Open questions

1. Whether to run the worker inside the orchestrator process for single-host deployments (simpler ops) or keep it separate (current).
2. `node_modules` strategy for worktrees (currently none; agents must install per worktree if needed).
3. Preview proxy design (path vs subdomain).
4. Whether task branches should be deleted after integration (currently kept).
5. How to surface run events live (currently page refresh every 5 s while tasks are active).
