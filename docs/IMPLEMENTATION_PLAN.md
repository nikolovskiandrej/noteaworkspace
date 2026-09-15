# Notea Workspace — Implementation Plan

Last updated: 2026-09-15. This is the concrete, ordered plan for the next implementing agent (Opus 5). M0 is done; start at M1 step 1.

## Conventions

- TypeScript strict; no `any`; zod at every trust boundary; small modules; tests next to the code in `test/`.
- Packages export TypeScript source (`exports` → `./src/index.ts`); Next.js must list them in `transpilePackages`.
- Every new message in the protocol: add the zod schema, the TS type, a parse test, and bump nothing until v2 (additive fields only in v1.x).
- Commands: `npm run typecheck`, `npm test`, `npm run build:image`, `npm run test:e2e -w @notea/orchestrator`.
- Commit per logical step.

## M1 — Personal workspace in the browser

### Step 1: `packages/db`
1. `package.json` (`drizzle-orm`, `postgres`, dev `drizzle-kit`), `drizzle.config.ts`, `src/schema.ts` from `DATABASE_SCHEMA.md` (users, workspaces, workspace_members, workspace_events), `src/client.ts` (postgres.js + drizzle), `src/index.ts`.
2. `infra/compose/docker-compose.dev.yml` with `postgres:17` on `127.0.0.1:55432`, volume `notea-dev-postgres`, database `notea`, user `notea`. Root script `db:up`, `db:migrate`, `db:generate`.
3. Generate the first migration; apply; add a smoke test that inserts and reads a user (gated on `DATABASE_URL`).

### Step 2: `apps/web` skeleton
1. `npx create-next-app@latest apps/web --ts --app --tailwind --eslint --src-dir --import-alias "@/*"` (run inside the repo; keep the root workspaces config). Add `@notea/protocol`, `@notea/db` to `transpilePackages`.
2. Auth.js v5: `auth.ts` with Credentials provider (email + argon2 via `@node-rs/argon2`), JWT session with `userId`; `middleware.ts` protecting everything except `/sign-in`. `scripts/create-user.ts` (email, name, password) for seeding.
3. Orchestrator client `src/lib/orchestrator.ts`: typed fetch wrapper for the REST API using `ORCHESTRATOR_URL` + `ORCHESTRATOR_API_KEY`; error mapping.
4. Pages: `/sign-in`, `/` (workspace list with status badges), `/workspaces/new`, `/workspaces/[slug]`. Server actions: create (insert row → orchestrator create → event), start, stop, delete (orchestrator delete with `deleteVolume` → soft delete).

### Step 3: Terminal UI
1. `src/lib/workspace-socket.ts`: a small client for protocol v1 (connect with token, request/response by `reqId`, event subscription, reconnect with exponential backoff and re-attach of known session ids). Unit-test the reconnect state machine with a fake socket.
2. Route handler `POST /api/workspaces/[id]/connect-token` (checks membership, calls orchestrator `POST /connect-tokens`).
3. `Terminal` component: xterm.js 6, fit addon, WebGL addon with canvas fallback; `term.resize` on container resize; scrollback replay on attach; tabs for sessions; "new terminal" button.
4. Verify manually against a real workspace (Docker Desktop, orchestrator on the host).

### Step 4: Files
1. File tree component using `fs.list` lazily per directory.
2. Editor (CodeMirror 6) with `fs.read` → edit → `fs.write` with `expectedEtag`; on `conflict`, show reload/overwrite.

### Step 5: Quality
ESLint 10 flat config + Prettier at the root; `npm run lint`. Add `README.md` quick start. Update `CURRENT_STATE.md`, `HANDOFF.md`.

## M2 — Remote access

1. `infra/compose/docker-compose.prod.yml`: `caddy` (443 → web; `/ws/*` → orchestrator), `web` (Next.js standalone build), `orchestrator` (`node dist/orchestrator.mjs`, `/var/run/docker.sock:/var/run/docker.sock`, `AGENT_CONNECT_MODE=network`, on networks `notea-control` + `notea-workspaces`), `postgres` (on `notea-control` only).
2. `infra/compose/Caddyfile`; `.env.production.example`; `scripts/bootstrap-server.sh` (docker, compose, `.env`, image build, first user).
3. Sign-in rate limiting (in-memory token bucket is enough for one host).
4. Volume backup script and restore notes.

## M3 — Multiplayer

1. Invites (`workspace_invites`, email link or copyable link), membership management UI, role changes.
2. Presence panel from `presence` events; attached-user avatars on terminal tabs.
3. Agent: `fs.changed` events (chokidar or `fs.watch` recursive with ignore list) — additive protocol change; editor banner on external change.
4. Activity feed: control-plane events (web) + connection events (orchestrator bridge posts to a web endpoint or writes directly; prefer a small `POST /internal/events` on web with the API key).

## M4 — Agents

1. `packages/agents`: `AgentRuntime` interface, `WorkspaceClient`, provider adapters (`anthropic`, `openai`, `google`) with env mapping and model catalog, `claude-code-cli` runtime (interactive first, headless second).
2. Protocol v1.1: `term.create.env` (allow-listed variable names) so credentials can be injected per session; agent identities in presence UI.
3. Image: install `@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli` pinned; document login flows.
4. UI: "Start agent" dialog (runtime, model, credential, task title/description, scope); agent terminal tagged and watchable.
5. Worktree creation via a `git worktree` command executed through a terminal session or a new `exec` message (prefer an `exec` message with captured output: additive protocol change, needs zod + role check).

## M5 — Coordination

Tasks and leases in the DB; integration queue worker in web (or a small `apps/worker`); approvals UI; conflict follow-up tasks; usage aggregation.

## M6 — Previews

Agent: listening-port detection (`/proc/net/tcp*`) broadcast as `ports.changed`; orchestrator: authenticated HTTP proxy `/preview/:workspaceId/:port/*` to the container; UI preview tab.

## Testing plan per milestone

- M1: db smoke test; auth unit tests (password hashing, session claims); orchestrator client tests with a mocked fetch; socket client reconnect tests; manual browser check.
- M2: a compose smoke test script that curls `/healthz` through Caddy.
- M3: agent tests for `fs.changed`; presence UI tests with the in-process agent (the bridge test shows how).
- M4: runtime tests with a fake CLI script that emits a known JSON stream; worktree creation test inside the Docker e2e.
- M5: queue state-machine tests; conflict scenario in Docker e2e.
