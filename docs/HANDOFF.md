# Notea Workspace — Handoff

Written 2026-09-15 by Fable 5.1 (session 1) for the next implementing agent (Opus 5). This document is self-contained; the conversation that produced it is not needed.

## 1. Product summary

Self-hosted, browser-based shared development workspace: one persistent Linux container per project, shared terminals and files, several humans and several AI coding agents (any provider) working together with coordination. Personal use first; commercial later. Full definition: `PROJECT_SPEC.md`.

## 2. Current MVP goal

**M1:** "I can create a Notea Workspace in a browser and get a terminal in a remote Linux environment." M0 (the runtime path) is done and proven; M1 adds Postgres, auth, the Next.js UI with an xterm.js terminal and a file editor. Steps: `IMPLEMENTATION_PLAN.md` → M1.

## 3. Current architecture

Control plane (`apps/web`, planned) ↔ REST + API key ↔ Orchestrator (`apps/orchestrator`, done) ↔ Docker ↔ workspace container running the workspace agent (`packages/workspace-agent`, done). Browser ↔ orchestrator WebSocket bridge with short-lived JWT ↔ agent. Shared contract `packages/protocol`. Diagram and flows: `ARCHITECTURE.md` §1–3.

## 4. Technology stack

Node 24, TypeScript 5.9, npm workspaces, zod 4, ws 8, node-pty 1.1, Fastify 5, @fastify/websocket 11, dockerode 5, jose 6, esbuild, vitest 4, tsx. Planned for M1: Next.js 16, React 19, Tailwind 4, xterm.js 6, Auth.js 5 (credentials), Drizzle + postgres.js, Postgres 17.

## 5. Repository structure

See `CURRENT_STATE.md` (actual tree) and `README.md`. Rule: apps are deployable processes, packages are libraries, infra holds images/compose, docs hold the truth.

## 6. Implemented features (tested)

- Protocol v1 with validation and tests.
- Workspace agent: PTY sessions with multi-attach and scrollback, roles, file API with etags and path confinement, presence, health, token-gated WebSocket, graceful shutdown. 33 tests.
- Base workspace image (built locally as `notea/workspace:dev`).
- Orchestrator: hardened container lifecycle, connect tokens, API-key REST, WebSocket bridge. 17 tests plus a passing Docker e2e test.

## 7. Partially implemented

Nothing is half-done in code. Some designed protocol extensions are noted as "additive" (fs.changed events, term.create env, exec message) and are not started.

## 8. Not started

`apps/web`, `packages/db`, `packages/agents`, compose files for dev Postgres and production, ESLint/Prettier, previews, invites, activity feed, all agent/coordination features.

## 9. Database design

`DATABASE_SCHEMA.md`. M1 tables: users, workspaces, workspace_members, workspace_events. Later: invites, provider_credentials, agent_identities, agent_tasks, agent_runs, integration_queue.

## 10. Workspace runtime architecture

`ARCHITECTURE.md` §4 and `apps/orchestrator/src/docker/`. One container + one HOME volume per workspace; Docker is the source of truth; labels for discovery; hardening in `spec.ts`; `published` vs `network` connect modes (D-011).

## 11. Terminal architecture

`ARCHITECTURE.md` §5 and `packages/workspace-agent/src/session-manager.ts`. Sessions outlive connections; multi-attach; scrollback replay; roles; kill escalation.

## 12. Realtime architecture

`ARCHITECTURE.md` §6. One WebSocket per tab; orchestrator is a pure pipe after JWT verification; identify-first rule; JSON frames; presence derived from live connections.

## 13. AI agent architecture

`AGENT_SYSTEM.md`. Agents are participants (`kind: "agent"`); interactive CLI sessions first, headless JSON-stream runs second, custom API loop later; `AgentRuntime` interface proposed.

## 14. Provider abstraction

`AGENT_SYSTEM.md` §2 and §5: provider → credential → model → runtime → workspace → task → project. Provider adapters own env-var mapping, model catalog, prices. Credentials encrypted per user, injected per run (needs `term.create.env`, additive protocol change).

## 15. Multi-agent coordination strategy

`AGENT_SYSTEM.md` §6–7 and D-013: worktree per task, advisory scope leases (`warn|block`), single-writer integration queue (rebase → checks → fast-forward), human approvals, environment-level operations serialised.

## 16. Security model

`SECURITY_MODEL.md`. Implemented: JWT connect tokens, API key, HMAC agent tokens, identify-first, container hardening (non-root, cap-drop ALL, no-new-privileges, limits, no bind mounts), path confinement in the file API. Personal-use acceptances and the pre-commercial checklist are listed there.

## 17. Important decisions

`DECISIONS.md` D-001…D-021. Most consequential: D-003 (in-container agent), D-004 (orchestrator separate from web), D-007 (identify-first), D-009 (hardening, no sudo), D-010 (HOME volume), D-013 (worktree isolation + queue), D-014 (CLI runtimes first).

## 18. Known bugs

None known. Two test-harness mistakes were fixed during the session (ordering of presence/exit events, e2e transcript capture); the product code was correct.

## 19. Known technical debt

`CURRENT_STATE.md` "Known issues and technical debt" (11 items): ESLint missing, image size, raw scrollback replay, no backpressure handling, no fs watcher, etc.

## 20. Current blockers

None technical. Practical: Docker Desktop must be running for image build and e2e; the dev machine's port 5432 is used by another project (use 55432).

## 21. What has been tested

Unit + in-process integration (55 tests) on Windows; Docker e2e on Windows with Docker Desktop (Linux containers): create, terminal I/O, file write, stop/start persistence, read, delete. Orchestrator entry point smoke-tested as a live server (`/healthz`, API key, connect token). The browser path was verified manually in Chrome through the dev console (`DEV_CONSOLE=true`, `/dev/console?workspaceId=demo`): xterm.js terminal over the real bridge, commands executed in the container, reload re-attaches with scrollback replay. Its client script (`apps/orchestrator/src/routes/dev-console.ts`) is the reference for the M1 terminal component.

## 22. What has NOT been tested

Any browser client (no UI yet); `network` connect mode on a Linux host; multiple concurrent workspaces; long-running sessions and reconnect over hours; large output flooding; the image on arm64; running the orchestrator inside a container with the Docker socket; host reboot recovery with `unless-stopped`.

## 23. Exact current state

All source files committed on `main` (see git log). `npm test` green. `notea/workspace:dev` built locally. No `.env` file exists (copy `.env.example`). No containers or volumes of this project are left on the machine.

## 24. Exact next recommended step

`IMPLEMENTATION_PLAN.md` → **M1 Step 1: `packages/db`** (schema, dev Postgres compose on 55432, first migration, smoke test). Then Step 2 (`apps/web` with Auth.js credentials + orchestrator client), Step 3 (terminal UI). Do not start agents (M4) before M1–M3 exist.

## 25. Files to inspect first

1. `packages/protocol/src/messages.ts` — the contract everything speaks.
2. `packages/workspace-agent/src/hub.ts` and `session-manager.ts` — agent behaviour.
3. `apps/orchestrator/src/docker/spec.ts` and `workspace-runtime.ts` — container lifecycle and hardening.
4. `apps/orchestrator/src/routes/bridge.ts` — how identity reaches the agent.
5. `apps/orchestrator/test/bridge.test.ts` — the best example of driving the whole stack in-process (reuse for web tests).
6. `apps/orchestrator/test/docker.e2e.test.ts` — the real-container proof.
7. `docs/IMPLEMENTATION_PLAN.md` — what to do next.

## 26. Things Opus should NOT change

- The identify-first trust rule and the orchestrator-as-pure-pipe design (D-007).
- Container hardening defaults in `spec.ts` (D-009); if a feature needs more privileges, make it an explicit per-workspace opt-in with a decision entry.
- The HOME volume layout (`/home/dev`, `/home/dev/project`) — CLIs and docs depend on it.
- Protocol v1 message names and shapes; only add fields/messages.
- Orchestrator statelessness (no database in the orchestrator).
- The worktree-per-task coordination model (D-013) — implement it, do not replace it with shared-tree locking.

## 27. Important assumptions

- Personal use on owner-controlled hosts; collaborators are invited people.
- Docker is available on the host; Docker Desktop on Windows/macOS for development, plain Docker on a Linux VPS for M2.
- AI CLIs (Claude Code, Codex, Gemini) remain the primary agent runtimes; their headless flags must be verified at M4 time.
- Budget: the user wanted a strategic reserve; the web UI is deliberately left to the next session because it is mostly boilerplate.

## 28. Environment and setup

Prerequisites: Node ≥ 24, npm ≥ 11, Docker. On the dev machine, start Docker Desktop first. Then:

```bash
npm install
npm run typecheck && npm test
npm run build:image
npm run test:e2e -w @notea/orchestrator
cp .env.example .env   # generate secrets: openssl rand -hex 32
```

Environment variables: see `.env.example` (orchestrator: `PORT`, `HOST`, `ORCHESTRATOR_API_KEY`, `CONNECT_TOKEN_SECRET`, `AGENT_TOKEN_SECRET`, `WORKSPACE_IMAGE`, `WORKSPACE_NETWORK`, `AGENT_CONNECT_MODE`, resource defaults). Web (M1): `DATABASE_URL`, `AUTH_SECRET`, `ORCHESTRATOR_URL`, `ORCHESTRATOR_API_KEY`.

## 29. Commands

| Purpose | Command |
|---|---|
| Typecheck all | `npm run typecheck` |
| Unit/integration tests | `npm test` |
| Build agent bundle | `npm run build:agent` |
| Build workspace image | `npm run build:image` |
| Docker e2e | `npm run test:e2e -w @notea/orchestrator` |
| Run orchestrator (dev, watch) | `npm run dev:orchestrator` |
| Browser terminal without the web app | set `DEV_CONSOLE=true` in `.env`, run the orchestrator, open `http://127.0.0.1:4100/dev/console?workspaceId=demo` |
| Manual API check | see `README.md` (curl examples) |

## 30. Unresolved architectural questions

1. Where the agent runner process should live (beside the orchestrator vs inside the container) — `AGENT_SYSTEM.md` §11.
2. `node_modules` strategy for per-task worktrees.
3. Whether previews should use path-based proxying or wildcard subdomains (affects Caddy config and cookies).
4. When (if ever) to add binary terminal frames (D-006).
5. Whether to persist terminal session metadata for history/audit (currently live only).
