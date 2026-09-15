# Notea Workspace

A self-hosted, browser-based shared development workspace where people and AI coding agents work on the same project at the same time: persistent Linux environments, shared terminals, files, presence, and (later) coordinated multi-agent work.

Status: **M0 foundation complete** (runtime path proven end to end); the web UI is the next milestone. Read `docs/HANDOFF.md` first if you are continuing development.

## Repository layout

```
apps/
  orchestrator/       Runtime service: Docker lifecycle + WebSocket bridge (Fastify)   [implemented]
  web/                Control plane UI + API (Next.js)                                   [planned, M1]
packages/
  protocol/           Shared message contract (zod schemas + types)                      [implemented]
  workspace-agent/    Daemon inside every workspace container (PTY, files, presence)     [implemented]
  db/                 Drizzle schema + migrations (Postgres)                             [planned, M1]
infra/
  workspace-image/    Dockerfile for the base workspace image                            [implemented]
docs/                 Specification, architecture, decisions, roadmap, handoff
```

## Quick start (development on Windows/macOS/Linux with Docker)

```bash
npm install                                   # Node 24+, npm 11+
npm run typecheck && npm test                 # unit + in-process integration tests (no Docker needed)
npm run build:image                           # builds notea/workspace:dev (needs Docker)
npm run test:e2e -w @notea/orchestrator       # real container end-to-end test
```

Run the orchestrator:

```bash
cp .env.example .env                          # fill the three secrets (openssl rand -hex 32)
npm run dev:orchestrator                      # http://127.0.0.1:4100
```

Create a workspace and get a connect token (replace the key):

```bash
curl -s -X POST http://127.0.0.1:4100/workspaces -H "authorization: Bearer $ORCHESTRATOR_API_KEY" \
  -H "content-type: application/json" -d '{"workspaceId":"demo"}'
curl -s -X POST http://127.0.0.1:4100/connect-tokens -H "authorization: Bearer $ORCHESTRATOR_API_KEY" \
  -H "content-type: application/json" -d '{"workspaceId":"demo","userId":"u1","name":"Andrej","role":"owner"}'
```

Then open `ws://127.0.0.1:4100/ws/workspaces/demo?token=<token>` with any WebSocket client and send
`{"type":"term.create","reqId":"1","cols":80,"rows":24}` followed by `{"type":"term.input","sessionId":"<id>","data":"ls\r"}`.
The protocol is documented in `packages/protocol/src/messages.ts`.

Or use the browser dev console (development on localhost only): set `DEV_CONSOLE=true` in `.env`, start the
orchestrator and open `http://127.0.0.1:4100/dev/console?workspaceId=demo`. It creates the workspace if needed and
mounts an xterm.js terminal on the real bridge.

## Documentation

| File | Purpose |
|---|---|
| `docs/HANDOFF.md` | Start here: exact state, next step, what not to change |
| `docs/CURRENT_STATE.md` | What exists, what is tested, known issues |
| `docs/PROJECT_SPEC.md` | Product definition, concepts, milestones, prior art |
| `docs/ARCHITECTURE.md` | Components, flows, runtime/terminal/realtime design, hard problems |
| `docs/DECISIONS.md` | Decision log (options, choice, why, revisit triggers) |
| `docs/MVP_ROADMAP.md` | Milestones with acceptance tests |
| `docs/IMPLEMENTATION_PLAN.md` | Ordered steps for the next milestones |
| `docs/AGENT_SYSTEM.md` | Multi-agent architecture and provider abstraction |
| `docs/SECURITY_MODEL.md` | Threat model, controls, what changes before commercial use |
| `docs/DATABASE_SCHEMA.md` | Postgres schema (Drizzle) |
