# Notea Workspace — Architecture

Last updated: 2026-09-15 (session 2). Status words as defined in `PROJECT_SPEC.md`.

## 1. Overview

```
   browser (human)                                   worker (agent runner)
        │ wss + connect JWT                                │ wss + connect JWT (kind: agent)
        ▼                                                  │
┌──────────────────────────────────────────┐               │
│ CONTROL PLANE  apps/web  (Next.js 16)    │   Postgres    │   apps/worker
│  Auth.js · workspaces · members · roles  │◄────────────► │   polls agent_tasks, claims, runs,
│  tasks · policy · credentials · UI       │  (packages/db)│   integrates approved tasks
└───────────────┬──────────────────────────┘               │
                │ REST + API key                           │ REST + API key (start, tokens)
                ▼                                          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ RUNTIME PLANE  apps/orchestrator (Fastify, dockerode)                          │
│  create/start/stop/delete · recreate on image change · connect tokens          │
│  WebSocket bridge: verify JWT → identify frame → byte pipe                     │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ Docker API
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ WORKSPACE CONTAINER  notea-ws-<id>   image notea/workspace:dev                 │
│  user dev · cap-drop ALL · no-new-privileges · cpu/mem/pids limits             │
│  volume notea-ws-<id>-home → /home/dev   (project at /home/dev/project,        │
│  task worktrees at /home/dev/.notea/worktrees/<taskId>, run briefs under .notea/runs)│
│  ┌──────────────────────────────────────────────────────────┐                  │
│  │ workspace agent :7070  (packages/workspace-agent)         │                  │
│  │  PTY sessions · exec processes · files · presence · roles │                  │
│  └──────────────────────────────────────────────────────────┘                  │
│  shells · dev servers · claude / codex / gemini CLIs · git                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Shared contracts: `packages/protocol` (workspace protocol v1.1 + orchestrator API types), `packages/workspace-client` (protocol client + OrchestratorClient), `packages/agents` (runtimes, git, integration, tasks).

## 2. Components

| Component | Path | Responsibility | Status |
|---|---|---|---|
| Protocol | `packages/protocol` | Zod schemas/types: identify, terminals (with env), files (`fs.changed`), exec, presence, errors, close codes; orchestrator REST types. v1.1. | implemented, tested |
| Workspace agent | `packages/workspace-agent` | In-container daemon: `SessionManager` (PTY, scrollback, multi-attach), `ProcessManager` (exec: streamed output, limits, timeouts, kill on disconnect), `FsService` (path-confined, etag), `AgentHub` (routing, roles, presence), token-gated WebSocket server. Bundled with esbuild. | implemented, tested |
| Base image | `infra/workspace-image` | Debian + Node 24 + git + build tools + ripgrep + Claude Code / Codex / Gemini CLIs + the agent; user `dev`; health check. | implemented |
| Orchestrator | `apps/orchestrator` | Container/volume/network lifecycle, hardened spec, image-change recreation on start, connect tokens (JWT) and agent tokens (HMAC), API-key REST, WebSocket bridge, optional dev console. | implemented, tested (+ Docker e2e) |
| Workspace client | `packages/workspace-client` | `WorkspaceClient` (request/reply, events, reconnect with token refresh, `runExec`), `OrchestratorClient`. Works in browsers and Node. | implemented, tested |
| Database | `packages/db` | Drizzle schema, migrations, client, migrate script. | implemented, tested |
| Control plane | `apps/web` | Next.js 16 App Router: Auth.js credentials, server-side authorization, workspaces/members, terminal/editor/file tree/presence UI, tasks panel, policy, credentials settings. | implemented, tested, verified in Chrome |
| Agents | `packages/agents` | Provider catalog, `AgentRuntime` interface, Claude Code headless runtime, generic CLI runtimes, `CommandRunner`, `GitWorktrees`, `integrateTask`, task transitions, scope overlap, brief builder, credential crypto. | implemented, tested |
| Worker | `apps/worker` | Long-lived process: claims queued tasks, runs them in worktrees through the bridge as an agent participant, persists events, commits, moves to review; integrates approved tasks; recovers stale runs. | implemented, tested, verified in Docker |

## 3. Key flows

### 3.1 Create and enter a workspace (implemented)
1. Web inserts `workspaces` + owner membership + event, calls `POST /workspaces {workspaceId, wait:true}`.
2. Orchestrator creates volume + hardened container, starts it, waits for the agent's `/healthz`.
3. Browser calls `POST /api/workspaces/:id/connect-token` (membership checked) → web asks the orchestrator for a JWT → browser opens the bridge WebSocket. `WorkspaceClient` re-requests a token on every reconnect.
4. Agent answers `hello`; the UI attaches to existing sessions or creates one; the file tree lists the project; the editor reads/writes with etags.

### 3.2 Collaboration (implemented parts)
Members with roles; viewers cannot type, resize, write or run. Presence lists connected humans and agents and which sessions they watch. `fs.changed` (API writes) shows a "changed on disk" banner in other editors. Terminal tabs show agent sessions with a badge.

### 3.3 Agent task (implemented, verified with the generic runtime)
1. Editor/owner creates a task (title, description, runtime, model, credential, scope) → status `queued`, event recorded.
2. Worker claims the oldest queued task whose scope does not overlap a running task (policy `block`).
3. Worker connects to the workspace as `kind: "agent"` (name = agent name), ensures the project is a git repo, creates worktree `/home/dev/.notea/worktrees/<taskId>` on branch `notea/task/<taskId>` from the base branch.
4. Brief written to `/home/dev/.notea/runs/<runId>/brief.md`; credential decrypted and injected into the session env only; runtime starts a terminal session running the CLI (visible to everyone).
5. Events (`started`, `message`, `tool_call`, `file_changed`, `usage`, `log`, `finished`) are persisted to `agent_run_events`; the worker heartbeats and honours cancellation.
6. On exit: leftover changes are committed as the agent; diff stat stored; task → `needs_review` (or `approved` with policy `integration: auto`).
7. Human approves → worker (one at a time per workspace) rebases the task branch onto the base branch, runs the policy's check command in the worktree, fast-forwards the base branch in the main tree, removes the worktree → `done`. Conflicts → `needs_rebase`; failing checks → `checks_failed`; both can be re-run.

### 3.4 Image upgrade (implemented)
`npm run build:image` then stop/start a workspace: the orchestrator sees the tag now points at a different image id and recreates the container on the same volume before starting it.

## 4. Runtime model
Unchanged from session 1: one container + one HOME volume per workspace, Docker as source of truth, labels for discovery, `published`/`network` connect modes, default limits 2 CPU / 4 GB / 2048 pids. New: recreation on image change; exec processes killed when their connection closes.

## 5. Terminal and exec
Terminals: node-pty, multi-attach, 256 KB scrollback replay, last-writer-wins resize, SIGHUP→SIGKILL kill, per-session env injection (allow-listed names). Exec: `child_process.spawn` (optionally via `bash -lc`), stdout/stderr streamed to the owner only, 8 MB output cap, 10 min default / 60 min max timeout, ≤16 concurrent, cwd anywhere in the container. Rule: long/watchable work → terminal session; short commands (git, checks) → exec.

## 6. Realtime
One WebSocket per tab or per worker connection; orchestrator is a pure pipe after verification; identify-first; JSON frames; presence derived from live connections; control-plane data (tasks, activity) is server-rendered and refreshed every 5 s while tasks are active.

## 7. Control plane
Next.js 16 App Router, server components + server actions, route handlers only for the connect token and Auth.js. Auth.js v5 credentials provider with scrypt hashes, JWT sessions, `proxy.ts` as a convenience gate (every action re-checks membership). Drizzle over postgres.js. Dev: root `.env` is loaded by `next.config.ts`; `allowedDevOrigins` includes 127.0.0.1.

## 8. Deployment topology
Development on Windows + Docker Desktop (verified). Production for personal use (planned, M2): one Linux VPS with compose (caddy, web, orchestrator with docker socket, worker, postgres on a control-only network). Guard the host's disk: builds, volumes and the Docker VM disk share it; a full disk turned Docker read-only during development. On this machine that risk was removed by moving Docker's data disk to D: — see §12.

## 9. The hard problems: status
| Problem | Status |
|---|---|
| Remote environments, persistence | done (containers + HOME volume; image upgrades) |
| Terminals, PTY, realtime | done |
| Multi-user | roles, presence, shared terminals, fs change notices done; invites by link, watcher, rate limiting pending |
| Concurrent edits | etag conflicts + notices; CRDT later |
| Agent execution | done for CLIs via terminal sessions; Claude Code parser needs a real run to confirm |
| Provider abstraction | done (catalog, credential env, runtimes) |
| Agent isolation / coordination | done (worktrees, scope leases, serialized integration, approvals) |
| Auth / permissions | done for personal use |
| Secrets | encrypted credentials, per-run injection, allow-listed env |
| Resource limits / sandboxing | container limits; disk quotas pending |
| Previews, deployment, observability | pending |

## 10. Stack (pinned in package.json files)
Node 24 · TS 5.9 · zod 4 · ws 8 · node-pty 1.1 · Fastify 5 · dockerode 5 · jose 6 · Next 16.3 · React 19 · Tailwind 4 · Auth.js 5 beta · Drizzle 0.45 · postgres.js 3 · Postgres 17 · xterm 6 · CodeMirror 6 · vitest 4 · esbuild · tsx. Image CLIs: claude-code 2.1.272, codex 0.154.0, gemini-cli 0.59.0.

## 11. Reversible vs expensive
Expensive: protocol shapes, identity model, HOME layout, control/runtime split, worktree-per-task + serialized integration, task status names. Reversible: worker placement, polling vs LISTEN/NOTIFY, JSON frames, UI framework details, base image contents.

## 12. Storage layout (development host)
The development machine's system drive (C:, 145 GB) is small and was repeatedly filled by Docker; the data drive (D:, 328 GB) holds everything this project can put there. Nothing of consequence belonging to Notea Workspace now lives on C:.

| What | Location | Notes |
|---|---|---|
| Source, `node_modules`, `.next`, `dist` | `D:\ClaudeProjects\notea-workspace` | the repository itself |
| Docker data disk (images, containers, volumes, build cache) | `D:\DockerDesktop\wsl\disk\docker_data.vhdx` | moved by Docker Desktop itself; see below |
| Docker Desktop VM root | `D:\DockerDesktop\wsl\main\ext4.vhdx` | WSL2 distro `docker-desktop` |
| Notea Postgres data | Docker volume `notea-dev-postgres-data` | inside the data disk, therefore on D: |
| Workspace HOME (project, worktrees, run artefacts, in-container CLI state) | Docker volume `notea-ws-<id>-home` | inside the data disk, therefore on D: |
| npm cache | `D:\NoteaWorkspaceData\npm-cache` | user-level `cache=` in `C:\Users\<user>\.npmrc` |
| Test scratch (`os.tmpdir()` in suites) | `<repo>\.tmp` | set by `vitest.shared.mjs`, git-ignored |
| Host-side backups (db dump, volume tar) | `D:\NoteaWorkspaceData\backups` | taken before the migration; not automated |

**Docker storage is shared with another project on this machine.** Moving it moved that project's containers and volumes too, which is safe (they were preserved and restarted) but means the location is not Notea-specific. The move was performed through Docker Desktop's own mechanism, not by copying files: the setting is `wslDataFolder` in the backend settings API, persisted as `CustomWslDistroDir` in `%APPDATA%\Docker\settings-store.json`. Docker Desktop stops the engine, unregisters the WSL distro, moves `docker_data.vhdx`, and re-registers the distro at the new path — it rewrites the WSL registration itself, so the location must not be changed by hand.

To move it again, or to move it back, use the Docker Desktop GUI (**Settings → Resources → Advanced → Disk image location**). Editing `settings-store.json` directly does **not** work: Docker ignores the key at startup and creates a fresh empty disk at the default location, which looks exactly like total data loss. The original disk is still there; restore by putting the old folder back and clearing the setting.

## 13. Prior art
See session-1 notes in `PROJECT_SPEC.md` §10 (Coder, Ona, Codespaces, Coterm, Clopen, Conductor, Claude Squad, cmux, GitHub Next Ace).
