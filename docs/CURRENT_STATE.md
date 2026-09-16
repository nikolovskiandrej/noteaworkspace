# Notea Workspace — Current State

Last updated: 2026-09-16, end of session 7 (verification, completion and deployment readiness). Update this file whenever reality changes.

## One-line status

**M0 (runtime), M1 (control plane + browser UI) and the core of M3 (agent tasks in isolated worktrees with human-approved, serialized integration) are implemented, tested, and verified end to end in Docker — including the browser UI, real cancellation, real timeouts, and real runs of all three agent CLIs. M2 collaboration is partially done. Session 5 added the worktree/branch reaper (D-038). Session 6 closed the credential exposure: every agent process now runs as the Unix uid of the member whose task it is (D-039), and a credential carries its authentication mode so a Claude subscription can never silently become metered API usage (D-040). Session 7 verified that independently against a live container, committed the work session 6 had left uncommitted, prepared the repository for GitHub and Vercel, and — finally — **ran the first authenticated agent task end to end**: a real Claude Code process under a Claude subscription token wrote `CHANGELOG.md`, committed it, and the task went review → approval → integration → reaped, with the credential never appearing in a log, an event, a diff or the database. The last long-standing blocker is closed.**

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
│   ├── compose/docker-compose.dev.yml   dev Postgres on 127.0.0.1:55432
│   └── deploy/          production templates: systemd units, Caddyfile, Postgres compose, vps.env.example
└── docs/
```

## Verified on 2026-09-16 (Windows 11, Node 24, npm 11, Docker Desktop 29.5)

| Check | Result |
|---|---|
| `npm run typecheck` | OK across all 9 workspaces |
| **First authenticated Claude Code run (real, end to end)** | **OK, 2026-09-16.** Task "Claude: add a CHANGELOG entry" (`claude-sonnet-5`, scope `CHANGELOG.md`, 5-minute cap) with a `subscription` credential. The worker resolved it as `authMode: subscription`, set **only** `CLAUDE_CODE_OAUTH_TOKEN` and **cleared** `ANTHROPIC_API_KEY`, and started the process as `agentUid 20003`. 26 run events: real `tool_call`s (`Bash` ×6 exploring the repo, `Write`), a `file_changed`, assistant messages, `usage` (1647 output tokens) and one `finished` `completed`, exit 0. `CHANGELOG.md` was written **owned by uid 20003**, committed as `644178a`, diff stat `1 file changed, 7 insertions(+)`; approved by Andrej, rebased and fast-forwarded to `main` as `a83cffe`, then the reaper deleted exactly that merged branch. Zero `sk-ant-` matches in the orchestrator log, worker log, run events, tasks, runs, workspace events or the container's entire git history. |
| `npm test` with `DATABASE_URL` (throw-away `notea_test`) | OK: **167 passed, 3 skipped** — agents 42 · db 1 · protocol 6 · workspace-agent 42 · workspace-client 6 · orchestrator 29 (+3 Docker e2e skipped in this mode) · web 20 · worker 21 |
| Credential isolation (independent, live container) | OK, re-proved by hand in session 7 rather than trusted from the suite: two processes as uid 20003 and 20004 each holding a distinct marker key. Each reads its own `/proc/<pid>/environ` (so the marker is provably present); **uid 20003 → 20004, uid 20004 → 20003 and `dev` → both all fail with `Permission denied`**. The session-5 attack `grep -a ANTHROPIC_API_KEY /proc/<pid>/environ` no longer returns anything. |
| Hardening not traded away for it | OK: an agent process reports `CapPrm/CapEff/CapBnd = 0000000000000000`, `NoNewPrivs: 1`; `setpriv --reuid=0` → `Operation not permitted`; `mount -o remount,hidepid=2 /proc` → `must be superuser`. Container still `User=dev`, `CapDrop=[ALL]`, `CapAdd=[]`, `no-new-privileges:true`, `Init=true`, no bind mounts, pids 2048. |
| Per-member agent HOMEs | OK: `/home/dev/.notea/agents/20003` and `/20004` exist mode `2700`, each owned by its own uid — one member's CLI login is unreadable by the other. |
| Secrets absent from the database | OK: zero credential-shaped matches across `agent_run_events`, `agent_tasks`, `agent_runs` and `workspace_events`. |
| `npm test` (no `DATABASE_URL`) | OK, exit 0: agents 31 · protocol 6 · workspace-agent 42 · workspace-client 6 · orchestrator 21 (+1 e2e skipped) · web 13 (+7 skipped) · db and worker skip themselves |
| `npm test` for `@notea/db` and `@notea/worker` with `DATABASE_URL` | OK: db 1 · worker 17 (task lifecycle, cancellation, stale-run recovery, concurrency limit, integration lease, and the worktree/branch reaper — planner, git collection, execution and the DB-gated skip/reap paths). Run against a throw-away database (`CREATE DATABASE notea_test`), because the worker suite deletes tasks in `beforeEach`. |
| Reaper (real, in Docker) | OK: run against the demo workspace's live container, it deleted exactly the one merged `done` branch (`notea/task/7c7b3512…`), left the three failed worktrees and branches and `main` untouched, produced a sane `git worktree list`, and a second run was a no-op. |
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
- **Worker**: polling loop, scope-lease-aware claiming, per-run heartbeat and cancellation, event persistence, auto-commit of leftover changes, review/auto-approve per policy, integration with per-workspace mutex, stale-run recovery, worktree/branch reaper.
- **Agent identity (session 6, D-039)**: each user owns a Unix uid (`users.agent_uid`, 20001+); the orchestrator's `POST /workspaces/:id/agent-exec` starts agent processes under it through the Docker daemon (argv only, uid range enforced, gid fixed server-side, `PATH`/`HOME`/`LD_*`/`NOTEA_*` refused, private `0700` HOME, `setsid` so cancellation reaches the CLI's children). `IsolatedAgentSession` implements the existing `WorkspaceSession`/`CommandRunner` interfaces over it, so the runtimes were not changed. `dev` still owns the main tree, creates worktrees and integrates; the shared `dev` group plus `core.sharedRepository=group` and `umask 002` let both work on one project.
- **Authentication modes (session 6, D-040)**: `provider_credentials.auth_mode` is `subscription` (`CLAUDE_CODE_OAUTH_TOKEN`, from the member's own `claude setup-token`; billed to their Claude plan) or `api_key` (metered). Exactly one variable is ever set and the others are cleared inside the container, because claude-code prefers the OAuth token when both are present. **Settings → AI & Claude** can run `claude auth status --json` inside a real container under the member's own uid and show what the CLI itself reports.

## Known issues and technical debt

1. ~~**No authenticated agent run has ever succeeded.**~~ **Resolved (session 7).** A Claude subscription token (`claude setup-token`) is stored for `andrej@notea.mk` and drove a complete authenticated run — see the verification table. The Claude Code stream-json parser is now confirmed against *authenticated* output, not just the auth-failure path. Still unexercised: **Codex and Gemini authenticated runs** (no OpenAI or Google credential on this machine; both still stop at their own credential check, which is a missing credential, not a defect).
2. ~~**A collaborator can read the owner's provider key during a run.**~~ **Resolved (session 6, D-039; re-verified independently in session 7.)** Every agent process runs as the task owner's own Unix uid (`users.agent_uid`, 20001+), started by the Docker daemon, so the kernel refuses `/proc/<pid>/environ` across uids. No capability was restored to achieve it. What remains, and is *not* a defect but a property of the design: members of one workspace still share the project files, and the per-workspace `NOTEA_AGENT_TOKEN` is still readable inside the container (blast radius: that one workspace). See `SECURITY_MODEL.md` → Agent identity isolation.
3. ~~**Deleting a task leaves its worktree and branch in the container.**~~ **Resolved (session 5, D-038).** A worker-side reaper (`apps/worker/src/reaper.ts`, `WORKER_REAP_INTERVAL_MS` default 60 s) removes the worktree and branch of a deleted task (archiving the branch tip to `refs/notea/archive/<id>` first) and the merged branch of an integrated task, while keeping re-runnable and active tasks, in-use worktrees and `main`. Verified against the demo container: it reaped exactly the one leftover `done` branch and was idempotent. Failed tasks still keep their worktree for "Run again", by design.
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

## Deployment status (session 7)

**NOT DEPLOYED — READY FOR VERCEL.** Nothing has been pushed or deployed, and no URL exists.

What is ready: the production `next build` passes (7 routes), `docs/DEPLOYMENT.md` states which half of the product Vercel can host and which half cannot, `infra/deploy/` carries the systemd/Caddy/Postgres/env templates, `.env` is gitignored with only `.env.example` tracked, and a scan of every tracked file found no real credential, private key or machine-specific path.

What is missing, and all of it needs the owner's accounts rather than code:

- **No git remote.** `git remote -v` is empty; `DEPLOYMENT.md` §3 has the two commands.
- **No Vercel login.** The Vercel CLI is not installed and not authenticated on this machine.
- **No production Postgres and no production secrets.** `DATABASE_URL`, `AUTH_SECRET`, `ORCHESTRATOR_API_KEY` and `CREDENTIALS_KEY` do not exist for production. Deploying without them would produce a URL that fails on every request, which is why session 7 did not deploy.
- **No Linux host** for the orchestrator, worker, Docker and workspace containers. Vercel cannot host these: they need the Docker socket, hours-long WebSocket connections and a persistent disk. `DEPLOYMENT.md` §1 has the topology and §5 the VPS procedure.

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
- Local users: `andrej@notea.local` and `collaborator@notea.local` (session 1, from `create-user`), plus `andrej@notea.mk` (Andrej, agent uid 20003) and `niche@notea.mk` (Niche, agent uid 20004) from `npm run seed:dev -w @notea/web`. Development passwords only — change them anywhere reachable.
- A throw-away `notea_test` database exists on the same Postgres for the db/worker/web suites, because the worker suite deletes tasks in `beforeEach`. Never point those suites at `notea`.
- A `demo-project` workspace exists in the dev database; its container is `notea-ws-ebc7f427-1561-4fe5-8103-efda876f0a7d` (start/stop from the UI).
