# Notea Workspace — MVP Roadmap

Last updated: 2026-09-15. Each milestone lists its statement, scope, acceptance test and status.

## M0 — Foundation (this session) — implemented, tested

**Statement.** The runtime path exists and is proven: protocol → workspace agent → base image → orchestrator → real container terminal.

Delivered:
- Monorepo (`package.json` workspaces), TypeScript config, vitest.
- `packages/protocol`: protocol v1 schemas/types, orchestrator API types, close codes. 5 tests.
- `packages/workspace-agent`: session manager, scrollback, file service, hub, server, entry point, esbuild bundle. 33 tests including an in-process WebSocket integration suite.
- `infra/workspace-image`: Dockerfile, entrypoint, shell defaults.
- `apps/orchestrator`: config, tokens, container spec, Docker runtime, REST routes, WebSocket bridge. 17 unit/integration tests plus a Docker e2e test (`npm run test:e2e -w @notea/orchestrator`).
- Documentation set in `docs/`.

**Acceptance test.** `npm test` green; `npm run build:image` succeeds; `npm run test:e2e -w @notea/orchestrator` creates a container, runs `echo`, `whoami`, `pwd`, writes a file, restarts the container and reads the file back. See `CURRENT_STATE.md` for the latest recorded result.

## M1 — Personal workspace in the browser — next

**Statement.** "I can create a Notea Workspace in a browser and get a terminal in a remote Linux environment."

Scope:
1. `packages/db`: Drizzle schema from `DATABASE_SCHEMA.md` (users, workspaces, workspace_members, workspace_events), migrations, `docker-compose.yml` with Postgres on host port 55432 (5432 is taken on the dev machine by another project).
2. `apps/web` (Next.js 16): Auth.js credentials sign-in; `scripts/create-user.ts`; workspace list; create/start/stop/delete workspace (calls orchestrator REST with the API key); workspace page.
3. Terminal UI: xterm.js 6 + fit + WebGL; one WebSocket per tab; tabs for sessions; reconnect with backoff and re-attach; resize propagation.
4. File tree + editor (CodeMirror 6 or Monaco) using `fs.list/read/write` with etag conflict handling.
5. ESLint + Prettier.

**Acceptance.** From a fresh clone: `npm install`, `npm run build:image`, `docker compose up -d postgres`, migrations, create user, `npm run dev` for web and orchestrator, sign in, create workspace, run `node -v` in the browser terminal, edit and save a file, stop and start the workspace, file persists.

## M2 — Remote access

**Statement.** "I can access that same workspace from another computer."

Scope: `infra/compose/docker-compose.prod.yml` (caddy, web, orchestrator with docker socket, postgres on a separate network), TLS, `AGENT_CONNECT_MODE=network`, environment templates, first-run script, backup notes for volumes. Rate limiting on sign-in. Security checklist from `SECURITY_MODEL.md` §6.

**Acceptance.** Deployed on a Linux VPS; sign in from two different machines; terminal works over TLS; workspaces survive a VPS reboot.

## M3 — Multiplayer

**Statement.** "Two people can use the same workspace simultaneously."

Scope: invitations by email (membership rows + roles), presence UI (who is here, which terminal they watch), shared terminal tabs with "attached by" avatars, file-change notifications (`fs.changed` events from a watcher in the agent), activity feed (workspace_events written by web for control actions; by a small hook in the orchestrator bridge for connection events), viewer role UX.

**Acceptance.** Two accounts in one workspace: both see the same terminal output live, a viewer cannot type, a file saved by one shows a "changed on disk" banner for the other.

## M4 — AI agents inside the workspace

**Statement.** "AI coding agents can operate inside the workspace."

Scope (see `AGENT_SYSTEM.md`): agent identities (`kind: "agent"`), interactive mode (start `claude`, `codex`, `gemini` in a tagged session from the UI), provider credentials stored encrypted per user and injected per run, `packages/agents` with the `AgentRuntime` interface and the first CLI runtime (Claude Code), task rows, worktree creation, task brief generation from repo docs.

**Acceptance.** From the UI, start a Claude Code task on a workspace; a new terminal appears tagged with the agent's name; a second user watches it live; the run works in its own worktree and ends with a branch.

## M5 — Coordination

Scope: scope leases (paths/globs) with `warn|block` policy, integration queue (rebase → checks → fast-forward), approvals, conflict follow-up tasks, cost/usage capture from runtime event streams, agent roles (implementer, reviewer, tester).

**Acceptance.** Two agents on overlapping paths: the second is blocked or warned per policy; two agents on disjoint paths finish and both branches integrate in order with checks.

## M6 — Previews and deployment

Scope: port detection in the agent (`/proc/net/tcp` polling), authenticated preview proxy (`/preview/<ws>/<port>/…` or wildcard subdomains via Caddy), later deploy adapters.

## Ordering rationale

Runtime first (done), then the thinnest UI that exercises it, then reachability, then people, then agents, then coordination. Each milestone is independently useful to the owner.
