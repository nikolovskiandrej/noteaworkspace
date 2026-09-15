# Notea Workspace — Current State

Last updated: 2026-09-15, end of Fable 5.1 session 2. Update this file whenever reality changes.

## One-line status

**M0 (runtime), M1 (control plane + browser UI) and the core of M3 (agent tasks in isolated worktrees with human-approved, serialized integration) are implemented, tested, and verified end to end in Docker from the browser. M2 collaboration is partially done (membership, roles, shared terminals, presence, file-change notices). A real run with the Claude Code CLI has not been executed yet (needs a user credential).**

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
| `npm test` (with `DATABASE_URL` set) | OK: protocol 6 · workspace-agent 42 · orchestrator 17 (+1 e2e skipped) · workspace-client 6 · db 1 · agents 20 · web 18 · worker 4 |
| `npm run build:image` | The image with exec support was built and is in use (1.06 GB). The Dockerfile now also installs the Claude Code / Codex / Gemini CLIs, but **that build failed twice because the host's C: drive filled up** (Docker's VM went read-only); the local `notea/workspace:dev` therefore does **not** contain the CLIs yet. Free disk space and run `npm run build:image` again, then stop/start workspaces. |
| `npm run test:e2e -w @notea/orchestrator` | OK: container create → terminal I/O → exec with injected env → file persistence across restart → cleanup |
| Browser (Chrome) | sign-in, workspace creation, live terminal, file tree, editor save with etag, presence, tasks panel |
| Agent pipeline (Docker, from the UI) | `generic-cli` task: queued → running (worktree `notea/task/<id>`, agent participant visible) → needs_review (diff stat) → approve → integrating (rebase, ff-merge into `main`, worktree removed) → done; verified with `git log` inside the container |

Without `DATABASE_URL`, the db/web/worker database suites skip themselves.

## Implemented behaviour (summary)

- **Protocol v1.1**: identify-first trust, terminals (create/attach/detach/input/resize/kill/list, per-session env), files (list/read/write with etag, `fs.changed` broadcast), exec (start/stdin/kill with streamed output, env allow-list, timeouts, output caps, killed on disconnect), presence, roles.
- **Orchestrator**: hardened containers (non-root, cap-drop ALL, no-new-privileges, cpu/mem/pids limits, no bind mounts), HOME volume, `published`/`network` connect modes, connect JWTs, API-key REST, WebSocket bridge, **container recreation on start when the image was rebuilt**, dev console.
- **Web**: Auth.js credentials (scrypt), server-side membership roles (owner/editor/viewer) on every action, workspaces CRUD, members, terminal tabs (agent sessions badged), CodeMirror editor with conflict detection and change notices, presence, activity, tasks panel (create/approve/cancel/requeue/delete, run event log, policy editor), credentials settings (AES-256-GCM).
- **Agents**: provider catalog and credential env mapping; `AgentRuntime` interface; Claude Code headless runtime (`claude -p … --output-format stream-json`, parsed defensively); Codex/Gemini/generic runtimes via `GenericCliRuntime`; runs execute in watchable terminal sessions; git worktree per task; brief generator; scope overlap detection; task state machine; serialized integration (rebase → optional check command → fast-forward).
- **Worker**: polling loop, scope-lease-aware claiming, per-run heartbeat and cancellation, event persistence, auto-commit of leftover changes, review/auto-approve per policy, integration with per-workspace mutex, stale-run recovery.

## Known issues and technical debt

1. **Claude Code, Codex and Gemini CLI flags are unverified** against the installed versions (2.1.272 / 0.154.0 / 0.59.0); only the generic runtime has been executed for real. First real run needs a credential or a CLI login inside the workspace.
2. **No ESLint/Prettier** (D-018).
3. **Image size** (Node + build tools + three CLIs); a slim variant is possible.
4. **`fs.changed` covers API writes only**; terminal-side edits are caught by the etag check at save time, not proactively.
5. **No sign-in rate limiting** yet (M2 item).
6. **Tasks listing does N+1 queries** (fine for personal scale).
7. **Single worker process**; claims are optimistic (`UPDATE … WHERE status='queued'`), safe for one or a few workers.
8. **No automated Docker e2e for the worker pipeline** (verified manually; the unit test covers the logic with fakes).
9. **Windows development** relies on `published` connect mode; `network` mode is untested on a Linux host.
10. **Dev console** (`DEV_CONSOLE=true`) mints tokens without auth; keep it off on reachable hosts.
11. Old server-side artefacts: none known. Sessions do not survive container restarts (by design).
12. `next build` should be re-run before deploying; the dev server was used for the last UI verification.

## Incident during session 2: host disk full

The Windows C: drive was at 99% before the session (Docker Desktop's VM disk and caches live there). Repeated image builds used the rest; Docker's VM remounted read-only, the dev Postgres started failing queries, the worker crashed, and image builds failed. Recovery done: my temp logs and npm cache cleaned, Docker Desktop restarted (the other project's containers came back on their own restart policies), the dev Postgres restarted; only build-cache entries from this session's builds were pruned (they were small). **C: is at 100% at handoff.** Nothing of the other project was deleted. Recommended for the owner: prune old build cache (`docker builder prune` reports 5.5 GB reclaimable, mostly from another project's old builds), or move Docker Desktop's disk image to D:, then compact the VM disk. Tests that create temp files and the Docker-backed suites cannot run until space is freed.

## Environment facts for this machine (do not change other projects)

- `D:\ClaudeProjects` contains unrelated projects; only `notea-workspace` belongs to this product.
- Docker Desktop also runs another project's containers (`ai-creator-automation-*`, Postgres on host port 5432). Never prune, stop or remove them. This project's Postgres is `notea-dev-postgres` on 55432 (compose project `notea-dev`).
- Local users created by the `create-user` script: `andrej@notea.local` and `collaborator@notea.local`, password `notea-dev-password` (change them).
- A `demo-project` workspace exists in the dev database; its container is `notea-ws-ebc7f427-1561-4fe5-8103-efda876f0a7d` (start/stop from the UI).
