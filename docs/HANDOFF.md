# Notea Workspace — Handoff

Written 2026-09-15, updated at the end of session 11 (frontend polish; three defects found in the browser). Session 10 reviewed the whole project (17 fixes), session 9 prepared the deployment and session 8 migrated development from Windows 11 to Ubuntu 26.04. Self-contained; the conversation is not needed. **Work in `~/ClaudeProjects/notea-workspace`** (§28), not in the backup. Read `CURRENT_STATE.md` next, then `ARCHITECTURE.md`, `AGENT_SYSTEM.md`, `DECISIONS.md`, `SECURITY_MODEL.md`, `DEPLOYMENT.md`.

## 1. Product summary

Self-hosted, browser-based shared development workspace: one persistent Linux container per project, shared terminals and files, several humans and several AI coding agents (any provider) working together with worktree isolation and human-approved integration. Personal use first. `PROJECT_SPEC.md`.

## 2. Current goal

1. ~~**Deploy the runtime host.**~~ **Done**: both halves are live. The host (`orchestrator.noteawork.com`) was set up on 2026-09-22, upgraded to current code in session 11, and rebooted onto its updated kernel (`7.0.0-31`) the same day; everything came back on its own.
2. **Use it for real, remotely**: sign in on the Vercel URL, create or open a workspace, connect a credential under AI & Claude, **Check** it, and run a task on the host. Only the owner can do this (it needs the account password), and it is the first end-to-end use of the deployed system beyond opening a workspace.
3. **A credential for Niche** (he has a production account, `niche@notea.mk`, since session 11, not yet a member of a workspace), so the second member can run agents on his own account. The mechanism is built and proven for one member; it has never been exercised with two credential owners at once.
4. Codex and Gemini authenticated runs, which need an OpenAI and a Google credential and have their own parsers.
5. M2 leftovers: file watcher (`fs.changed` for terminal-side edits), invites by link.

## 3. Current architecture

Browser ⇄ Next.js control plane (`apps/web`, Postgres) ⇄ REST+API key ⇄ Orchestrator (`apps/orchestrator`, Docker) ⇄ workspace container running the agent (`packages/workspace-agent`). Browser and worker open WebSockets through the orchestrator bridge with short-lived JWTs. The worker (`apps/worker`) polls Postgres for tasks, connects to workspaces as an agent participant, and drives runtimes from `packages/agents`. Diagrams and flows: `ARCHITECTURE.md`.

## 4. Technology stack

Node 24, TypeScript 5.9, npm workspaces, zod 4, ws 8, node-pty 1.1, Fastify 5, dockerode 5, jose 6, Next.js 16.3 (App Router, Turbopack), React 19, Tailwind 4, Auth.js 5 beta (credentials), Drizzle 0.45 + postgres.js, Postgres 17, xterm.js 6, CodeMirror 6, Motion 13 + lucide-react + IBM Plex via `@fontsource` (the UI, D-044), vitest 4, esbuild, tsx. Image: Debian bookworm + Node 24 + git + build tools + Claude Code/Codex/Gemini CLIs.

## 5. Repository structure

`CURRENT_STATE.md` has the tree. Apps are processes (`orchestrator`, `web`, `worker`); packages are libraries; `infra` holds the image and compose files; `docs` is the truth.

## 6. Implemented and tested

Everything listed under "Implemented behaviour" in `CURRENT_STATE.md`: protocol 1.1, agent daemon, orchestrator (incl. image-upgrade recreation), control plane with auth/roles/workspaces/members/terminal/editor/tasks/credentials, agents package, worker (incl. the worktree/branch reaper). **194** unit/integration tests (169 before session 10, 186 before session 11; each fix adds its regression test) + 3 Docker e2e + browser verification of the workspace UI and the complete task pipeline, and — since session 8 — the same suite re-run on Ubuntu 26.04 with the two-user model and an authenticated agent run driven live. Session 11 drove every screen and action in real Chrome through Claude in Chrome.

## 7. Partially implemented

- Collaboration (M2): membership, roles, shared terminals, presence, `fs.changed` notices and sign-in rate limiting exist; missing: watcher for terminal-side edits, invite links, activity feed for connection events.
- Agent runtimes: all three have their own parsers and have been executed against the real CLIs. Claude Code has run authenticated end to end (twice, §23a–§23b); Codex and Gemini stop at their credential check, because no OpenAI or Google credential exists yet.
- Cost tracking: usage from Claude Code `result` records is aggregated per run/task; no budgets or per-user totals.

## 8. Not started

Previews (port detection + proxy), invites by link, CRDT editing, ESLint, multi-host orchestration, billing. (Deployment templates exist in `infra/deploy/`; the host itself is not set up.)

## 9. Database

`DATABASE_SCHEMA.md`. Tables: users, workspaces (with `coordination_policy`), workspace_members, workspace_events, provider_credentials, agent_tasks, agent_runs, agent_run_events. Migrations `packages/db/drizzle/0000_*.sql` … `0004_*.sql` (five); apply with `npm run migrate -w @notea/db`. All five are applied to the deployed Neon database.

## 10–12. Runtime, terminal, realtime

Unchanged from session 1 (`ARCHITECTURE.md` §4–6) plus: exec processes bound to the requesting connection; per-session env injection; containers recreated on start when the image tag points at a new image id.

## 13–15. Agents, providers, coordination

`AGENT_SYSTEM.md` (now describes what is implemented). Key files: `packages/agents/src/{types,providers,runtimes/claude-code,git,integration,tasks,brief}.ts`, `apps/worker/src/processor.ts`.

## 16. Security model

`SECURITY_MODEL.md`. New since session 1: credentials encrypted at rest (AES-256-GCM, `CREDENTIALS_KEY`), injected only into the agent process, which runs as the task owner's own uid (D-039); exec env allow-list (reserved names rejected); agent runs use `--dangerously-skip-permissions` inside the container/worktree sandbox with human review before integration (D-025); tasks/policies gated by roles server-side.

## 17. Important decisions

`DECISIONS.md` D-001…D-044. Do not casually reverse: identify-first bridge (D-007), hardening (D-009), HOME volume (D-010), worktree-per-task + serialized integration (D-013), stateless orchestrator (D-005), worker as a separate process (D-026), agent processes under the owner's uid (D-039, which superseded D-024's watchable run terminals), same-page actions that revalidate instead of redirecting (D-043), the UI's design tokens (D-044).

## 18. Known bugs

None open. Session 11 found three by driving the UI in Chrome and fixed them: **queueing a task, saving the policy or adding a member discarded unsaved editor text** (same-page server actions redirected to the page they came from, and Next remounts the whole page when it rethrows that redirect into the form; D-043), and **Chrome filled the Notea login into the provider-token form**, where one click on Connect would have submitted the account password as a provider secret, and **a terminal that finished attaching took the keyboard from the editor**, sending the rest of the typing to a shell. It also stopped the task list from reshuffling on refresh. One limitation remains by design: a *failed* action still redirects with `?error=` and so still remounts the page (`CURRENT_STATE.md` debt item 18). Session 10 reviewed every source file and fixed 17 defects, each with a regression test that fails on the old code (`CURRENT_STATE.md` → Session 10). The ones that mattered: **every isolated agent run was killed by the orchestrator after 10 minutes**, whatever the task's `max_minutes`, and reported as `failed` (`startTerminalRun` never passed its deadline, so the orchestrator's exec default applied); **an agent quiet for 5 minutes lost its run** (Node's fetch dropped the silent output stream, the run read as `failed`, and the agent kept working unwatched; now keepalive frames, and a lost stream stops its process from either end); **a git command in flight when the workspace connection dropped hung the worker forever** (`runExec` waited for an exit event that could no longer arrive); **a task whose worker died mid-integration stayed `integrating` for good** (now retried, D-042); **the bridge dropped frames sent while it was still verifying the token** (the web UI's first file-tree request) and left a ghost connection when a client left during that window; **the editor threw away unsaved edits on every reconnect** and could show one file's content under another's path; **Gemini runs could not start in a fresh workspace** (their settings went to `/home/dev`, which the agent uid cannot write). Session 9 fixed one that only production would have shown: the worker registered its SIGTERM/SIGINT handlers *after* its infinite poll loop, so they were unreachable and `systemctl stop|restart notea-worker` abandoned in-flight runs (`CURRENT_STATE.md` → Session 9). Session 8 found none: the migration to Linux required no source change, and the three fixes it did make were working-copy file modes, three Windows leftovers in `.git/config`, and `0600` on the files holding secrets. Session 6 closed the `/proc` credential exposure architecturally (D-039) and separated subscription from API billing (D-040); session 7 re-proved the isolation by hand against a live container and fixed the one defect that work left behind — `ensureSharedLayout` ran `chmod -R g+rwX .git`, which fails as soon as an agent uid owns objects in `.git`, taking the run with it (now `find .git -user "$(id -u)"`). Session 5 resolved the worktree/branch leak (formerly technical debt) with a worker-side reaper, verified against the live container (D-038). Fixed in session 4, each with tests: connect tokens written to the orchestrator log (D-033); the worker exceeding its concurrency limit (D-034); the integration lease released while another task still needed it (D-035); a lost terminal-exit notification hanging a run forever (D-036); an overridden failure losing the CLI's explanation (D-037). Earlier sessions: Next 16 `allowedDevOrigins`, provider constructed during SSR, proxy matcher export name, stale container image after rebuild.

## 19. Technical debt

`CURRENT_STATE.md` "Known issues and technical debt" (17 items).

## 20. Blockers

**None.** The deployment blocker is closed: both halves are live (below). The host has been rebooted onto its updated kernel and libc (2026-09-23); Caddy, Docker, the orchestrator, the worker and the running workspace all came back on their own.

The credential blocker is **closed**: a Claude subscription token is stored for `andrej@notea.mk` and has now driven two authenticated runs end to end — the first on Windows (§23b) and a second on Linux after the migration (§23a). The stored credential survived the move and needed no re-authentication. Anthropic is covered; **OpenAI and Google still have no credential**, so Codex and Gemini runs still stop at their own auth checks — a missing credential, not a defect. **Niche has no credential either**, so the two-member-two-accounts case is built and unit-tested but has never run for real.

**Both halves are deployed.** `apps/web` is live at https://noteaworkspace-web.vercel.app against a Neon Postgres, and the runtime host `orchestrator.noteawork.com` (`178.105.211.58`, Hetzner, Ubuntu 26.04.1) runs Caddy with Let's Encrypt, the orchestrator, the worker and Docker (`CURRENT_STATE.md` → Deployment status). The host was set up on 2026-09-22 and the docs missed it; session 11 found it working (the web app had created a workspace on it and the owner had opened it), then upgraded it from `a4a42c3` to `3c7382f` and rebuilt the workspace image. The repository is https://github.com/nikolovskiandrej/noteaworkspace; the host pulls it with a read-only deploy key.

The host is hardened (2026-09-23): SSH is key-only (`/etc/ssh/sshd_config.d/10-notea-hardening.conf`) and `ufw` allows only 22, 80, 443/tcp and 443/udp (`DEPLOYMENT.md`, host state). Both changes were applied with an automatic rollback that was cancelled only after a fresh key login, HTTPS and the containers' networking had been verified, and both survived a test reboot. Production accounts: `andrej@notea.mk` (owner of `notea`) and `niche@notea.mk` (`DEPLOYMENT.md`, host state).

## 21. Tested / 22. Not tested

Tested: see §6 and the verification table in `CURRENT_STATE.md`, which now covers the browser UI, real cancellation, real timeouts and real (unauthenticated) runs of all three CLIs.

Not tested: **two members running agents on their own separate credentials at once** — the product's whole point, and the one real gap now; authenticated Codex and Gemini runs; more than one worker process; long-running (hours) sessions — an 11-minute run is the longest exercised; a real phone or tablet (session 11 checked those widths in desktop Chrome, not on a device or a touch screen); an orchestrator or worker restart in the middle of a real agent run (each end's handling of a lost stream is unit-tested, not driven against a live restart).

No longer untested as of session 8: `network` connect mode, and an authenticated agent run on Linux. As of session 10: the browser UI on Linux (headless Chrome, 9 checks, `CURRENT_STATE.md` → Session 10), and an agent run longer than 10 minutes through the real orchestrator. As of session 11: every screen and action in real Chrome (Claude in Chrome), with the production build, and the layout at phone and tablet widths.

## 23. Exact current state (session 11)

**The browser UI has one design system, and three defects found by using it in Chrome are fixed.** Nothing was left uncommitted by session 10, so the session started from a clean `main`. The UI now has tokens, IBM Plex, status pills, menus and a real delete dialog, restrained motion and a phone/tablet layout (D-044); no functionality, route, API or form field changed. The fixes: same-page server actions no longer remount the page, which had discarded unsaved editor text whenever someone queued a task, saved the policy or added a member (D-043); Chrome no longer fills the Notea login into the provider-token form; a terminal no longer takes the keyboard from the editor when it attaches; the task list keeps a stable order. Suite 186 → **194** passed / 3 skipped, typecheck clean, production build 7 routes, 3 Docker e2e green. Every screen and action was driven in real Chrome against the dev server and the production build, on throw-away data. The details are in `CURRENT_STATE.md` → Session 11.

State left behind: the work is on `main` and pushed to GitHub, which also redeploys the control plane on Vercel (`ae339c4` the UI; `3c7382f` a reaper fix found on the production host). The runtime host runs `3c7382f` with a rebuilt `notea/workspace:dev`; its one workspace was recreated on that image. The owner then rebooted the host onto its updated kernel; everything came back on its own. New web dependencies: `motion`, `lucide-react`, `@fontsource-variable/ibm-plex-sans`, `@fontsource/ibm-plex-mono` and the explicit `@lezer/highlight`; `@codemirror/theme-one-dark` was removed. The demo workspace's container already runs the current image (checked by hash), so the session-10 advice to recreate it no longer applies. The throw-away `notea_ui` database and workspace used for the browser pass were removed; no service is left running.

### Session 10 (previous)

**Every source file was reviewed; 17 defects were fixed, each with a regression test that fails on the old code.** No architecture changed; one recovery rule was added (D-042). Suite 169 → **186** passed / 3 skipped, typecheck clean, production build 7 routes, 3 Docker e2e green on a rebuilt image. The full list and the evidence are in `CURRENT_STATE.md` → Session 10.

The headline: **no isolated agent run could last more than 10 minutes, or survive 5 quiet ones.** Since D-039 (session 6), every run went through the orchestrator's agent-exec, which gave it the orchestrator's 10-minute default because `startTerminalRun` never passed the run's deadline; and before that limit, Node's fetch dropped the output stream of any agent quiet for 5 minutes, reporting the run `failed` while the agent kept working. The authenticated runs so far took seconds to a minute, which is why neither showed. Both are fixed and were proved end to end: an 11-minute process now completes, where the old path was killed at 600.9 s and, before the keepalive, both died at 301.7 s. Lost streams no longer leave agents running unwatched, from either end.

Also fixed and verified in a real container or browser: Gemini runs could not start in a fresh workspace; the editor lost unsaved edits on every reconnect (reproduced on the old build in headless Chrome); the bridge dropped the UI's first request when the token check was slow. The worker no longer hangs on a dropped workspace connection, recovers integrations its predecessor abandoned, and cannot mark an integrated task `failed`.

State left behind by session 10: its work is `6be44b6` on `main`, pushed to GitHub (which also redeploys the control plane on Vercel); `notea/workspace:dev` was rebuilt with the fixed agent daemon, and the demo workspace's container has since been recreated on it. The test database was left as the suites leave it.

## 23a. Prior state (session 8)

**The project was migrated from Windows 11 to Ubuntu 26.04 and re-proved there. Nothing was rewritten; the architecture is unchanged.**

The Windows machine is gone — the Ubuntu install took the `D:` partition that held `D:\ClaudeProjects`. Recovery came from a pre-migration backup (now `~/Documents/Linux_Backup`), which was verified before use: 137,318 files present at their recorded size, and 2,098 SHA-256 checksums all matching. The repository restored to `~/ClaudeProjects/notea-workspace` with its history whole (`git fsck` exit 0, full reflog, HEAD `bfb0ee6` == `origin/main`, working tree clean), and every restored file was re-hashed against the backup.

**The code needed no changes to run on Linux.** There was no `C:\`, no `.exe`, no `cmd.exe` and no backslash path in application code; `.env` worked unchanged. The only platform branch is the deliberate one in `apps/orchestrator/src/config.ts`, and it did what it was written to do. Three things were fixed, none of them source: 193 working-copy file modes (NTFS has no Unix mode bits, so every file arrived `0755`; git has them as `100644`), three Windows leftovers in `.git/config` (`filemode`, `symlinks`, `ignorecase` — the last is unsafe on a case-sensitive filesystem), and `0600` on `.env` and `.tmp/*`, which had arrived world-readable.

**The environment reproduces the Windows results exactly**: typecheck clean across 9 workspaces, **167 passed / 3 skipped**, `next build` 7 routes, and a `dist/agent.cjs` that is byte-identical to the one built on Windows. `node-pty` compiled from source and was proved by spawning a real PTY rather than merely importing.

**The data came across whole.** The dev database was restored from the raw volume (captured after a clean shutdown) into PostgreSQL 17.11, and every row count matches what the backup recorded, including the five applied migrations — `npm run migrate` was a no-op. The workspace HOME volume restored with `/home/dev/.notea/agents/20003` and `/20004` still owned by their own uids at mode `2700`, so the D-039 identity separation survived a tar round trip, along with all five task worktrees and session 7's `a83cffe`.

**Two things that had never been tested now are.** `AGENT_CONNECT_MODE=auto` resolves to `network` on Linux, so the orchestrator reaches the agent on the container IP with no published port; the Docker e2e, a live two-client session and a real agent run all ran over it. And the two-user model was exercised live rather than read from the schema: Andrej (`owner`) and Niche (`editor`) connected to the same workspace at once, presence listed both, Andrej opened a PTY and **Niche attached and received the same output**, both read shared files, and exec through the bridge exited 0.

**A second authenticated Claude run completed end to end**, on the credential stored back on Windows — it survived the migration and needed no re-authentication (`claude auth status --json` inside the container as uid 20003 reports `oauth_token`). The task went `queued → needs_review → approved → done` in 10.8 s for $0.0736: `MIGRATION.md` written **owned by uid 20003**, fast-forwarded to `main` as `6271618` with zero merge commits, branch reaped in ~6 s, and zero `sk-ant-` matches across every log, every database table and the container's entire `git log -p --all`. Its real stream-json records were then captured as fixtures in `packages/agents/test/runtimes.test.ts`, which is the piece §24 step 2 had been asking for since session 7.

Linux turned out to be *stronger* for the security property this project cares about: the host's `kernel.yama.ptrace_scope=1` refuses even same-uid non-descendant `/proc/<pid>/environ` reads, a layer Docker Desktop never provided.

Not done, and why: **no browser pass on Linux** (the stack was driven over HTTP and WebSockets, not through Chrome), and **no second credential**, so two members running agents on their own accounts simultaneously remains the one untested claim.

## 23b. Prior state (session 7)

**Session 6's work is complete, committed and independently verified; the repository is ready for GitHub and for the Vercel half of the deployment.**

Session 6 (commit `a2e29d3`) fixed the credential exposure architecturally: `users.agent_uid` gives every member a Unix uid (20001+), the orchestrator's `POST /workspaces/:id/agent-exec` starts agent processes under it through the Docker daemon, and `IsolatedAgentSession` adapts that to the existing runtime interfaces so no runtime changed (D-039). It also split subscription from API billing: `provider_credentials.auth_mode` decides the single environment variable a run gets, and the others are cleared inside the container (D-040). It left the rest uncommitted; session 7 finished and committed it as `8af40d6`.

Session 7 did four things. **It fixed the one defect session 6 left behind**: `ensureSharedLayout` ran `chmod -R g+rwX .git`, which succeeds only until an agent uid owns objects in `.git` — after that `dev` cannot chmod them, the command exits non-zero and takes the run with it. It now touches only `find .git -user "$(id -u)"`, which suffices because agents run with `umask 002`. **It re-proved the isolation by hand** rather than trusting the suite: two processes as uid 20003 and 20004, each holding a distinct marker key; each can read its own `/proc/<pid>/environ`, and uid 20003 → 20004, uid 20004 → 20003 and `dev` → both all fail with `Permission denied`, with `CapEff=0` and `NoNewPrivs=1` still reported and `setpriv`/`hidepid` still refused. **It ran everything**: typecheck across 9 workspaces, 167 tests passed / 3 skipped with a database attached, the 3 Docker e2e tests, and a production `next build` (7 routes). **It prepared deployment**: `DEPLOYMENT.md` plus `infra/deploy/` templates, and a scan showing no real secret, private key or machine-specific path in any tracked file.

Not done, and why: **no authenticated agent run**, because `provider_credentials` is empty (§20). Session 7 re-confirmed the exact boundary — the CHANGELOG task's run ends `failed`, exit 1, `Not logged in · Please run /login`, events parsed correctly, nothing secret persisted anywhere.

## 23c. Prior state (session 5)

**A worker-side worktree/branch reaper was added, and the agent package's git layer was cleaned up.** `apps/worker/src/reaper.ts` runs on the worker tick (`WORKER_REAP_INTERVAL_MS`, default 60 s): it removes the worktree and branch of a deleted task (archiving the branch tip to `refs/notea/archive/<id>` first) and the merged branch of an integrated task, keeps re-runnable and active tasks, in-use worktrees and `main`, scans only running containers, and skips a workspace while any task there is active (D-038). Verified against the demo container: it reaped exactly the one leftover `done` branch and was idempotent. `GitWorktrees` gained the read/query/delete helpers this needs, `removeTaskWorktree` is now single-purpose, and `packages/agents/src/layout.ts` centralises run-artefact paths (the four runtimes use `runBriefPath` instead of hardcoding). Suite: agents 28 → 31 (git parser guards), worker 8 → 17, total 133 → 145, all green; typecheck and `next build` clean.

This built on an incomplete, uncommitted refactor of `git.ts` (the reaper helper toolkit) plus `layout.ts` found in the working tree at session start; that work was adopted and finished rather than discarded, and `processor.ts` was updated to the new single-arg `removeTaskWorktree`.

## 23d. Prior state (session 4)

**The migration was re-verified independently, and the agent pipeline was hardened.** Storage: Docker's data disk is at `D:\DockerDesktop\wsl` (confirmed from Docker's own settings API and the WSL registration), nothing of this project's remains on C:, and the repository contains no C: paths outside documentation. Environment: all four migrations applied and in sync with the journal, Postgres on 55432 with the other project's Postgres untouched on 5432, container hardening intact (non-root `dev`, `CapDrop ALL`, `no-new-privileges`, no bind mounts), all three agent CLIs present in the running container.

Verified for real, not with mocks: the browser UI end to end (sign-in session, file tree, editor save written through to the container, terminal as `dev`, presence, tasks panel); cancellation (a `sleep 300` task cancelled, process killed, run `cancelled`); the max-minutes timeout (a 1-minute task ended at exactly 60 s with outcome `timeout`); and real runs of all three CLIs, each stopping at its own credential check with correctly parsed events.

Five defects were found and fixed, each with tests: connect tokens were being written to the orchestrator log (D-033); the worker could exceed its concurrency limit and claim every queued task in one tick (D-034); the integration lease could be released while a second task still needed it (D-035); a lost terminal-exit notification would hang a run forever, out of reach of stale-run recovery (D-036); and an overridden failure lost the CLI's explanation (D-037). Suite: 24 files, all green — agents 28, workspace-agent 42, orchestrator 21 (+18 Docker e2e), web 13, protocol 6, workspace-client 6, worker 8, db 1.

## 23e. Previous state

**The disk problem is fixed.** Session 3 moved Docker's data disk, the npm cache and test scratch off C: onto D: (`ARCHITECTURE.md` §12); C: went from 1.01 GB free to 22.19 GB free, and a full `npm run build:image` now writes nothing to C:. The whole stack was re-verified on the new storage: typecheck, every test suite (including the db/worker suites against a real Postgres and the orchestrator's real-Docker e2e), a production `next build`, an image rebuild, container recreation with the HOME volume preserved, and a `generic-cli` task driven from `queued` to `done`.

The `demo-project` workspace exists in the dev database (`ebc7f427-…`); its container runs the freshly rebuilt image containing claude-code 2.1.272, codex-cli 0.154.0 and gemini-cli 0.59.0, and its volume holds the integrated agent commits. Background processes started for verification (orchestrator, web dev server, worker) are stopped at handoff.

## 24. Exact next step

**Done in session 8 — the project runs on Linux and step 2 below is closed.** The environment was migrated, re-verified, and the pipeline driven end to end again under a real Claude subscription over `network` connect mode. The authenticated fixtures session 7 asked for are now in `packages/agents/test/runtimes.test.ts`.

The next steps are now:
1. ~~**Deploy the runtime host**~~ — **done** (set up 2026-09-22, upgraded in session 11). It is also hardened (key-only SSH, `ufw`; §20). Upgrading it later is `DEPLOYMENT.md` §7: `git pull`, `npm ci`, `npm run build:image` as `notea`, restart both units, then stop and start each workspace.
2. ~~**Capture fixtures**~~ — **done in session 8.** Real authenticated `thinking`/`tool_use`/`tool_result`/`result` records from claude-code 2.1.272 are pinned in `packages/agents/test/runtimes.test.ts`, together with `rate_limit_event`, a record type no earlier fixture had seen.
3. **Give Niche a credential** and run two members' agents at once. Everything for it exists and is unit-tested; it has never run for real, and it is the product's central claim.
4. **Codex and Gemini** — repeat the authenticated run for each once a credential exists.
5. ~~**A browser pass on Linux.**~~ — **done**: headless Chrome in session 10, and every screen and action in real Chrome (Claude in Chrome) in session 11.
6. M2 leftovers: file watcher for terminal-side edits, invites by link.
7. **Errors as action state.** Failed actions still report through a `?error=` redirect, which remounts the page (CURRENT_STATE debt 18); moving the workspace forms to `useActionState` would keep unsaved editor text on failures too.

## 24b. How the first authenticated run was done (session 7)

1. Start the stack: `docker compose -p notea-dev -f infra/compose/docker-compose.dev.yml up -d`, then the orchestrator, web and **exactly one** worker (§29).
2. Sign in as `andrej@notea.mk`, open **Settings → AI & Claude**, and connect a credential: run `claude setup-token` yourself and paste the `sk-ant-oat01-…` token (subscription, billed to your Claude plan), or paste a console API key (metered). The UI names the billing relationship on each; **Check** runs `claude auth status --json` inside a real container under your own uid and shows what the CLI reports.
3. Re-queue "Claude: add a CHANGELOG entry" and watch the first *authenticated* run: the agent should edit inside `/home/dev/.notea/worktrees/<taskId>` as your own uid, the task should reach `needs_review` with a real diff stat, and approving it should rebase and fast-forward `main`. Add the real `assistant`/`tool_use`/`result` records as fixtures next to the unauthenticated ones in `packages/agents/test/runtimes.test.ts`.
4. Then deploy: `DEPLOYMENT.md` §3 (GitHub) and §4-§5 (Vercel for `apps/web`, a Linux host for the orchestrator, worker, Docker and Postgres).

## 24a. Superseded next step (session 5)

**The only blocker is a credential, and it needs you.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY` are all unset and `provider_credentials` is empty, so every agent run stops at its CLI's auth check. Everything up to that boundary is verified.

1. Start the stack: `docker compose -p notea-dev -f infra/compose/docker-compose.dev.yml up -d`, then orchestrator, web and **exactly one** worker (§29).
2. Provide a credential — store an Anthropic key under Settings → Credentials, or run `claude login` in a workspace terminal.
3. Re-queue "Claude: add a CHANGELOG entry" and watch the first *authenticated* run: the agent should edit inside `/home/dev/.notea/worktrees/<taskId>`, the task should reach `needs_review` with a real diff stat, and approving it should rebase and fast-forward `main`. Add the real `assistant`/`tool_use`/`result` records as fixtures next to the unauthenticated ones already in `packages/agents/test/runtimes.test.ts`.
4. Then pick up, in rough order of value: live run events instead of the 5 s refresh (`IMPLEMENTATION_PLAN.md` step 3) and the M2 leftovers. The worktree/branch reaper is done (session 5, D-038).

(The session-5 warning that a collaborator with terminal access could read a running task's key through `/proc` no longer applies: D-039 fixed it and session 7 re-verified it. `SECURITY_MODEL.md` → Agent identity isolation states what is and is not covered.)

## 25. Files to inspect first

1. `packages/protocol/src/messages.ts` — the contract.
2. `apps/worker/src/processor.ts` — the task lifecycle end to end.
3. `packages/agents/src/runtimes/claude-code.ts`, `terminal-run.ts` — how a run executes and is parsed.
4. `packages/agents/src/git.ts`, `integration.ts` — isolation and integration.
5. `apps/web/src/lib/{workspaces,tasks,authz}.ts` — control-plane rules.
6. `apps/orchestrator/src/docker/workspace-runtime.ts` — container lifecycle.
7. `apps/web/src/components/{workspace-view,tasks-panel,terminal}.tsx` — UI; `apps/web/src/app/globals.css` holds the design tokens and component classes, `components/ui/` the shared pieces (buttons that show pending, menu, dialog, status, segmented tabs) (D-044).
8. `apps/web/src/lib/actions.ts` with `stay-on-page.ts` — why same-page actions revalidate instead of redirecting (D-043).

## 26. Do not change casually

Listed in §17, plus: protocol message names (additive only), `/home/dev/project` layout, task status names (the UI, worker and tests depend on them), the rule that the worker never edits the main tree except through fast-forward integration.

## 27. Assumptions

Personal use on owner-controlled hosts; Docker available; collaborators are invited people; agent CLIs remain the primary runtimes; a human approves integration by default.

## 28. Environment and setup

`.env` at the repo root (`.env.example` lists every variable): orchestrator secrets, `DATABASE_URL`, `AUTH_SECRET`, `ORCHESTRATOR_URL`, `CREDENTIALS_KEY` (shared by web and worker), optional worker tuning. Next.js and the worker load the root `.env` automatically. The Docker daemon must be running (`systemctl is-active docker`).

**The development machine is Ubuntu 26.04.1 since session 8** (repository at `~/ClaudeProjects/notea-workspace`). What a fresh Linux machine needs, and nothing more: `git`, `build-essential` (node-pty compiles from source), **Node 24 from NodeSource** — Ubuntu ships 22, below the `engines` floor — Docker Engine + the Compose plugin from Docker's own repository, and `postgresql-client` if you want to touch the database from the host. Add your user to the `docker` group; the membership only applies after a re-login.

`AGENT_CONNECT_MODE=auto` resolves to `network` here, so workspace containers publish no host port. The Windows storage workarounds are gone: Docker keeps its data at `/var/lib/docker` and npm its cache at `~/.npm`. Test scratch still travels with the repository at `<repo>/.tmp` (`vitest.shared.mjs`). `ARCHITECTURE.md` §12 describes the old Windows layout and is history, not instructions.

The pre-migration backup lives at `~/Documents/Linux_Backup` and is **read-only**: `Projects/docker-volumes/` holds the database dumps and raw volume tarballs (some contain secrets in plaintext), `Projects/_BACKUP_INFO/` the manifests, checksums and restore procedure.

**Start sessions in `~/ClaudeProjects/notea-workspace`, never in the backup.** The backup still contains a full git clone (`Projects/D_ClaudeProjects/notea-workspace`), and session 9 was run inside it by accident — an assistant started in `~/Documents/Linux_Backup/Projects` finds that clone first. Its commits reached GitHub from there, so nothing was lost, and session 10 fast-forwarded the working copy to them; but the backup clone carries the Windows-era git config (`core.ignorecase=true`, `core.filemode=false`) and world-readable secret files, and every edit there drifts the "read-only" backup away from its recorded checksums. Before working, `git -C ~/ClaudeProjects/notea-workspace fetch && git status` should say the branch is up to date with `origin/main`.

## 29. Commands

| Purpose | Command |
|---|---|
| Dev Postgres | `docker compose -p notea-dev -f infra/compose/docker-compose.dev.yml up -d` (127.0.0.1:55432; **never 5432**) |
| Migrate | `npm run migrate -w @notea/db` |
| Create a user | `npm run create-user -w @notea/web -- <email> <name> <password>` |
| Build image | `npm run build:image` |
| Orchestrator | `npm run dev:orchestrator` (or `npx tsx src/index.ts` in `apps/orchestrator`) |
| Web | `npm run dev -w @notea/web` → http://127.0.0.1:3000 |
| Worker | `npm run dev -w @notea/worker` |
| Seed dev users | `npm run seed:dev -w @notea/web` (creates Andrej and Niche with agent uids) |
| Tests | `npm run typecheck && npm test` — set `DATABASE_URL` to a **throw-away** database for the db/worker/web suites (`CREATE DATABASE notea_test`); the worker suite deletes tasks in `beforeEach` |
| Docker e2e | `npm run test:e2e -w @notea/orchestrator` |

## 30. Open questions

1. Whether to run the worker inside the orchestrator process for single-host deployments (simpler ops) or keep it separate (current).
2. `node_modules` strategy for worktrees (currently none; agents must install per worktree if needed).
3. Preview proxy design (path vs subdomain).
4. Whether task branches should be deleted after integration (currently kept).
5. How to surface run events live (currently page refresh every 5 s while tasks are active).
