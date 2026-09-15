# Notea Workspace — Current State

Last updated: 2026-09-15, end of Fable 5.1 session 1. Update this file whenever reality changes.

## One-line status

**M0 (foundation) is implemented and verified end to end against a real Docker container. M1 (web UI, auth, database) has not started.**

## Repository (actual contents)

```
notea-workspace/
├── AGENTS.md, CLAUDE.md          instructions for AI agents (CLAUDE.md includes AGENTS.md)
├── README.md, .env.example, .editorconfig, .gitignore
├── package.json                  npm workspaces; root scripts; allowScripts for esbuild + node-pty
├── tsconfig.base.json
├── apps/orchestrator/            Fastify runtime service                       [implemented, tested]
│   ├── src/config.ts             zod-validated env → OrchestratorConfig
│   ├── src/tokens.ts             connect JWTs (jose) + HMAC agent tokens
│   ├── src/errors.ts             RuntimeError(statusCode, code)
│   ├── src/docker/spec.ts        pure container spec builder (hardening lives here)
│   ├── src/docker/workspace-runtime.ts  dockerode lifecycle, endpoint resolution, agent readiness
│   ├── src/routes/workspaces.ts  REST (API-key guarded)
│   ├── src/routes/bridge.ts      /ws/workspaces/:id bridge
│   ├── src/app.ts, src/index.ts  app factory; entry point (loads .env, connects Docker)
│   └── test/                     spec, tokens, bridge (in-process agent), docker.e2e (gated)
├── packages/protocol/            protocol v1 + orchestrator API types            [implemented, tested]
├── packages/workspace-agent/     in-container daemon                             [implemented, tested]
│   ├── src/{index,lib,server,hub,session-manager,scrollback,fs-service,pty,logger,errors,testing}.ts
│   ├── image/package.json        runtime deps for the image (node-pty)
│   ├── dist/agent.cjs            esbuild bundle (gitignored; `npm run build:agent`)
│   └── test/                     scrollback, session-manager, fs-service, hub (WebSocket)
├── infra/workspace-image/        Dockerfile, entrypoint.sh, bashrc.d.sh          [implemented, built]
└── docs/                         this documentation set
```

Not present yet: `apps/web`, `packages/db`, `packages/agents`, compose files, ESLint config.

## Verified on 2026-09-15 (Windows 11, Node 24.18, npm 11.16, Docker Desktop 29.5.3)

| Command | Result |
|---|---|
| `npm install` | OK (warns that `ssh2`/`protobufjs` install scripts are not allow-listed; harmless) |
| `npm run typecheck` | OK, 3 packages |
| `npm test` | OK: protocol 5, workspace-agent 33, orchestrator 17 (+1 skipped e2e) |
| `npm run build:agent` | OK, `dist/agent.cjs` ≈ 915 KB |
| `npm run build:image` | OK, `notea/workspace:dev` 1.06 GB, `node-pty ok` printed during build |
| `npm run test:e2e -w @notea/orchestrator` | **OK** (see below) |
| `npx tsx src/index.ts` in `apps/orchestrator` with env vars | starts, `/healthz` OK, API key enforced, connect token issued (smoke test) |

What the e2e test proved: `POST`-equivalent create → container + volume + network created → agent healthy in ≈1–2 s → connect token accepted by the bridge → `hello` received with `projectDir=/home/dev/project` → `term.create` → typed `echo …; whoami; pwd; echo …` → output streamed back containing the marker, `dev` and `/home/dev/project` → `fs.write` → stop → start → new connection sees zero sessions → `fs.read` returns the persisted file → remove with volume deletion → no leftovers.

## Implemented behaviour (summary)

- Protocol v1: identify, ping, term.create/attach/detach/input/resize/kill/list, fs.list/read/write; events hello, term.opened/output/resized/exit, presence, errors; WS close codes 4400/4401/4500/4503.
- Agent: sessions outlive connections; multi-attach with scrollback replay (256 KB); roles enforced (viewer read-only); path-confined file API with etag conflicts and symlink-escape checks; identify-first rule; health endpoint; token-gated upgrade; graceful shutdown.
- Orchestrator: create/start/stop/remove/list/inspect; hardened spec; `published`/`network` connect modes; readiness polling; connect tokens; API key; bridge with buffered pre-identify frames and close-code translation.
- Image: Debian bookworm + Node 24 + git + build tools + ripgrep, user `dev`, agent under `/opt/notea/agent`, health check, restart policy set by the orchestrator.

## Known issues and technical debt

1. **No ESLint/Prettier** (D-018).
2. **Image size 1.06 GB** because build tools (python3, make, g++) are kept for `npm install` of native modules inside workspaces; a multi-stage slim variant is possible.
3. **Raw scrollback replay** (D-020); TUIs may redraw imperfectly after attach.
4. **No WebSocket backpressure handling**: a very slow client with a flooding terminal could grow the socket buffer; add `bufferedAmount` checks / PTY pause later.
5. **`WorkspaceRuntime.list()`** does one inspect per container (fine for personal scale).
6. **Sessions do not survive container restarts** (by design for now; documented in ARCHITECTURE §3.2).
7. **`published` mode on Windows** leaves agent ports on `127.0.0.1:<random>`; local processes on the dev machine could reach an agent if they knew the token (they cannot without the root secret).
8. **npm allow-scripts warnings** for `ssh2`, `protobufjs` on every install; deliberately not approved.
9. **Real PTY behaviour is only tested in the Docker e2e**; Windows unit tests use a fake PTY.
10. **`term.create` has no `env` field yet** (needed for per-run credential injection, M4; additive change).
11. Agent bundle includes zod and ws (≈915 KB); acceptable.

## Environment facts for this machine (do not change other projects)

- `D:\ClaudeProjects` contains unrelated projects; only `notea-workspace` belongs to this product.
- Docker Desktop runs containers of another project (`ai-creator-automation-*`, Postgres on host port 5432, Redis, MinIO). Never prune, stop or remove them. Use host port 55432 for this project's Postgres.
- Docker Desktop may be stopped when a session starts; launch it (`C:\Program Files\Docker\Docker\Docker Desktop.exe`) and wait for `docker info`.
- No global pnpm; use npm. No `psql` client installed.
