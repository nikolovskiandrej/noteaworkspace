# Notea Workspace — Current State

Last updated: 2026-09-22, end of session 9 (pre-deployment preparation). Session 8 (2026-09-19) migrated development from Windows 11 to Ubuntu 26.04 and is recorded below. Update this file whenever reality changes.

## One-line status

**M0 (runtime), M1 (control plane + browser UI) and the core of M3 (agent tasks in isolated worktrees with human-approved, serialized integration) are implemented, tested, and verified end to end in Docker — including the browser UI, real cancellation, real timeouts, and real runs of all three agent CLIs. M2 collaboration is partially done. Session 5 added the worktree/branch reaper (D-038). Session 6 closed the credential exposure: every agent process now runs as the Unix uid of the member whose task it is (D-039), and a credential carries its authentication mode so a Claude subscription can never silently become metered API usage (D-040). Session 7 verified that independently against a live container, committed the work session 6 had left uncommitted, prepared the repository for GitHub and Vercel, and — finally — **ran the first authenticated agent task end to end**: a real Claude Code process under a Claude subscription token wrote `CHANGELOG.md`, committed it, and the task went review → approval → integration → reaped, with the credential never appearing in a log, an event, a diff or the database. The last long-standing blocker is closed. Session 8 moved the whole development environment from Windows 11 to Ubuntu 26.04 and re-proved it there: the repository, the dev database and both agent identities came across intact, the suite reproduces exactly (167), and the pipeline was driven end to end again under a real Claude subscription — this time over `network` connect mode, which no session had ever exercised. **The project is no longer Windows-bound.****

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

## Verified on 2026-09-19 (Ubuntu 26.04.1, Node 24.21, npm 11.19, Docker Engine 29.8.1, Compose v5.5.1)

The migration session. Everything below was re-run on Linux from a restored backup, not carried over as a claim.

| Check | Result |
|---|---|
| Repository recovered | OK. Restored from the pre-migration backup to `~/ClaudeProjects/notea-workspace`; 629 files re-hashed byte-for-byte against the backup, `git fsck` exit 0, full reflog, HEAD `bfb0ee6` == `origin/main`, working tree clean. The backup itself verified first: 137,318 files present at recorded size, 2,098 SHA-256 checksums all matching. |
| `npm ci` from the existing lockfile | OK, 271 packages, no version changed and no lockfile regenerated. **node-pty compiled from source to a Linux ELF x86-64 binding** and was proved by spawning a real PTY (`/dev/pts/*`, exit 0), not merely imported. |
| `npm run typecheck` | OK across all 9 workspaces |
| `npm test` with `DATABASE_URL` (throw-away `notea_test`) | OK: **167 passed, 3 skipped** — the exact session-7 figure reproduced. agents 42 · db 1 · protocol 6 · workspace-agent 42 · workspace-client 6 · orchestrator 29 (+3 e2e skipped in this mode) · web 20 · worker 21. The real `notea` database was untouched by the run. |
| `npm run test:e2e -w @notea/orchestrator` | OK: **3 tests** (container + bridge + file persistence across restart; cross-uid credential isolation; agent-as-member with process-tree cancellation). Note: the "18 tests" this table claimed for session 4 is stale — the file has had 3 `it()` blocks since `a2e29d3`. |
| `npm run build:image` | OK, 3 min 19 s, `notea/workspace:dev` 1.99 GB, verified to contain claude-code 2.1.272, codex-cli 0.154.0, gemini-cli 0.59.0, Node 24.21, git 2.39.5 |
| `npm run build -w @notea/web` | OK, production `next build`, 7 routes |
| `npm run build:agent` | OK — and the Linux-built `dist/agent.cjs` is **byte-identical (same SHA-256) to the Windows-built artifact**, which is the cleanest evidence nothing drifted in the move. |
| Dev database restored | OK. The raw `notea-dev-postgres-data` volume (captured after a clean `Exited (0)` shutdown) restored into PostgreSQL 17.11, healthy in 6 s. Every row count matches what the backup recorded: `agent_run_events` 214 · `agent_runs` 27 · `agent_tasks` 11 · `workspace_events` 77 · `users` 4 · `workspace_members` 3 · `provider_credentials` 1 · `workspaces` 1 · `__drizzle_migrations` 5. `npm run migrate` was a no-op; no migration was invented. Both `notea` and `notea_test` and the `notea` role came back. |
| Workspace HOME volume restored | OK: 5,693 files, 104 MB. `/home/dev/.notea/agents/20003` and `/20004` came back **owned by their own uids, mode 2700** — the D-039 identity separation survives a tar round trip. All five task worktrees and `a83cffe` (session 7's authenticated commit) intact. |
| **`network` connect mode** | **OK — first time ever exercised.** `AGENT_CONNECT_MODE=auto` resolves to `network` on Linux (`published` on win32), so the orchestrator reaches the agent on the container IP with no published port (`PortBindings` empty). The Docker e2e, a live two-client session and a real agent run all ran over it. This closes the long-standing "untested on a Linux host" caveat. |
| Container hardening on Linux | OK: `User=dev`, `CapDrop=[ALL]`, `CapAdd=[]`, `no-new-privileges:true`, `Init=true`, `PidsLimit=2048`, `Binds=[]` (no bind mounts), HOME volume only. |
| Authentication (real, over HTTP) | OK: sign-in as `andrej@notea.mk` issues a session; `/`, `/settings/ai`, `/workspaces/<slug>` return 200 with it and 307 to `/sign-in` without it; a wrong password returns `CredentialsSignin`. Orchestrator REST returns 401 without the API key. |
| Two-user model (live, two clients at once) | OK: Andrej (`owner`) and Niche (`editor`) connected to the *same* workspace simultaneously; presence broadcast listed both; Andrej opened a PTY and **Niche attached and received the same output**; both listed and read shared project files; exec through the bridge exited 0. |
| Credential isolation (live) | OK: `/proc/<pid>/environ` is `-r-------- 1 20003 dev`; uid 20004 found 0 matches of uid 20003's marker and `dev` got `Permission denied`; a process reads its own fine. `CapPrm=CapEff=0`, `NoNewPrivs=1`, `setpriv --reuid=0` refused. The orchestrator rejects uid 0 and uid 1000 with HTTP 400. **Linux adds a layer Docker Desktop did not**: the host's `kernel.yama.ptrace_scope=1` refuses even same-uid non-descendant reads. |
| **Second authenticated Claude run, end to end** | **OK, 2026-09-19.** Task "Linux migration: record the move in MIGRATION.md" (`claude-sonnet-5`, scope `MIGRATION.md`, 5-minute cap) under the same stored subscription credential. `queued → running → needs_review → approved → done` in 10.8 s; 719 output tokens, $0.0736. Real `Bash`/`Write` tool use; `MIGRATION.md` written **owned by uid 20003**, committed by `Claude Code <agent+…@notea.local>`, diff stat `1 file changed, 3 insertions(+)`; approved by its owner, **fast-forwarded to `main` as `6271618` with zero merge commits**, and the merged branch reaped within ~6 s while the five failed/cancelled worktrees were left alone. Zero `sk-ant-` matches in the orchestrator log, worker log, web log, `agent_run_events`, `agent_runs`, `agent_tasks`, `workspace_events`, or the container's entire `git log -p --all`. |
| Settings → AI & Claude connection check | OK: `claude auth status --json` inside the real container as uid 20003 reports `loggedIn`, `authMethod: oauth_token`, config dir `/home/dev/.notea/agents/20003/.claude`. The stored credential survived the migration; **no re-authentication was needed**. |

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

1. ~~**No authenticated agent run has ever succeeded.**~~ **Resolved (session 7, repeated on Linux in session 8).** A Claude subscription token (`claude setup-token`) is stored for `andrej@notea.mk` and has driven two complete authenticated runs — see both verification tables. Session 8 also captured the real authenticated records as fixtures in `packages/agents/test/runtimes.test.ts`, so the stream-json parser is now pinned against authenticated output rather than only described as confirmed. Still unexercised: **Codex and Gemini authenticated runs** (no OpenAI or Google credential on this machine; both still stop at their own credential check, which is a missing credential, not a defect).
2. ~~**A collaborator can read the owner's provider key during a run.**~~ **Resolved (session 6, D-039; re-verified independently in session 7.)** Every agent process runs as the task owner's own Unix uid (`users.agent_uid`, 20001+), started by the Docker daemon, so the kernel refuses `/proc/<pid>/environ` across uids. No capability was restored to achieve it. What remains, and is *not* a defect but a property of the design: members of one workspace still share the project files, and the per-workspace `NOTEA_AGENT_TOKEN` is still readable inside the container (blast radius: that one workspace). See `SECURITY_MODEL.md` → Agent identity isolation.
3. ~~**Deleting a task leaves its worktree and branch in the container.**~~ **Resolved (session 5, D-038).** A worker-side reaper (`apps/worker/src/reaper.ts`, `WORKER_REAP_INTERVAL_MS` default 60 s) removes the worktree and branch of a deleted task (archiving the branch tip to `refs/notea/archive/<id>` first) and the merged branch of an integrated task, while keeping re-runnable and active tasks, in-use worktrees and `main`. Verified against the demo container: it reaped exactly the one leftover `done` branch and was idempotent. Failed tasks still keep their worktree for "Run again", by design.
4. **No ESLint/Prettier** (D-018).
5. **Image size** (Node + build tools + three CLIs); a slim variant is possible.
6. **`fs.changed` covers API writes only**; terminal-side edits are caught by the etag check at save time, not proactively.
7. **Tasks listing does N+1 queries** (fine for personal scale).
8. **Run exactly one worker process.** Claims are optimistic (`UPDATE … WHERE status='queued'`) and the concurrency limit is counted in-process, so it is per worker, not global. Overlapping workers from earlier sessions once produced a misleading result: a worker running pre-fix code claimed a requeued task and reported an authentication failure as `completed`.
9. **No automated Docker e2e for the worker pipeline** (the lifecycle, cancellation and timeout paths were driven by hand against real containers in session 4; the automated suite covers the logic with fakes).
10. ~~**Windows development relies on `published` connect mode; `network` mode is untested on a Linux host.**~~ **Resolved (session 8).** Development moved to Ubuntu 26.04, where `auto` resolves to `network`. The Docker e2e, a live two-client session and a real authenticated agent run all ran over it with no published port. `published` remains the correct choice on Docker Desktop and is still what `auto` picks on win32/darwin; neither mode is now untested.
11. **Dev console** (`DEV_CONSOLE=true`) mints tokens without auth; keep it off on reachable hosts.
12. Old server-side artefacts: none known. Sessions do not survive container restarts (by design).
13. **The npm cache and Docker storage locations are machine-level settings**, not repository settings (`ARCHITECTURE.md` §12). A fresh clone on another machine keeps that machine's defaults; only `.tmp` for tests travels with the repository.

## Deployment status (session 7)

**DEPLOYED (control plane only).** https://noteaworkspace-web.vercel.app — `apps/web` on Vercel, Postgres on Neon.

Repository: https://github.com/nikolovskiandrej/noteaworkspace (branch `main`).

Verified live on 2026-09-16: `/sign-in` returns 200 and renders the form; `/` and `/settings/ai` 307 to sign-in with the correct `callbackUrl`; and a sign-in POST with a deliberately wrong password returns `302 → /sign-in?error=CredentialsSignin` rather than a 500 — which proves the deployed app reaches Neon, finds the user and runs the scrypt check. The five migrations are applied to the Neon database and the first account exists.

**Only the control plane is deployed, and that is the whole of what Vercel can host.** Starting a workspace, terminals, the editor and agent tasks all need the orchestrator, the worker and Docker on a Linux host (`DEPLOYMENT.md` §5); `ORCHESTRATOR_URL`/`ORCHESTRATOR_PUBLIC_URL` are currently the placeholder `https://orchestrator.example.com`, which satisfies the schema in `apps/web/src/lib/env.ts` so sign-in works, and must be replaced with `https://orchestrator.noteawork.com` (and redeployed) before any workspace can start.

Two dependency defects were found by deploying and are fixed (`717aa95`, `2338bc7`): `typescript`, `@types/node`, `vitest` and **`drizzle-orm`** were used by `apps/web` but declared only in the root `package.json` (or nowhere). Local npm hoisting hid this; Vercel installs only the target workspace, so it did not. `drizzle-orm` was the real one — production code (`src/app/api/workspaces/[id]/connect-token/route.ts`) importing an undeclared package.

What is ready: the production `next build` passes (7 routes), `docs/DEPLOYMENT.md` states which half of the product Vercel can host and which half cannot, `infra/deploy/` carries the systemd/Caddy/Postgres/env templates, `.env` is gitignored with only `.env.example` tracked, and a scan of every tracked file found no real credential, private key or machine-specific path.

What is missing (the list below replaces session 7's, which was written before the Vercel
deployment happened and then contradicted the paragraph above it):

- **The Linux host exists but nothing is installed on it.** `178.105.211.58` (Hetzner; reverse DNS `…clients.your-server.de`) answers on port 22 with `OpenSSH_10.2p1` — newer than Ubuntu 24.04's 9.6p1, so check `lsb_release -a` before following §5 step 1. Ports **80, 443 and 4100 are closed**; 80 and 443 must be opened in the Hetzner Cloud Firewall before Caddy can obtain a certificate. Everything in `DEPLOYMENT.md` §5 is still to do.
- ~~**No domain.**~~ **Done (2026-09-22).** `orchestrator.noteawork.com` → `178.105.211.58`, verified resolving. DNS is Cloudflare, **DNS-only (not proxied)**, which is what Caddy's ACME and the browser's direct `wss://` both need — do not turn the orange cloud on.
- **The two shared secrets have not been read out of Vercel.** `ORCHESTRATOR_API_KEY` and `CREDENTIALS_KEY` exist on the deployed project but are not on the development machine, and the host must reuse those exact values (`DEPLOYMENT.md` §2). The Vercel CLI is still not installed or authenticated here, so this needs the owner.
- **Vercel still points at the placeholder orchestrator.** `ORCHESTRATOR_URL`/`ORCHESTRATOR_PUBLIC_URL` are `https://orchestrator.example.com` and must become `https://orchestrator.noteawork.com`; §5 step 9, and a **redeploy** is required for the change to take effect.

## Session 8 (2026-09-20): pre-deployment preparation

No deployment, no server, no credential touched. Four changes, all local:

1. **The worker's signal handlers were unreachable.** In `apps/worker/src/index.ts` the `while (!stopping)` poll loop sat *above* the `process.on('SIGTERM'|'SIGINT', …)` registrations, and only `shutdown` sets `stopping` — so the handlers were dead code and the loop could never end. `systemctl stop|restart notea-worker` therefore killed the process outright, abandoning in-flight runs and leaving `running` rows for stale-run recovery to fail two minutes later. The registrations now precede the loop, the poll sleep is interruptible so a signal is not held up by a whole interval, `shutdown` is idempotent, and draining happens after the loop. `notea-worker.service` gained `TimeoutStopSec=120` so systemd allows the drain; a run that outlasts it is still killed, with stale-run recovery as the backstop.
2. **Production sizing for a 4 vCPU / 8 GB host** in `infra/deploy/vps.env.example`: `WORKSPACE_DEFAULT_MEMORY_MB` 4096 → **3072**, `WORKER_MAX_CONCURRENT_RUNS` 3 → **2**. A container's limit is a cap, not a reservation, so two workspaces at 4096 could exhaust an 8 GB host before either hit its own limit.
3. **`WORKER_POLL_INTERVAL_MS` 2000 → 15000.** Every tick runs `recoverStaleRuns` and `findApprovedTasks` against Postgres, so at 2 s a managed database never scales to zero and bills as always-on. 15 s stays well inside `STALE_RUN_MS` (2 min) and the 15 s run heartbeat, and only delays picking up a new task by that much. Code defaults are unchanged; this is the production template.
4. **GitHub access for the VPS: a read-only deploy key** (D-041). §5 step 3a generates it on the host; the private half never leaves it and no PAT is created. The clone URL in §5 was also a placeholder that could never have worked — it is now the real repository.

`DEPLOYMENT.md` was rewritten where it had gone stale: it no longer claims the project is undeployed, §3 and §4 are marked done, §2 marks the two shared secrets COPY rather than GENERATE, and §5 gained the deploy key, the sizing note, the `caddy` availability check, port 80, the `DATABASE_URL` warning, and step 9 (point Vercel at the host and redeploy).

## Host disk: incident (session 2) and resolution (session 3) — Windows-era history

> Kept as a record of why the storage layout was what it was. **None of it applies since session 8**: there is no Docker Desktop, no C:/D: split and no relocated npm cache on Ubuntu, and the root filesystem had 270 GB free after the migration. The lesson that survives is the one that caused it — image builds and Docker volumes are large, and they must live where there is room.

**Session 2 incident.** The Windows C: drive was at 99% (Docker Desktop's VM disk and caches live there by default). Repeated image builds used the rest; Docker's VM remounted read-only, the dev Postgres started failing queries, the worker crashed, and image builds failed. Immediate recovery: temp logs and npm cache cleaned, Docker Desktop restarted, dev Postgres restarted. C: was still at ~1 GB free at the end of that session.

**Session 3 resolution: storage migrated to D:.** The cause was structural, not incidental, so the storage layout was changed rather than cleaned up again. Docker Desktop's data disk was moved to `D:\DockerDesktop\wsl` through Docker's own migration routine, and the npm cache and test scratch directory were pointed at D: as well. Layout and procedure are documented in `ARCHITECTURE.md` §12.

Result: **C: went from 1.01 GB free to 22.19 GB free; D: from 309.32 GB to 293.69 GB.** The decisive check is that a full `npm run build:image` now consumes 0 bytes of C:. Postgres data, the workspace HOME volume, and the other project's containers and volumes were all preserved and verified after the move (row counts, database size, file counts, and git history all identical to the pre-migration baseline).

Not moved, and why: `C:\Users\<user>\.claude` (240 MB) and `.codex` (840 MB) belong to the owner's own CLI tools, not to this project; `ms-playwright` (1.35 GB) is not a dependency of this repository; VS Code, browsers and other applications on C: are unrelated. Docker Desktop keeps ~30 MB of its own logs in `%LOCALAPPDATA%\Docker\log`, which is left alone.

## Environment facts for this machine (do not change other projects)

**The development machine is Ubuntu 26.04.1 since 2026-09-19 (session 8). The facts below replaced the Windows ones; the Windows layout is kept for history under "Host disk" and `ARCHITECTURE.md` §12.**

- The repository is `~/ClaudeProjects/notea-workspace`. The Windows `D:` drive it came from no longer exists — Ubuntu occupies that partition. The pre-migration backup is `~/Documents/Linux_Backup` (15.4 GB, `Projects/` + `FEIT/`), and it is the source of truth for anything not in git: `Projects/docker-volumes/` holds the dev-database dumps and the raw volume tarballs, `Projects/_BACKUP_INFO/` holds the manifests, checksums and restore notes. **Treat it as read-only.** The Windows `C:` partition survives, mounted read-only at `/run/media/andrej/161A4FD51A4FB093`.
- **Port 5432 is reserved and must stay untouched.** The unrelated `ai-creator-automation` Postgres used it on Windows. That project's source no longer exists anywhere, but its data survives as dumps in `Projects/docker-volumes/` (`app` superuser, ~9,100 rows, and the dumpall contains `oauth_tokens`/`app_secrets` in plaintext — treat those files as secrets). Nothing of it is running on Linux. This project's Postgres is `notea-dev-postgres` on **55432** (compose project `notea-dev`), and `docker-compose.dev.yml` binds `127.0.0.1` only.
- Docker is **Docker Engine 29.8.1 native**, not Docker Desktop: no WSL2 VM, no `.vhdx`, data at `/var/lib/docker` on the 325 GB root filesystem. The old `docker_data.vhdx` is unreadable here by design, which is why the volumes were migrated as dumps and tarballs.
- `AGENT_CONNECT_MODE=auto` now resolves to **`network`**, not `published`. Workspace containers publish no host port; the orchestrator reaches the agent on the container IP over the `notea-workspaces` network.
- The npm cache is the Linux default (`~/.npm`); the D: redirection was a Windows-only workaround for a full C: drive and is not needed here. Test scratch still travels with the repository (`<repo>/.tmp`, via `vitest.shared.mjs`).
- Node 24 is installed from NodeSource (Ubuntu's own package is 22, below the `engines` floor). `node-pty` compiles from source, so `build-essential` is a real prerequisite on a fresh machine.
- The `andrej` account is in the `docker` group. Group membership applies at login, so after adding it a re-login (or reboot) is required before the Docker socket is usable.
- Local users: `andrej@notea.local` and `collaborator@notea.local` (session 1, from `create-user`), plus `andrej@notea.mk` (Andrej, agent uid 20003) and `niche@notea.mk` (Niche, agent uid 20004) from `npm run seed:dev -w @notea/web`. Development passwords only — change them anywhere reachable.
- A throw-away `notea_test` database exists on the same Postgres for the db/worker/web suites, because the worker suite deletes tasks in `beforeEach`. Never point those suites at `notea`.
- A `demo-project` workspace exists in the dev database; its container is `notea-ws-ebc7f427-1561-4fe5-8103-efda876f0a7d` (start/stop from the UI).
