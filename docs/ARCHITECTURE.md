# Notea Workspace — Architecture

Last updated: 2026-09-15. Status words as defined in `PROJECT_SPEC.md`.

## 1. Overview

```
                      browser (human)                    agent runner (later)
                            │  wss  (one socket per tab)        │
                            ▼                                   ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ CONTROL PLANE  apps/web  (Next.js 16)                          [planned]      │
│   auth · users · workspaces · memberships · tasks · activity · UI             │
│   Postgres via Drizzle (packages/db)                                          │
└───────────────┬───────────────────────────────────────────────┬───────────────┘
                │ REST + API key (server to server)             │ browser opens
                ▼                                               │ /ws/workspaces/:id?token=…
┌───────────────────────────────────────────────────────────────▼───────────────┐
│ RUNTIME PLANE  apps/orchestrator (Fastify, dockerode)          [implemented]  │
│   POST /workspaces · start · stop · delete · POST /connect-tokens             │
│   WebSocket bridge: verify JWT → identify frame → byte pipe                   │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ Docker API (unix socket / npipe)
                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ WORKSPACE CONTAINER  notea-ws-<id>   image notea/workspace:dev [implemented]  │
│   user dev (uid 1000), cap-drop ALL, no-new-privileges, cpu/mem/pids limits   │
│   volume notea-ws-<id>-home → /home/dev  (project at /home/dev/project)       │
│   ┌────────────────────────────────────────────────────────┐                  │
│   │ workspace agent  :7070   packages/workspace-agent      │                  │
│   │  PTY sessions (node-pty) · scrollback · multi-attach   │                  │
│   │  file list/read/write (etag) · presence · roles        │                  │
│   └────────────────────────────────────────────────────────┘                  │
│   shells · dev servers · AI agent CLIs (later) · git worktrees (later)        │
└───────────────────────────────────────────────────────────────────────────────┘
```

Shared contract for every arrow that carries workspace traffic: `packages/protocol` (implemented, tested).

## 2. Components

| Component | Path | Responsibility | Status |
|---|---|---|---|
| Protocol | `packages/protocol` | Zod schemas + TS types for client→agent messages, agent→client events, orchestrator REST types, close codes. Protocol version 1. | implemented, tested |
| Workspace agent | `packages/workspace-agent` | In-container daemon: PTY session manager, scrollback, multi-client attach, role checks, file service, presence, health endpoint, token-gated WebSocket. Bundled to a single CJS file with esbuild. | implemented, tested (unit + in-process integration) |
| Base image | `infra/workspace-image` | Debian bookworm + Node 24 + git + build tools + ripgrep; agent under `/opt/notea/agent`; user `dev`; health check. | implemented (built locally; see CURRENT_STATE) |
| Orchestrator | `apps/orchestrator` | Container/volume/network lifecycle via dockerode; hardened container spec; connect-token issuing/verification; WebSocket bridge; REST API guarded by API key. | implemented, tested (unit + in-process bridge test + gated Docker e2e) |
| Control plane | `apps/web` | Next.js app: auth, workspace CRUD, membership, terminal UI (xterm.js), file tree/editor, later tasks and activity. | planned (M1) |
| Database | `packages/db` | Drizzle schema + migrations for Postgres. | designed (`DATABASE_SCHEMA.md`) |
| Agent layer | `packages/agents` (proposed) | Provider adapters, agent runtimes, task briefs, coordinator. | designed (`AGENT_SYSTEM.md`) |

## 3. Key flows

### 3.1 Create and enter a workspace (M0 path, implemented at the API level)

1. Control plane inserts a `workspaces` row (M1) and calls `POST /workspaces {workspaceId}` on the orchestrator with the API key.
2. Orchestrator ensures the `notea-workspaces` bridge network, creates volume `notea-ws-<id>-home`, builds the hardened container spec (`src/docker/spec.ts`), creates and starts the container, then polls the agent's `/healthz` until it answers.
3. Browser asks the control plane to open the workspace; the control plane calls `POST /connect-tokens {workspaceId, userId, name, role}` and hands the browser a 5-minute JWT plus the WebSocket path.
4. Browser opens `wss://…/ws/workspaces/<id>?token=…`. The orchestrator verifies the JWT (issuer, audience, expiry, workspace match), resolves the agent endpoint, opens an upstream WebSocket to the agent with the per-workspace agent token, sends one `identify` frame, then pipes bytes both ways.
5. The agent answers `hello` (protocol version, existing sessions, presence). The browser sends `term.create`; output streams as `term.output`.

### 3.2 Reconnect

Sessions live in the agent, not in the connection. A browser that reconnects sends `term.attach {sessionId}` and receives the scrollback buffer (last 256 KB of raw output by default) followed by live output. Orchestrator restarts do not kill sessions. Container restarts do (sessions are process state; files persist on the volume).

### 3.3 Two humans (M3; agent side implemented)

Both connect with their own connect tokens. The agent broadcasts `presence` (who is connected, which sessions each is attached to) and `term.opened` / `term.exit` to everyone; output only goes to attached clients. Roles are enforced in the agent per message (`viewer` cannot type, resize, create, kill, or write files).

### 3.4 An AI agent runs a task (M4/M5; designed)

See `AGENT_SYSTEM.md`. In short: the control plane creates a task and a worktree, mints a connect token with `kind: "agent"`, and an agent runner (a process next to the orchestrator, or later inside the container) creates a tagged terminal session that runs the agent CLI in the worktree. Everyone can watch it. Completion posts a branch to the integration queue.

## 4. Runtime model

- **One container per workspace**, image `notea/workspace:dev` by default (per-project images later). Name `notea-ws-<workspaceId>`, labels `notea.managed=true`, `notea.workspace.id=<id>`, `notea.image=<image>`.
- **One named volume per workspace** mounted at `/home/dev`. HOME persists shell history, npm caches, `~/.claude`/tool logins and the project at `/home/dev/project`. The container filesystem is disposable.
- **Docker is the source of truth for runtime state.** The orchestrator caches nothing; `inspect` maps Docker states to `creating | starting | running | stopping | stopped | error | unknown`. Restart policy `unless-stopped` means workspaces come back after a host reboot without orchestrator involvement.
- **Resource limits** per container: default 2 CPUs, 4096 MB RAM (no swap), 2048 pids, 256 MB `/dev/shm`. Overridable per workspace at creation.
- **Networking:** containers sit on the `notea-workspaces` bridge network and have internet egress (needed for git, npm, model APIs). The agent port 7070 is reachable in one of two ways (`AGENT_CONNECT_MODE`): `network` (orchestrator on Linux connects to the container IP) or `published` (agent port published on `127.0.0.1:<random>`; required with Docker Desktop on Windows/macOS where container IPs are not routable from the host). `auto` picks by platform.
- **Workspace id** is a slug/UUID matching `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`; the control plane chooses it.

## 5. Terminal architecture

- The agent spawns PTYs with node-pty (`xterm-256color`, login shell `/bin/bash -l`, cwd `/home/dev/project`, environment inherited minus `NOTEA_AGENT_TOKEN`).
- `SessionManager` owns sessions: create, attach/detach (many clients per session), input, resize (last writer wins), kill (SIGHUP then SIGKILL after 5 s), list. Max 32 sessions per workspace by default.
- A `ScrollbackBuffer` per session keeps the last N bytes (256 KB) of raw output and is replayed on attach. Raw replay reproduces the screen well enough for shells and most TUIs; a headless terminal emulator serialising exact screen state is a documented improvement (D-021).
- Browser side (M1): xterm.js 6 with fit + WebGL addons; one `WebSocket` per tab multiplexes all terminals by `sessionId`.
- The PTY abstraction (`src/pty.ts`) is injectable, so the session manager and hub are unit-tested with a fake PTY on Windows; the real PTY is exercised only inside Linux containers (Docker e2e test).

## 6. Realtime architecture

- Transport: WebSocket, JSON text frames, discriminated by `type`. Requests carry `reqId`; replies echo it; events do not have one.
- **Orchestrator is a pure pipe.** After JWT verification it does not parse traffic. Its only originated frame is `identify`; the agent honours `identify` only as the first frame of a connection, so a browser cannot re-identify (tested in `bridge.test.ts`).
- Client→agent frames are validated with zod in the agent (`parseClientMessage`); invalid frames on an identified connection yield an `error` message, not a disconnect.
- Presence is derived from live connections; there is no presence state to reconcile.
- Planned additions (M3): `fs.changed` events from a watcher (with ignore rules for `node_modules`, `.git`), typing/cursor presence for the editor, and control-plane events (workspace list, task status) over a separate lightweight channel (SSE) from `apps/web`.

## 7. Control plane (planned, M1)

- **Next.js 16 (App Router), TypeScript, Tailwind 4.** Server components for pages; route handlers for the small internal API; server actions for mutations.
- **Auth.js v5** with a Credentials provider (email + argon2 password) and JWT sessions; OAuth providers can be added by configuration later. Users are seeded with a CLI script for personal use.
- **Postgres + Drizzle** (`DATABASE_SCHEMA.md`).
- **Orchestrator client**: a thin typed client over the REST API using `ORCHESTRATOR_URL` and `ORCHESTRATOR_API_KEY`. The browser never talks to the orchestrator's REST API, only to its WebSocket endpoint with a connect token.
- Pages: sign in, workspace list, workspace view (terminals, file tree, editor, presence), settings (provider credentials later).

## 8. Deployment topology

- **Development (today):** Windows 11 + Docker Desktop. Orchestrator runs on the host with `AGENT_CONNECT_MODE=published`; workspace containers are Linux containers in Docker Desktop. The image is built from the repository root.
- **Production for personal use (M2, planned):** one Linux VPS running `docker compose` with: `caddy` (TLS, reverse proxy), `web`, `orchestrator` (with `/var/run/docker.sock` mounted; it is trusted infrastructure), `postgres`. Workspaces are sibling containers created through the socket, on the `notea-workspaces` network; Postgres lives on a separate `notea-control` network that workspaces cannot reach. Only 443 is exposed.
- Migration path: multiple runtime hosts = multiple orchestrators keyed by a `runtimeHostId` on the workspace row; Kubernetes only if a real scheduling need appears.

## 9. The hard problems: now vs later

| # | Problem | Now (M0–M2) | Later |
|---|---|---|---|
| A/B | Remote environments, containers vs VMs | Docker containers on one host. | gVisor/Kata/Firecracker for untrusted tenants; per-project images. |
| C | Persistent workspaces | Named volume at `/home/dev`; container disposable. | Snapshots to object storage; volume quotas; backup/restore. |
| D/E | Terminal streaming, PTY | Done: in-container node-pty, multi-attach, scrollback. | Binary frames; flow control; exact screen serialisation. |
| F | Realtime | WebSocket bridge + JSON protocol v1. | SSE for control-plane events; possibly WebRTC data channels for very low latency. |
| G | Multi-user | Identity + roles + presence are in the protocol and agent today. | Invites, UI, per-workspace policies. |
| H | Concurrent file edits | Etag conflict detection on write. | CRDT (Yjs) for the editor; file watcher events. |
| I | Agent execution | Designed: agent CLIs in tagged terminals. | Headless runs with structured event streams. |
| J | Provider abstraction | Designed: provider → credential → model → runtime. | Cost tracking, capability matrix, fallbacks. |
| K | Agent isolation | Designed: git worktree per task; same container. | Sibling container per agent sharing the volume; per-agent credentials. |
| L | Agent coordination | Designed: scope leases + serialised integration queue. | Automatic conflict repair tasks, policy engine. |
| M | Authentication | Connect JWTs + API key today; Auth.js credentials in M1. | OAuth/SSO, sessions table, device management. |
| N | Permissions | Roles enforced in the agent per message. | Path-level and action-level policies; agent-specific permissions. |
| O | Secrets / API keys | `.env` for service secrets; agent token never enters shells. | Encrypted credential store; per-run injection; rotation. |
| P/Q | Resource limits, sandboxing | cpu/mem/pids/shm limits; cap-drop ALL; no-new-privileges; non-root; no host mounts. | Disk quotas; seccomp profiles; user namespaces; runtime sandboxes. |
| R | Network security | Loopback-only published ports; API key; TLS via Caddy in M2. | Egress policies per workspace; private networks per tenant. |
| S | Project persistence | Volume + git. | Snapshots, export, import from git URL at creation. |
| T | Previews | Not yet. | Port detection in agent + authenticated proxy `https://<ws>-<port>.host`. |
| U | Deployment | Not yet. | Deploy adapters (Vercel, Docker hosts). |
| V | Observability | Structured JSON logs (agent) and pino (orchestrator); health endpoints. | Metrics, tracing, activity feed as audit trail. |
| W | Failure recovery | Docker restart policy; stateless orchestrator; reconnect + re-attach. | Health-based auto-restart of the agent; snapshots. |

## 10. Technology stack (pinned in `package.json` files)

Node 24 · TypeScript 5.9 · npm workspaces · zod 4 · ws 8 · node-pty 1.1 · Fastify 5 + @fastify/websocket 11 · dockerode 5 · jose 6 · esbuild 0.28 · vitest 4 · tsx 4. Planned: Next.js 16, React 19, Tailwind 4, xterm.js 6, Auth.js 5, Drizzle 0.45, postgres.js, Postgres 17.

## 11. Reversible vs expensive decisions

**Expensive to change later (get right now):** protocol shape and identity model; one-container-per-workspace with a persistent HOME volume; control plane / runtime plane split; agents as first-class participants; worktree-based agent isolation; ids and roles in the data model.

**Reversible:** Fastify vs anything else; npm vs pnpm; JSON vs binary frames; Auth.js vs another auth library; the specific base image contents; `published` vs `network` connect mode; where the agent runner process lives.

## 12. Prior art detail

- **Coder / Gitpod (Ona) / Codespaces / Daytona / DevPod:** container-per-workspace with an in-workspace agent binary and a browser or IDE front end. Notea's agent is the same idea, deliberately minimal, TypeScript, and shared by humans and AI agents.
- **Coterm:** macOS app for two developers to pair on Claude Code sessions with shared terminal/browser, self-hosted relay on Cloudflare (GPL). Confirms demand for shared agent terminals; single-platform and not a persistent environment.
- **Clopen:** all-in-one workspace for multiple agent CLIs with chat, terminal, git, preview and real-time collaboration. Closest feature overlap; local-first rather than a shared remote environment.
- **Conductor, Claude Squad, Vibe Kanban, cmux:** parallel-agent runners on one developer's machine using worktrees and tmux. Notea reuses the worktree-per-task pattern and adds multi-human, remote and persistent.
- **GitHub Next Ace:** research prototype of a realtime multiplayer agent workspace on shared cloud computers. Validates the concept; not available as a product.

Sources consulted on 2026-09-15: coterm.cc, github.com/myrialabs/clopen, github.com/bradAGI/awesome-cli-coding-agents, tembo.io/blog/ai-agent-orchestration-tools, augmentcode.com/tools/open-source-agent-orchestrators, nimbalyst.com (worktree tool comparisons), github.com/github/app/issues/123 (Ace).
