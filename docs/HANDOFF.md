# Notea Workspace — Handoff

Written 2026-09-15 by Fable 5.1 (end of session 2) for the next implementing agent (Opus 5). Self-contained; the conversation is not needed. Read `CURRENT_STATE.md` next, then `ARCHITECTURE.md`, `AGENT_SYSTEM.md`, `DECISIONS.md`.

## 1. Product summary

Self-hosted, browser-based shared development workspace: one persistent Linux container per project, shared terminals and files, several humans and several AI coding agents (any provider) working together with worktree isolation and human-approved integration. Personal use first. `PROJECT_SPEC.md`.

## 2. Current goal

Make the agent flow real with actual coding agents and harden collaboration:
1. Run the first real Claude Code task (needs an Anthropic key stored under Settings → Credentials, or `claude login` in a workspace terminal), verify the headless flags and the stream-json parsing against CLI 2.1.272, fix what differs.
2. Verify/parse Codex CLI and Gemini CLI output (currently generic runtimes with unverified flags).
3. M2 leftovers: sign-in rate limiting, file watcher (`fs.changed` for terminal-side edits), invites by link.
4. M2 deployment: single-VPS compose with Caddy (see `IMPLEMENTATION_PLAN.md`).

## 3. Current architecture

Browser ⇄ Next.js control plane (`apps/web`, Postgres) ⇄ REST+API key ⇄ Orchestrator (`apps/orchestrator`, Docker) ⇄ workspace container running the agent (`packages/workspace-agent`). Browser and worker open WebSockets through the orchestrator bridge with short-lived JWTs. The worker (`apps/worker`) polls Postgres for tasks, connects to workspaces as an agent participant, and drives runtimes from `packages/agents`. Diagrams and flows: `ARCHITECTURE.md`.

## 4. Technology stack

Node 24, TypeScript 5.9, npm workspaces, zod 4, ws 8, node-pty 1.1, Fastify 5, dockerode 5, jose 6, Next.js 16.3 (App Router, Turbopack), React 19, Tailwind 4, Auth.js 5 beta (credentials), Drizzle 0.45 + postgres.js, Postgres 17, xterm.js 6, CodeMirror 6, vitest 4, esbuild, tsx. Image: Debian bookworm + Node 24 + git + build tools + Claude Code/Codex/Gemini CLIs.

## 5. Repository structure

`CURRENT_STATE.md` has the tree. Apps are processes (`orchestrator`, `web`, `worker`); packages are libraries; `infra` holds the image and compose files; `docs` is the truth.

## 6. Implemented and tested

Everything listed under "Implemented behaviour" in `CURRENT_STATE.md`: protocol 1.1, agent daemon, orchestrator (incl. image-upgrade recreation), control plane with auth/roles/workspaces/members/terminal/editor/tasks/credentials, agents package, worker. 114 unit/integration tests + Docker e2e + manual browser verification of both the workspace UI and the complete task pipeline.

## 7. Partially implemented

- Collaboration (M2): membership, roles, shared terminals, presence and `fs.changed` notices exist; missing: rate limiting, watcher for terminal-side edits, invite links, activity feed for connection events.
- Agent runtimes: Claude Code runtime is complete in code but not executed against the real CLI; Codex/Gemini are generic (no structured events).
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

`DECISIONS.md` D-001…D-028. Do not casually reverse: identify-first bridge (D-007), hardening (D-009), HOME volume (D-010), worktree-per-task + serialized integration (D-013), stateless orchestrator (D-005), runs as watchable terminal sessions (D-024), worker as a separate process (D-026).

## 18. Known bugs

None open. Bugs found and fixed this session: Next 16 `allowedDevOrigins` (pages never hydrated when reached as 127.0.0.1), provider constructed during SSR, proxy matcher export name, stale container image after rebuild.

## 19. Technical debt

`CURRENT_STATE.md` "Known issues and technical debt" (12 items).

## 20. Blockers

None technical. A real Claude Code run requires a user-provided API key or CLI login.

## 21. Tested / 22. Not tested

Tested: see §6. Not tested: real Claude Code/Codex/Gemini runs; `network` connect mode on Linux; multiple workers; long-running (hours) sessions; browser on mobile; `next build` after the final UI changes (run it).

## 23. Exact current state

All work committed on `main`. Background processes from the session (orchestrator, web dev server, worker) are stopped at handoff. The `demo-project` workspace exists in the dev database; its container runs the exec-capable image and its volume holds the integrated agent commit. **The host's C: drive is full** (see `CURRENT_STATE.md`, "Incident"): Docker is read-only until space is freed, so the first action of the next session is to free disk space, restart Docker Desktop, `docker compose -p notea-dev … up -d`, and rebuild the image (the CLI layer has not been built yet). `next build` passes.

## 24. Exact next step

0. Free space on C: (or move Docker's disk image to D:), restart Docker Desktop, confirm `docker info` works.
1. `docker compose -p notea-dev -f infra/compose/docker-compose.dev.yml up -d`, `npm install`, `npm run migrate -w @notea/db`, `npm run build:image` (now includes the agent CLIs; verify with `docker run --rm --entrypoint bash notea/workspace:dev -lc 'claude --version'`).
2. Start orchestrator, web, worker (§29). Sign in, open `demo-project`, store an Anthropic key under Credentials, create a Claude Code task with a small scope, watch the `agent:` terminal tab, then review and approve.
3. Fix whatever the real CLI does differently (flags, JSON shapes) in `packages/agents/src/runtimes/claude-code.ts`; add parser fixtures from real output to `packages/agents/test/runtimes.test.ts`.

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
