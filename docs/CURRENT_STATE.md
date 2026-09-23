# Notea Workspace — Current State

Last updated: 2026-09-23, end of session 11 (frontend polish; three defects found in the browser and fixed). Session 10 (2026-09-22) reviewed every source file and fixed 17 defects; session 9 prepared the deployment; session 8 (2026-09-19) migrated development from Windows 11 to Ubuntu 26.04. All are recorded below. Update this file whenever reality changes.

## One-line status

**M0 (runtime), M1 (control plane + browser UI) and the core of M3 (agent tasks in isolated worktrees with human-approved, serialized integration) are implemented, tested, and verified end to end in Docker — including the browser UI, real cancellation, real timeouts, and real runs of all three agent CLIs. M2 collaboration is partially done. Session 5 added the worktree/branch reaper (D-038). Session 6 closed the credential exposure: every agent process now runs as the Unix uid of the member whose task it is (D-039), and a credential carries its authentication mode so a Claude subscription can never silently become metered API usage (D-040). Session 7 verified that independently against a live container, committed the work session 6 had left uncommitted, prepared the repository for GitHub and Vercel, and — finally — **ran the first authenticated agent task end to end**: a real Claude Code process under a Claude subscription token wrote `CHANGELOG.md`, committed it, and the task went review → approval → integration → reaped, with the credential never appearing in a log, an event, a diff or the database. The last long-standing blocker is closed. Session 8 moved the whole development environment from Windows 11 to Ubuntu 26.04 and re-proved it there: the repository, the dev database and both agent identities came across intact, the suite reproduces exactly (167), and the pipeline was driven end to end again under a real Claude subscription — this time over `network` connect mode, which no session had ever exercised. **The project is no longer Windows-bound.** Session 10 reviewed every source file and fixed 17 defects, the worst of which ended every isolated agent run within 10 minutes (5 if it went quiet) regardless of `max_minutes` (see Session 10 below). Session 11 gave the browser UI one design system (tokens, IBM Plex, restrained motion, a real phone/tablet layout) and fixed three defects found by driving it in Chrome: queueing a task or saving the policy discarded unsaved editor text, Chrome filled the Notea login into the provider-token form, and a terminal that finished attaching took the keyboard from the editor (see Session 11 below).**

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
│   ├── db/             Drizzle schema + migrations 0000–0004, client, migrate script            [implemented, tested]
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
| `npm test` with `DATABASE_URL` (throw-away `notea_test`) | OK: **169 passed, 3 skipped** — agents 44 · db 1 · protocol 6 · workspace-agent 42 · workspace-client 6 · orchestrator 29 (+3 Docker e2e skipped in this mode) · web 20 · worker 21. Re-run after rebasing onto session 8, so it includes that session's two authenticated-parser fixtures. |
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
- **Web**: Auth.js credentials (scrypt), server-side membership roles (owner/editor/viewer) on every action, workspaces CRUD, members, terminal tabs (agent sessions badged), CodeMirror editor with conflict detection and change notices, presence, activity (as sentences: who did what to which task), tasks panel (create/approve/cancel/requeue/delete, run event log, policy editor), credentials settings (AES-256-GCM). One design system since session 11 (D-044): tokens and component classes in `globals.css`, IBM Plex self-hosted, Motion for interaction only, reduced motion respected, and a single-pane layout with a Files/Code/Tasks switcher below 1024 px. Same-page server actions revalidate rather than redirect, so the page (and the editor's unsaved text) stays mounted (D-043).
- **Agents**: provider catalog and credential env mapping; `AgentRuntime` interface; Claude Code headless runtime (`claude -p … --output-format stream-json`, parsed defensively); Codex/Gemini/generic runtimes via `GenericCliRuntime`; runs execute through the orchestrator's agent-exec as the task owner's uid and show in the UI as their run log (D-039; they are no longer terminal tabs); git worktree per task; brief generator; scope overlap detection; task state machine; serialized integration (rebase → optional check command → fast-forward).
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
14. **Agent-exec pid files are never removed after a normal exit.** `/tmp/.notea-exec-<execId>.pid` is deleted only by the kill script, so one tiny file per finished exec stays in the container's `/tmp` until the container is recreated. Harmless at personal scale.
15. **No backpressure on WebSocket sends.** The agent and the bridge write to a slow client without waiting, so a client that cannot keep up with a very chatty terminal buffers in memory. Fine for two people; a limit belongs with multi-tenant hardening.
16. **Recovering an interrupted integration waits for the lease to expire** (up to 30 minutes, D-042), because the worker id changes with every restart. A stable `WORKER_ID` would allow reclaiming immediately.
17. **The dev Postgres volume was restored by hand** in session 8, so `docker compose … up` warns that `notea-dev-postgres-data` "already exists but was not created by Docker Compose". Cosmetic; the volume is used as is.
18. **A failed action still remounts the workspace page.** Errors from server actions travel as `?error=` in a redirect (`withError`), and any redirect remounts the page, so an unsaved edit is lost when, say, adding a member fails. Successful actions no longer do this (D-043); moving the forms to `useActionState` would cover failures too.
19. **No `loading.tsx` on the workspace route.** A Suspense boundary there made a page opened in a background tab render twice (React batches Suspense reveals on `requestAnimationFrame`, which background tabs do not run), leaving a hidden copy with duplicate ids. The workspace link shows a spinner while the page loads instead (D-044).

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

## Session 11 (2026-09-23): frontend polish, and defects found in the browser

**Starting point.** Nothing was uncommitted or half-finished: `main` was clean and equal to `origin/main` (`f6b0e8d`), the backup clone was clean, and the workspace image and the demo container already ran the current agent (the rebuilt `agent.cjs` has the same SHA-256 as the one in the image and in the container), so HANDOFF's "the demo container predates the image" no longer applied. Baseline: typecheck clean, **186 passed / 3 skipped**.

**Defects fixed, each with a regression test that fails on the old code.**
1. **Queueing a task, saving the policy or adding a member threw away unsaved editor text.** Same-page server actions ended with `redirect()` to the page they came from; Next rethrows that redirect into the form that sent the action, and the page's redirect boundary remounts the whole page: the editor (and its unsaved text), the WebSocket, the terminals and every open panel. Approve, cancel and run again escaped only because their buttons vanish once the status changes. Reproduced in Chrome on the pre-session UI. Same-page actions now revalidate instead, and redirect only to clear an earlier `?error=` (D-043, `apps/web/src/lib/stay-on-page.ts`). Verified in Chrome: one unsaved edit survived queueing a task, saving the policy, adding and removing a member, deleting, approving, cancelling and re-running tasks, with no WebSocket reconnect in the server log.
2. **Chrome filled the Notea login into "Connect an account"**: the email into Label and the account password into "Token or key", despite `autoComplete="off"` (which Chrome ignores for password fields). One careless click on Connect would have submitted the Notea password as a provider secret. The token field is now `autoComplete="new-password"` with the password managers' opt-out attributes; in the same Chrome profile both fields now come up empty (`:autofill` false).
3. **The task list reshuffled itself on every refresh** when tasks shared a `created_at` (the list was ordered by the timestamp alone); the id now breaks the tie.
4. The empty tasks panel promised "watch its terminal appear". Since D-039 a run shows as its run log, not a terminal; the copy says so, and D-024 is marked superseded in part.
5. **A terminal that finished attaching took the keyboard from the editor.** Attaching is asynchronous and ended in an unconditional `term.focus()`, so keystrokes typed into a file while the page loaded, or while another terminal closed and the next one mounted, went to a shell instead. The terminal now takes focus only when nothing else has it or it is already in the terminal panel (a tab or "New terminal" was just clicked). Verified in Chrome: with the editor focused, closing one terminal mounted the next without moving the focus or the typed text. (No automated test: the web suite has no DOM environment.)

**Frontend polish (D-044).** No functionality, API, route or form field changed. What changed is how it looks and moves:
- Tokens in `globals.css`: black with a trace of the brand green, off-white text in three steps (all at least 4.5:1 on their surfaces), dark green `#1e6a48` for primary actions, mint `#7cc4a0` for green that must be read on black, and one tone per status. Component classes for buttons, fields, status pills, menus, dialogs and segmented tabs. IBM Plex Sans and Mono, self-hosted from `@fontsource`.
- Sentence-case headings instead of tracked ALL-CAPS labels; a status pill (a dot and a word) for every workspace and task state, whose dot pulses only while something is in progress.
- Top bar with breadcrumbs, an account menu (name, e-mail, AI connections, sign out), and an owner-only menu whose "Delete workspace…" opens a real dialog (native `<dialog>`: focus trap, Escape; the confirm button stays disabled until the slug is typed, and the server still checks it).
- Workspace list with whole-row links and a spinner while a workspace opens; "New workspace" opens the form in place (open by default when there are none).
- Editor and terminal themes in the same palette (One Dark removed); a path breadcrumb with "Unsaved changes" / "Saved", and a conflict strip with Reload from disk / Overwrite.
- Terminal tabs whose close control is a real button (it used to be a `span` inside a `button`, reachable only by mouse hover); empty states that offer the next action.
- Tasks panel: labelled fields (the budget field no longer overflows the sidebar), a status summary, expanding details with a colourised diff stat and run log, secondary actions as icon buttons with labels.
- People with avatars (agents are rounded squares), and activity as sentences on a timeline ("CI agent failed on “Run the test suite”") instead of `task.run_failed`.
- Below 1024 px the workspace shows one pane at a time with a Files / Code / Tasks switcher; every pane stays mounted, so edits and terminals survive switching.
- Motion only where it answers an action (menus, dialog, expanding tasks and forms, the sliding tab indicator, press feedback), loaded lazily; `prefers-reduced-motion` turns it off.

**Verified.**

| Check | Result |
|---|---|
| `npm run typecheck` | OK across all 9 workspaces |
| `npm test` with `DATABASE_URL` (throw-away `notea_test`) | OK: **194 passed, 3 skipped** (web 21 → 29: stable ordering, activity sentences, `stayOnPage`) |
| `npm run test:e2e -w @notea/orchestrator` | OK: 3 passed |
| `npm run build -w @notea/web` | OK, 7 routes; the stylesheet carries the 26 `@font-face` rules; Motion's always-loaded part is about 12 KB gzipped, its features load after first paint |
| Browser, Claude in Chrome (Chrome 153), dev server and the production build | Sign-in, workspace list, create workspace, file tree, editor edit and save (written into the container), terminal (Plex Mono, ANSI palette), task queue → run → review → approve and integrate → done, cancel, run again, delete, policy save, add and remove member, stop and start, delete dialog, account menu, AI settings. No console errors or hydration warnings. Phone (390 px) and tablet (820 px) layouts checked in same-origin iframes. |

How the browser pass avoided real data: the web app and the worker ran against a throw-away `notea_ui` database, the browser reused the existing development session (no password was typed), and the workspace it drove was a throw-away container, deleted through the new dialog at the end. The automation tab ran in a background window, where Chrome does not run `requestAnimationFrame`; animations were checked at their end states rather than watched frame by frame.

Not changed: the orchestrator, the worker, the agent runtimes, the protocol and the database schema. The deployment still needs the owner (Deployment status above).

## Session 10 (2026-09-22): whole-project bug review

Every source file was read and checked against the docs. 17 defects were fixed, each with a regression test that fails on the old code and passes on the new (suite 169 → 186); the ones that only show on real infrastructure were reproduced there before being fixed.

**Agent runs.**
1. **Every isolated agent run was killed after at most 10 minutes**, whatever `max_minutes` said, and reported as `failed`. `startTerminalRun` never passed its deadline to `createTerminal`, so the orchestrator applied its 10-minute exec default: the "backstop" fired first. It now passes `maxMinutes` + 60 s (`BACKSTOP_MARGIN_MS`).
2. **An agent that printed nothing for 5 minutes lost its run.** Found by the end-to-end probe for (1): Node's fetch aborts a response body that receives nothing for 300 s, so a Claude Code run inside one long tool call (a test suite, a build) was read as "exited, code null", i.e. `failed`, while the agent kept working. The orchestrator now sends a `keepalive` frame every 30 s on streamed agent execs (an additive frame type).
3. **A lost stream left the agent running unwatched**, editing a worktree the worker was about to commit. `IsolatedAgentSession` now stops a process whose stream ended without an exit frame (retrying for ~30 s, since the usual cause is an orchestrator restart), and the orchestrator kills an agent exec whose streaming caller disconnects (a worker crash, or a restart that outlasts its drain).
4. **A run that failed while its agent was still going** (an event that cannot be stored, a lost database connection) left the CLI running and spending. `runTask` now cancels it before anything else.
5. **Gemini runs could not start in a fresh workspace.** The runtime wrote its first-run settings to `/home/dev/.gemini`, which an agent uid cannot create and the CLI, whose HOME is `~/.notea/agents/<uid>`, never reads. Reproduced in a fresh container ("Permission denied"). The run now seeds `$HOME/.gemini/settings.json` from its own command line.

**Worker and integration.**
6. **A git command in flight when the workspace connection dropped hung the worker forever.** `runExec` waited for an `exec.exit` the agent could no longer deliver (it kills a disconnected client's processes); during integration that also held the per-workspace mutex, blocking every later integration until a restart. `runExec` now rejects with `disconnected`.
7. **A task whose worker died mid-integration stayed `integrating` forever**: nothing leads out of that status, users cannot cancel it, and the reaper skips any workspace with an active task. It is now handed back to `approved` and retried (D-042).
8. **An integrated task could end up `failed`**: its worktree was removed before the outcome was recorded, so a failure there (a dropped connection) overwrote a successful fast-forward. The outcome is recorded first; removal is best effort, and the reaper retries it.

**Browser path.**
9. **The bridge dropped frames sent while it was still verifying the token.** `@fastify/websocket` hands over an already-open socket and the handler awaited before attaching listeners, while the web UI sends its first file-tree request the moment it sees `open`. A client that left in that window also left an upstream connection behind, a ghost in presence. Listeners now go on first; the pre-upstream buffer is capped at 8 MB.
10. **The editor threw away unsaved edits on every reconnect**: its load effect destroyed the editor on any connection-state change and reloaded the file from disk.
11. **The editor could show one file's content under another's path** when reads finished out of order while switching files ("Overwrite" would then have written it there). Loads are now sequenced.
12. **A briefly unreachable orchestrator unmounted the live workspace view**, and the editor with it, on the next page refresh, because "unknown" rendered as "not running". The live view now stays up and shows the reconnect banner.
13. **A failed workspace creation left its container running** where nothing listed it (the orchestrator can create it and then time out waiting for the agent). The web app now removes the runtime as well as the row.

**Workspace agent and libraries.**
14. An `exec.start` whose client disconnected while its `cwd` was being resolved started a process nobody owned; it ran until its timeout.
15. A process over the output limit re-sent the "limit exceeded" notice, and its output, for every chunk until it died.
16. `term.create` resolved a relative `cwd` against the agent's own working directory instead of the project directory the protocol names.
17. `PerKeyMutex` never forgot a key: it compared the stored tail with the wrong promise.

Also corrected: `isDirectoryInUse` claimed every process in the container is `dev` (since D-039 agent-uid processes are invisible to it, which the reaper's active-task skip already covers); the model catalog's context sizes (1 M tokens for the 5-family); two Windows-era CRLF working files; stale statements in `HANDOFF.md` §7/§8/§16/§17, this file's migrations line and `AGENT_SYSTEM.md`.

**Verified.** Typecheck clean (9 workspaces); **186 passed / 3 skipped** with `DATABASE_URL`, in repeated runs with no unhandled errors; production `next build` (7 routes); `npm run build:image` and the 3 Docker e2e tests on the new image. Against the real stack (local orchestrator, Docker Engine):

| Check | Result |
|---|---|
| 11-minute agent process, before/after (1) and (2) | First probe, before the keepalive: the old and the new path both died at **301.7 s**, which is how (2) was found. After both fixes: the process started the old way was killed at **600.9 s**; the same process through `startTerminalRun` with `max_minutes` 12 ran the full **660 s** and finished `completed`, exit 0. |
| Gemini seeding (5), uid 20003 through the orchestrator, fresh container | Settings written to `/home/dev/.notea/agents/20003/.gemini/settings.json`, owned by 20003; the old path failed with `mkdir: cannot create directory '/home/dev/.gemini': Permission denied`. |
| **First browser pass on Linux** | Headless Chrome, driven over the DevTools protocol, against the production build and a throwaway database: sign-in, create a workspace, first file-tree load, unsaved edits surviving a dropped connection, Save written into the container, a terminal running commands as `dev`, presence, delete (container removed), no console errors — **9/9**. The same scenario on a build with the old editor **lost the edits** after the reconnect. |

**Environment.** Session 9 had been run in the read-only backup clone (`~/Documents/Linux_Backup/Projects/D_ClaudeProjects/notea-workspace`). Its commits were on GitHub, and the working copy `~/ClaudeProjects/notea-workspace` was fast-forwarded to them (`234a46d → a4a42c3`) before any work; `HANDOFF.md` §28 now says where to work. The demo workspace's container still runs the image from before the rebuild: stop and start it to get the fixed agent daemon.

## Session 9 (2026-09-20 – 2026-09-22): pre-deployment preparation

No deployment and no credential touched; the domain and the host were bought and
created by the owner mid-session. Changes:

1. **The worker's signal handlers were unreachable.** In `apps/worker/src/index.ts` the `while (!stopping)` poll loop sat *above* the `process.on('SIGTERM'|'SIGINT', …)` registrations, and only `shutdown` sets `stopping` — so the handlers were dead code and the loop could never end. `systemctl stop|restart notea-worker` therefore killed the process outright, abandoning in-flight runs and leaving `running` rows for stale-run recovery to fail two minutes later. The registrations now precede the loop, the poll sleep is interruptible so a signal is not held up by a whole interval, `shutdown` is idempotent, and draining happens after the loop. `notea-worker.service` gained `TimeoutStopSec=120` so systemd allows the drain; a run that outlasts it is still killed, with stale-run recovery as the backstop.
2. **Production sizing for a 4 vCPU / 8 GB host** in `infra/deploy/vps.env.example`: `WORKSPACE_DEFAULT_MEMORY_MB` 4096 → **3072**, `WORKER_MAX_CONCURRENT_RUNS` 3 → **2**. A container's limit is a cap, not a reservation, so two workspaces at 4096 could exhaust an 8 GB host before either hit its own limit.
3. **`WORKER_POLL_INTERVAL_MS` 2000 → 15000.** Every tick runs `recoverStaleRuns` and `findApprovedTasks` against Postgres, so at 2 s a managed database never scales to zero and bills as always-on. 15 s stays well inside `STALE_RUN_MS` (2 min) and the 15 s run heartbeat, and only delays picking up a new task by that much. Code defaults are unchanged; this is the production template.
4. **GitHub access for the VPS: a read-only deploy key** (D-041). §5 step 3a generates it on the host; the private half never leaves it and no PAT is created. The clone URL in §5 was also a placeholder that could never have worked — it is now the real repository.

5. **`.gitignore` hardened** to `.env*` with `!.env.example`, so pulling the production values down cannot make them committable.
6. **The domain and host became real** and are recorded in §5's pre-flight table: `orchestrator.noteawork.com` → `178.105.211.58`, Cloudflare DNS but **DNS-only** (a proxied record would terminate TLS at Cloudflare and break both Caddy's ACME challenge and the browser's direct `wss://`), Ubuntu 26.04.1 LTS (`resolute`). Step 1 was rewritten for that release after checking each upstream against the codename: Docker CE and Caddy's Cloudsmith repo both publish `resolute`, and NodeSource is codename-independent (`nodistro`).
7. **Both shared secrets were rotated** by the owner: Vercel had them as write-only "Sensitive" variables, so they could not be copied to the host. Deleted and re-created with owner-chosen values, Production only.

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
