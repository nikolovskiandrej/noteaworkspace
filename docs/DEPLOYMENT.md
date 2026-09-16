# Notea Workspace — Deployment

Last updated: 2026-09-15 (session 6). Status: **prepared, not yet deployed.** No Vercel or
GitHub credentials exist on the development machine, so nothing here has been pushed or
deployed; every step below is written to be run by the owner. What *has* been verified is
the software itself (see `CURRENT_STATE.md`): the production `next build`, the full test
suite, the Docker end-to-end suite and the two-member agent flow.

## 1. What runs where

Vercel hosts exactly one part of Notea Workspace: the Next.js control plane (`apps/web`).
Everything that needs a long-lived process, Docker, or a persistent disk cannot run in a
serverless function and lives on a Linux host of your own.

```
                 HTTPS                        HTTPS (REST, API key)
Browser ────────────────▶ Vercel: apps/web ─────────────────────────┐
   │                        (sign-in, workspaces, tasks,             │
   │                         Settings → AI & Claude)                 ▼
   │                                                    Linux host (VPS) with Docker
   │  WSS (terminal, files, presence) ─────────────▶   ├─ Caddy (TLS) → orchestrator :4100
   │  ORCHESTRATOR_PUBLIC_URL, connect JWT              ├─ orchestrator (apps/orchestrator)
   │                                                    │    Docker containers = workspaces
   │                                                    ├─ worker (apps/worker) — agent tasks
   │                                                    └─ Postgres (or a managed database)
```

| Part | Where | Why |
|---|---|---|
| `apps/web` | Vercel | Stateless Next.js; talks to Postgres and to the orchestrator's REST API server-side. |
| `apps/orchestrator` | VPS, behind Caddy | Needs the Docker socket and holds WebSocket connections open for hours. |
| `apps/worker` | VPS (same host is fine) | Long-lived loop; runs agent tasks through the orchestrator; needs `CREDENTIALS_KEY`. |
| Postgres 17 | Managed (Neon, Supabase, RDS…) or on the VPS | Must be reachable from Vercel (TLS) **and** from the worker. |
| Workspace containers | VPS Docker | Created by the orchestrator from `notea/workspace:dev`, built on the VPS. |

The web app never needs Docker. Browsers open the terminal WebSocket **directly against
the orchestrator** (`ORCHESTRATOR_PUBLIC_URL`), so Vercel does not have to proxy
WebSockets.

**Run exactly one worker process** (`CURRENT_STATE.md`, known issue 8).

## 2. Environment variables

Generate every secret with `openssl rand -hex 32`. Never reuse a development value in
production, and never commit a `.env`. Templates with the exact variable names are in
`infra/deploy/`.

### Vercel project (`apps/web`)

| Variable | Value | Generate? |
|---|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/notea?sslmode=require` — use the provider's **pooled** endpoint if it offers one (serverless opens many short connections) | from your database provider |
| `AUTH_SECRET` | Auth.js session signing secret | **yes** |
| `ORCHESTRATOR_URL` | `https://orchestrator.example.com` (server-to-server, REST) | your domain |
| `ORCHESTRATOR_PUBLIC_URL` | same URL; browsers derive `wss://` from it for terminals | your domain |
| `ORCHESTRATOR_API_KEY` | must equal the orchestrator's value | **yes** (shared) |
| `CREDENTIALS_KEY` | 64 hex chars; encrypts stored provider credentials; must equal the worker's value | **yes** (shared) |
| `AUTH_URL` | optional; the public URL of the web app if Vercel's auto-detection is not right | your domain |

### Orchestrator (VPS, `/opt/notea-workspace/.env`)

| Variable | Value | Generate? |
|---|---|---|
| `PORT` | `4100` | — |
| `HOST` | `127.0.0.1` — only Caddy reaches it | — |
| `ORCHESTRATOR_API_KEY` | same as Vercel/worker | **yes** |
| `CONNECT_TOKEN_SECRET` | ≥ 32 chars | **yes** |
| `AGENT_TOKEN_SECRET` | ≥ 32 chars; rotating it means recreating containers | **yes** |
| `WORKSPACE_IMAGE` | `notea/workspace:dev` (built on the VPS with `npm run build:image`) | — |
| `WORKSPACE_NETWORK` | `notea-workspaces` | — |
| `AGENT_CONNECT_MODE` | `network` on Linux (see §6 caveat); `published` is the mode verified in development | — |
| `AGENT_UID_MIN` / `AGENT_UID_MAX` / `AGENT_GID` | defaults `20001` / `29999` / `1000`; per-member agent uids (`SECURITY_MODEL.md`) | — |
| `WORKSPACE_DEFAULT_CPUS` / `_MEMORY_MB` / `_PIDS_LIMIT` | size to the host | — |
| `DEV_CONSOLE` | **`false`** — it mints tokens without authentication | — |
| `LOG_LEVEL` | `info` | — |

### Worker (VPS, same `.env` works)

| Variable | Value | Generate? |
|---|---|---|
| `DATABASE_URL` | same database as the web app (a direct, non-pooled URL is fine here) | provider |
| `ORCHESTRATOR_URL` | `http://127.0.0.1:4100` when co-located | — |
| `ORCHESTRATOR_API_KEY` | same as above | **yes** (shared) |
| `CREDENTIALS_KEY` | same as Vercel | **yes** (shared) |
| `WORKER_MAX_CONCURRENT_RUNS` | `3` | — |
| `WORKER_POLL_INTERVAL_MS` / `WORKER_REAP_INTERVAL_MS` | `2000` / `60000` | — |

### Local development

`cp .env.example .env` at the repository root; one file serves all three apps. It also
holds `NOTEA_DEV_PASSWORD` / `NOTEA_DEV_USERS` / `NOTEA_DEV_WORKSPACE` for
`npm run seed:dev -w @notea/web`, which are **development-only** and must not exist in
production.

## 3. Tomorrow: GitHub

The repository has no remote yet. From the repository root:

```bash
git status                       # must be clean
git remote add origin git@github.com:<your-account>/notea-workspace.git
git push -u origin main
```

Before pushing, `git ls-files | grep -E '^\.env$'` must print nothing (it does: `.env` is
ignored and only `.env.example` is tracked). The tracked test files contain
obviously fake credential *shapes* (`sk-ant-api03-abcdefghijklmnop`); nothing real.

## 4. Tomorrow: Vercel (web app)

1. Vercel → **Add New… → Project** → import `notea-workspace`.
2. **Root Directory:** `apps/web`. Keep *"Include source files outside of the Root
   Directory"* enabled (the app imports `packages/*` as TypeScript source; Vercel installs
   from the monorepo root because `package-lock.json` is there).
3. **Framework Preset:** Next.js. Build command `next build`, install command `npm install`
   (defaults). **Node.js version:** 24.x if offered, otherwise 22.x works.
4. **Environment Variables:** the Vercel table in §2, for Production (and Preview if you
   want previews to hit the same backend).
5. **Deploy.** Then open `/sign-in` on the assigned URL.

Or, with the CLI, from `apps/web`:

```bash
npm i -g vercel
vercel login
vercel link                      # creates/links the project; set Root Directory = apps/web when asked
vercel env add DATABASE_URL production        # repeat for each variable in §2
vercel --prod
```

The web app will build and sign-in will work as soon as `DATABASE_URL` and `AUTH_SECRET`
are set. Workspaces, terminals and tasks additionally need the orchestrator (§5).

## 5. Tomorrow: the Linux host (orchestrator, worker, Postgres)

Ubuntu 24.04 (or any Linux with Docker Engine and Node 24). One 4 vCPU / 8 GB host is
enough for a handful of workspaces at the default 2 CPU / 4 GB per container.

```bash
# 1. system packages
sudo apt-get update && sudo apt-get install -y git curl caddy
curl -fsSL https://get.docker.com | sudo sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs

# 2. a service account that may talk to Docker (the orchestrator needs the socket)
sudo useradd -r -m -d /opt/notea-workspace -s /bin/bash notea
sudo usermod -aG docker notea

# 3. the code
sudo -iu notea bash -c 'git clone git@github.com:<your-account>/notea-workspace.git /opt/notea-workspace/app'
cd /opt/notea-workspace/app
sudo -u notea npm ci
sudo -u notea npm run build:image                # builds notea/workspace:dev on this host (a few minutes)

# 4. configuration (mode 600, owned by notea)
sudo -u notea cp infra/deploy/vps.env.example /opt/notea-workspace/app/.env
sudo -u notea chmod 600 /opt/notea-workspace/app/.env
sudo -u notea "${EDITOR:-nano}" /opt/notea-workspace/app/.env     # fill every "generate" value

# 5. database (skip if you use a managed Postgres: just set DATABASE_URL)
sudo -u notea docker compose -p notea -f infra/deploy/docker-compose.postgres.yml up -d
sudo -u notea npm run migrate -w @notea/db

# 6. the first account (production has no self sign-up)
sudo -u notea npm run create-user -w @notea/web -- you@example.com "Your Name" '<a strong password>'

# 7. services
sudo cp infra/deploy/notea-orchestrator.service infra/deploy/notea-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now notea-orchestrator notea-worker
sudo systemctl status notea-orchestrator notea-worker --no-pager

# 8. TLS + reverse proxy (edit the hostname first)
sudo cp infra/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Open only ports 22 and 443 in the firewall. Point `orchestrator.example.com` at the
host's IP; Caddy obtains the certificate and proxies WebSockets automatically.

## 6. Verify the live system

1. `curl https://orchestrator.example.com/healthz` → `{"ok":true,"service":"notea-orchestrator"}`.
2. `curl -H 'Authorization: Bearer <ORCHESTRATOR_API_KEY>' https://orchestrator.example.com/workspaces` → `{"workspaces":[]}`; without the header → 401.
3. Open the Vercel URL, sign in with the account from step 6, create a workspace, open a
   terminal (`whoami` → `dev`), save a file from the editor.
4. **Settings → AI & Claude → Connect** a credential, then **Check** it against the running
   workspace: the CLI must report `authenticated (oauth_token)` for a subscription token or
   `authenticated (api_key …)` for an API key.
5. Create a task, watch it reach `needs_review`, approve it, confirm the commit on `main`
   from the terminal.

**Caveat — `AGENT_CONNECT_MODE=network` has not been exercised on a Linux host**
(`CURRENT_STATE.md`, known issue 10): every verification so far ran on Docker Desktop with
`published`. If `/workspaces/:id/start` times out waiting for the agent on Linux, set
`AGENT_CONNECT_MODE=published` (the orchestrator then reaches containers through a port
published on 127.0.0.1, which is what development uses) and restart the orchestrator.

## 7. Operations

- **Backups:** `pg_dump` the database; `docker run --rm -v notea-ws-<id>-home:/v -v $PWD:/b alpine tar czf /b/<id>.tgz -C /v .` per workspace volume.
- **Image upgrade:** `git pull && npm ci && npm run build:image`, then stop/start each workspace from the UI (the orchestrator recreates the container on the new image, keeping the volume).
- **Logs:** `journalctl -u notea-orchestrator -u notea-worker -f`. They carry ids only, never tokens.
- **Rotation:** changing `AGENT_TOKEN_SECRET` requires recreating containers; changing `CREDENTIALS_KEY` makes stored credentials undecryptable (members reconnect them).

## 8. Not covered here

Multi-tenant hardening (`SECURITY_MODEL.md` §5), previews, autoscaling, and running the
orchestrator itself inside a container (it can, with the Docker socket mounted, but that
is not the verified topology).
