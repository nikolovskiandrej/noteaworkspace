# Notea Workspace — Current State

Last updated: 2026-09-15, end of session 4 (migration verification + agent-pipeline hardening). Update this file whenever reality changes.

## One-line status

**M0 (runtime), M1 (control plane + browser UI) and the core of M3 (agent tasks in isolated worktrees with human-approved, serialized integration) are implemented, tested, and verified end to end in Docker — including the browser UI, real cancellation, real timeouts, and real runs of all three agent CLIs. M2 collaboration is partially done (membership, roles, shared terminals, presence, file-change notices). Storage lives on D: (session 3) and was re-verified independently in session 4. The one thing that has never happened is an *authenticated* agent run: no provider credential exists on this machine, so every CLI stops at its own auth check.**

## Repository (actual contents)

```
notea-workspace/
├── AGENTS.md, CLAUDE.md, README.md, .env.example, .gitattributes, .editorconfig
├── package.json (npm workspaces), tsconfig.base.json
├── apps/
│   ├── orchestrator/   runtime service: Docker lifecycle, connect tokens, WS bridge, dev console   [implemented, tested]
│   ├── web/            Next.js 16 control plane: auth, workspaces, members, terminal, editor,
│   │                   tasks panel, policy, credentials settings                                  [implemented, tested, verified in Chrome]
│   └── worker/         background worker: runs queued tasks, integrates approved ones           [implemented, tested, verified in Docker]
├── packages/
│   ├── protocol/       protocol v1.1 (terminals, files, exec, presence) + orchestrator API types  [implemented, tested]
│   ├── workspace-agent/ in-container daemon (PTY sessions, processes, files, presence)          [implemented, tested]
│   ├── workspace-client/ protocol client (browser + Node) with reconnect; OrchestratorClient    [implemented, tested]
│   ├── db/             Drizzle schema + migrations 0000/0001, client, migrate script            [implemented, tested]
│   └── agents/         providers, runtimes (Claude Code headless, generic CLIs), git worktrees,
│                       integration, task transitions, scopes, briefs, credential crypto        [implemented, tested]
├── infra/
│   ├── workspace-image/ Dockerfile (Debian + Node 24 + git + build tools + claude/codex/gemini CLIs + agent)
│   └── compose/docker-compose.dev.yml   dev Postgres on 127.0.0.1:55432
└── docs/
```

## Verified on 2026-09-15 (Windows 11, Node 24, npm 11, Docker Desktop 29.5)

| Check | Result |
|---|---|
| `npm run typecheck` | OK across all 9 workspaces |
| `npm test` (no `DATABASE_URL`) | OK, exit 0: agents 28 · protocol 6 · workspace-agent 42 · workspace-client 6 · orchestrator 21 (+1 e2e skipped) · web 13 (+7 skipped) · db and worker skip themselves |
| `npm test` for `@notea/db` and `@notea/worker` with `DATABASE_URL` | OK: db 1 · worker 8 (task lifecycle, cancellation, stale-run recovery, concurrency limit, integration lease). Run against a throw-away database (`CREATE DATABASE notea_test`), because the worker suite deletes tasks in `beforeEach`. |
| `npm run test:e2e -w @notea/orchestrator` (`NOTEA_E2E_DOCKER=1`) | OK: 18 tests — container create → terminal I/O → exec with injected env → file persistence across restart → cleanup |
| `npm run build:image` | OK: `notea/workspace:dev` rebuilt in 2.9 min and verified to contain claude-code 2.1.272, codex-cli 0.154.0, gemini-cli 0.59.0, Node 24.21, git 2.39. The build consumed **0 bytes of C:** and 1.75 GB of D: (storage migration, below). |
| `npm run build -w @notea/web` | OK: production `next build` compiles and prerenders 5 routes |
| `npm run dev -w @notea/web` | OK: ready in ~1.5 s. Routes: `/sign-in` 200, `/` and `/workspaces/<slug>` 307 to `/sign-in` when signed out. (There is no `/signin` route — it 307s to `/sign-in` through the proxy gate.) |
| Real CLI runs (all three, in Docker) | OK, all reach their credential check and stop: Claude `failed` exit 1 with summary "Not logged in · Please run /login"; Codex `failed` exit 1 after five 401s against `api.openai.com`; Gemini `failed` exit 41 "set an Auth method". Parsers produced structured events for all three. |
| Cancellation (real, in Docker) | OK: a running task with `sleep 300` was cancelled from the database; within one heartbeat the run ended `cancelled`, the container process was gone, and events recorded started → log → finished |
| Timeout (real, in Docker) | OK: a task with `max_minutes = 1` ended exactly 60 s after start with outcome `timeout`, its `sleep 600` killed, task `failed` |
| Container recreation | OK: after the rebuild, stop → start replaced the container (new id, image id now matches the tag) and the HOME volume was preserved byte-for-byte (103 MB, 5597 files, all three worktrees) |
| Agent pipeline (Docker, worker + orchestrator) | OK: a `generic-cli` task ran queued → running (worktree `notea/task/<id>`) → needs_review (diff stat) → approved → integrating (rebase, ff-merge into `main`) → done; the commit is visible in `git log` inside the container |
| Browser (Chrome) | OK, re-driven in session 4 on the migrated storage: signed-in session survived the migration, workspace page loads `RUNNING`, file tree lists the project, editor opened `STORAGE_MIGRATION.md` and **Save** wrote through to the container filesystem (confirmed with `git status` inside it), a new terminal ran commands as `dev` in `/home/dev/project`, presence showed **People 1**, and the tasks panel listed all tasks with their actions |

Without `DATABASE_URL`, the db/web/worker database suites skip themselves. Without `NOTEA_E2E_DOCKER=1`, the orchestrator's Docker e2e skips itself.

## Implemented behaviour (summary)

- **Protocol v1.1**: identify-first trust, terminals (create/attach/detach/input/resize/kill/list, per-session env), files (list/read/write with etag, `fs.changed` broadcast), exec (start/stdin/kill with streamed output, env allow-list, timeouts, output caps, killed on disconnect), presence, roles.
- **Orchestrator**: hardened containers (non-root, cap-drop ALL, no-new-privileges, cpu/mem/pids limits, no bind mounts), HOME volume, `published`/`network` connect modes, connect JWTs, API-key REST, WebSocket bridge, **container recreation on start when the image was rebuilt**, dev console.
- **Web**: Auth.js credentials (scrypt), server-side membership roles (owner/editor/viewer) on every action, workspaces CRUD, members, terminal tabs (agent sessions badged), CodeMirror editor with conflict detection and change notices, presence, activity, tasks panel (create/approve/cancel/requeue/delete, run event log, policy editor), credentials settings (AES-256-GCM).
- **Agents**: provider catalog and credential env mapping; `AgentRuntime` interface; Claude Code headless runtime (`claude -p … --output-format stream-json`, parsed defensively); Codex/Gemini/generic runtimes via `GenericCliRuntime`; runs execute in watchable terminal sessions; git worktree per task; brief generator; scope overlap detection; task state machine; serialized integration (rebase → optional check command → fast-forward).
- **Worker**: polling loop, scope-lease-aware claiming, per-run heartbeat and cancellation, event persistence, auto-commit of leftover changes, review/auto-approve per policy, integration with per-workspace mutex, stale-run recovery.

## Known issues and technical debt

1. **No authenticated agent run has ever succeeded.** The three CLI runtimes have been executed for real against the installed versions (2.1.272 / 0.154.0 / 0.59.0) and their command lines are correct — each starts, is reached by the parser, and fails at the credential boundary (Codex: 401 from `api.openai.com`; Gemini: exit 41, "set an Auth method"; Claude: "Not logged in · Please run /login"). No API key exists on this machine and `provider_credentials` is empty, so this is a missing-credential blocker, not a defect. Store a key under **Credentials** or log a CLI in from a workspace terminal to get past it.
2. **A collaborator can read the owner's provider key during a run.** Verified, not theoretical: the agent process runs as the same uid as every human shell in the container, so `grep -a ANTHROPIC_API_KEY /proc/<pid>/environ` works. See `SECURITY_MODEL.md` → Provider credentials for the demonstration and the three possible fixes. Until one is implemented, only share a workspace with people you would trust with the key attached to its tasks.
3. **Deleting a task leaves its worktree and branch in the container.** `deleteTask` removes the database row only; `/home/dev/.notea/worktrees/<taskId>` and `notea/task/<taskId>` survive with nothing referencing them. Worktrees of *failed* tasks are kept on purpose (so "Run again" continues on the same branch) — this is specifically about deletion. The clean fix is a reaper on the worker tick that removes worktrees whose task id no longer exists; the web app has no path into the container today.
4. **No ESLint/Prettier** (D-018).
5. **Image size** (Node + build tools + three CLIs); a slim variant is possible.
6. **`fs.changed` covers API writes only**; terminal-side edits are caught by the etag check at save time, not proactively.
7. **Tasks listing does N+1 queries** (fine for personal scale).
8. **Run exactly one worker process.** Claims are optimistic (`UPDATE … WHERE status='queued'`) and the concurrency limit is counted in-process, so it is per worker, not global. Overlapping workers from earlier sessions once produced a misleading result: a worker running pre-fix code claimed a requeued task and reported an authentication failure as `completed`.
9. **No automated Docker e2e for the worker pipeline** (the lifecycle, cancellation and timeout paths were driven by hand against real containers in session 4; the automated suite covers the logic with fakes).
10. **Windows development** relies on `published` connect mode; `network` mode is untested on a Linux host.
11. **Dev console** (`DEV_CONSOLE=true`) mints tokens without auth; keep it off on reachable hosts.
12. Old server-side artefacts: none known. Sessions do not survive container restarts (by design).
13. **The npm cache and Docker storage locations are machine-level settings**, not repository settings (`ARCHITECTURE.md` §12). A fresh clone on another machine keeps that machine's defaults; only `.tmp` for tests travels with the repository.

## Host disk: incident (session 2) and resolution (session 3)

**Session 2 incident.** The Windows C: drive was at 99% (Docker Desktop's VM disk and caches live there by default). Repeated image builds used the rest; Docker's VM remounted read-only, the dev Postgres started failing queries, the worker crashed, and image builds failed. Immediate recovery: temp logs and npm cache cleaned, Docker Desktop restarted, dev Postgres restarted. C: was still at ~1 GB free at the end of that session.

**Session 3 resolution: storage migrated to D:.** The cause was structural, not incidental, so the storage layout was changed rather than cleaned up again. Docker Desktop's data disk was moved to `D:\DockerDesktop\wsl` through Docker's own migration routine, and the npm cache and test scratch directory were pointed at D: as well. Layout and procedure are documented in `ARCHITECTURE.md` §12.

Result: **C: went from 1.01 GB free to 22.19 GB free; D: from 309.32 GB to 293.69 GB.** The decisive check is that a full `npm run build:image` now consumes 0 bytes of C:. Postgres data, the workspace HOME volume, and the other project's containers and volumes were all preserved and verified after the move (row counts, database size, file counts, and git history all identical to the pre-migration baseline).

Not moved, and why: `C:\Users\<user>\.claude` (240 MB) and `.codex` (840 MB) belong to the owner's own CLI tools, not to this project; `ms-playwright` (1.35 GB) is not a dependency of this repository; VS Code, browsers and other applications on C: are unrelated. Docker Desktop keeps ~30 MB of its own logs in `%LOCALAPPDATA%\Docker\log`, which is left alone.

## Environment facts for this machine (do not change other projects)

- `D:\ClaudeProjects` contains unrelated projects; only `notea-workspace` belongs to this product.
- Docker Desktop also runs another project's containers (`ai-creator-automation-*`, Postgres on host port 5432). Never prune, stop or remove them. This project's Postgres is `notea-dev-postgres` on 55432 (compose project `notea-dev`).
- **Docker's data disk lives on D: (`D:\DockerDesktop\wsl`), not on C:.** It is shared with that other project. Change it only through the Docker Desktop GUI; see `ARCHITECTURE.md` §12.
- The npm cache is `D:\NoteaWorkspaceData\npm-cache` (user-level `cache=` in `C:\Users\<user>\.npmrc`). To undo: `npm config delete cache`.
- Pre-migration backups are kept at `D:\NoteaWorkspaceData\backups`: a `pg_dump` of the dev database, a tar of the workspace HOME volume, and the original `settings-store.json`. They are point-in-time copies from 2026-09-15 and are not refreshed automatically.
- Local users created by the `create-user` script: `andrej@notea.local` and `collaborator@notea.local`, password `notea-dev-password` (change them).
- A `demo-project` workspace exists in the dev database; its container is `notea-ws-ebc7f427-1561-4fe5-8103-efda876f0a7d` (start/stop from the UI).
