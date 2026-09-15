# Notea Workspace

A self-hosted, browser-based shared development workspace where people and AI coding agents work on the same project at the same time: persistent Linux environments, shared terminals, files, presence, and agent tasks that run in isolated git worktrees and are integrated only after review.

Status: **M0–M1 done, agent task pipeline (M3/M4) working end to end**. Read `docs/HANDOFF.md` first if you are continuing development.

## Repository layout

```
apps/
  orchestrator/       Runtime service: Docker lifecycle + WebSocket bridge (Fastify)
  web/                Control plane: auth, workspaces, members, terminal, editor, tasks (Next.js 16)
  worker/             Runs queued agent tasks in worktrees; integrates approved ones
packages/
  protocol/           Shared message contract (zod schemas + types), protocol v1.1
  workspace-agent/    Daemon inside every workspace container (PTY, exec, files, presence)
  workspace-client/   Protocol client for browsers and Node + orchestrator REST client
  db/                 Drizzle schema + migrations (Postgres)
  agents/             Providers, agent runtimes (Claude Code, generic CLIs), git worktrees, integration
infra/
  workspace-image/    Dockerfile for the base workspace image (includes claude / codex / gemini CLIs)
  compose/            docker-compose.dev.yml (Postgres on 127.0.0.1:55432)
docs/                 Specification, architecture, decisions, roadmap, handoff
```

## Quick start (development; Docker Desktop or Docker Engine required)

```bash
npm install                                    # Node 24+, npm 11+
cp .env.example .env                           # fill the secrets: openssl rand -hex 32
docker compose -p notea-dev -f infra/compose/docker-compose.dev.yml up -d
npm run migrate -w @notea/db
npm run create-user -w @notea/web -- you@example.com "Your Name" a-strong-password
npm run build:image                            # builds notea/workspace:dev (a few minutes)

npm run dev:orchestrator                       # terminal 1 → http://127.0.0.1:4100
npm run dev -w @notea/web                      # terminal 2 → http://127.0.0.1:3000
npm run dev -w @notea/worker                   # terminal 3 (agent tasks)
```

Sign in, create a workspace, open a terminal, edit files. To run an agent task: store a provider key under **Credentials** (needs `CREDENTIALS_KEY` in `.env`) or log in to a CLI from a workspace terminal, then use **+ Task** in the workspace's Tasks panel. Finished tasks wait for **Approve & integrate**; the worker rebases, runs the policy's check command and fast-forwards the base branch.

After rebuilding the image, stop and start a workspace: the orchestrator recreates its container on the new image while keeping the volume.

## Storage

Everything this project stores — source, `node_modules`, Docker images, containers, volumes, build cache, the dev database and the npm cache — is heavy, and on a small system drive it will fill it. On the development machine it all lives on the data drive (D:); `docs/ARCHITECTURE.md` §12 documents the exact locations and how Docker's data disk was moved there.

Two of those are machine-level settings rather than repository settings, so a fresh clone elsewhere keeps that machine's defaults:

```bash
npm config get cache        # this machine: D:\NoteaWorkspaceData\npm-cache
# Docker's data disk: Docker Desktop → Settings → Resources → Advanced → Disk image location
```

Test scratch directories do travel with the repository: `vitest.shared.mjs` points `TMPDIR`/`TEMP`/`TMP` at `<repo>/.tmp` so suites never write to the system temp directory.

## Tests

```bash
npm run typecheck
npm test                                                               # db-backed suites skip without DATABASE_URL
npm run test:e2e -w @notea/orchestrator                                # real container end to end

# The db and worker suites need a database. Use a throw-away one: the worker
# suite clears tasks in beforeEach, so never point it at the dev database.
docker exec notea-dev-postgres psql -U notea -d postgres -c 'CREATE DATABASE notea_test'
DATABASE_URL=postgres://notea:notea@127.0.0.1:55432/notea_test npm test -w @notea/db -w @notea/worker
docker exec notea-dev-postgres psql -U notea -d postgres -c 'DROP DATABASE notea_test'
```

## Documentation

| File | Purpose |
|---|---|
| `docs/HANDOFF.md` | Start here: exact state, next step, what not to change |
| `docs/CURRENT_STATE.md` | What exists, what is tested, known issues |
| `docs/PROJECT_SPEC.md` | Product definition, concepts, milestones, prior art |
| `docs/ARCHITECTURE.md` | Components, flows, runtime/terminal/realtime/agent design |
| `docs/AGENT_SYSTEM.md` | Multi-agent architecture as implemented |
| `docs/DECISIONS.md` | Decision log |
| `docs/MVP_ROADMAP.md` | Milestones and status |
| `docs/IMPLEMENTATION_PLAN.md` | Ordered next steps |
| `docs/SECURITY_MODEL.md` | Threat model, controls, pre-commercial checklist |
| `docs/DATABASE_SCHEMA.md` | Postgres schema |
