# Notea Workspace — Deployment

Last updated: 2026-09-23 (session 11). Status: **both halves are deployed.** `apps/web` is
live on Vercel against a Neon Postgres, and the runtime host `orchestrator.noteawork.com`
(§5) runs Caddy, the orchestrator, the worker and Docker; it was set up on 2026-09-22 and
upgraded to current code in session 11. §3–§5 are now a record of what was done, and §7 is
how to operate it. The host still waits for one reboot (below). What is verified in the
software itself is in `CURRENT_STATE.md`.

**Host state, 2026-09-23.** Ubuntu 26.04.1, 4 vCPU / 7.6 GB, 4 GB swap. Docker 29.8.1,
Node 24.21, Caddy with a Let's Encrypt certificate (valid to 2026-12-21, renewed by Caddy),
the `notea` service account (in `docker`), `/opt/notea-workspace/app` at `3c7382f` pulled
through a read-only deploy key, `.env` mode 600 against the Neon database, and
`notea-orchestrator` + `notea-worker` enabled. Checked from outside: `/healthz` answers over
TLS, the REST API returns 401 without the key, HTTP redirects to HTTPS, and probes for
`/.env` or `/.git/config` get 404. Pending:
- **A reboot**: a kernel (`7.0.0-31`) and libc update are installed and
  `/var/run/reboot-required` is set. `systemctl reboot` when no workspace is in use; every
  service comes back on its own.
- **Hardening, recommended**: sshd still allows password logins (no account can use one
  today, since root is key-only and `notea` has none); set `PasswordAuthentication no`. `ufw`
  is inactive; only 22, 80 and 443 listen publicly, with 4100 bound to 127.0.0.1.

**Before §5, read §2's COPY note.** `ORCHESTRATOR_API_KEY` and `CREDENTIALS_KEY` already
exist on the Vercel project; the host must reuse those exact values.

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

**Two values are copied, not generated.** `ORCHESTRATOR_API_KEY` and `CREDENTIALS_KEY` are
already set on the deployed Vercel project, and both sides must match. Generating fresh
ones on the host means the orchestrator rejects every call from the web app with 401, and a
new `CREDENTIALS_KEY` makes every stored provider credential permanently undecryptable.
Read them out of Vercel first (Project → Settings → Environment Variables → reveal, or
`vercel env pull`) and paste those exact values into the host's `.env`.

### Vercel project (`apps/web`)

| Variable | Value | Generate? |
|---|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/notea?sslmode=require` — use the provider's **pooled** endpoint if it offers one (serverless opens many short connections) | from your database provider |
| `AUTH_SECRET` | Auth.js session signing secret | **yes** |
| `ORCHESTRATOR_URL` | `https://orchestrator.noteawork.com` (server-to-server, REST) | this deployment's domain |
| `ORCHESTRATOR_PUBLIC_URL` | same URL; browsers derive `wss://` from it for terminals | your domain |
| `ORCHESTRATOR_API_KEY` | must equal the orchestrator's value | **set — copy to the host** |
| `CREDENTIALS_KEY` | 64 hex chars; encrypts stored provider credentials; must equal the worker's value | **set — copy to the host** |
| `AUTH_URL` | optional; the public URL of the web app if Vercel's auto-detection is not right | your domain |

### Orchestrator (VPS, `/opt/notea-workspace/.env`)

| Variable | Value | Generate? |
|---|---|---|
| `PORT` | `4100` | — |
| `HOST` | `127.0.0.1` — only Caddy reaches it | — |
| `ORCHESTRATOR_API_KEY` | same as Vercel/worker | **copy from Vercel** |
| `CONNECT_TOKEN_SECRET` | ≥ 32 chars | **yes** |
| `AGENT_TOKEN_SECRET` | ≥ 32 chars; rotating it means recreating containers | **yes** |
| `WORKSPACE_IMAGE` | `notea/workspace:dev` (built on the VPS with `npm run build:image`) | — |
| `WORKSPACE_NETWORK` | `notea-workspaces` | — |
| `AGENT_CONNECT_MODE` | `network` on Linux (see §6 caveat); `published` is the mode verified in development | — |
| `AGENT_UID_MIN` / `AGENT_UID_MAX` / `AGENT_GID` | defaults `20001` / `29999` / `1000`; per-member agent uids (`SECURITY_MODEL.md`) | — |
| `WORKSPACE_DEFAULT_CPUS` / `_MEMORY_MB` / `_PIDS_LIMIT` | `2` / `3072` / `2048` on a 4 vCPU / 8 GB host; size up with the host (§5) | — |
| `DEV_CONSOLE` | **`false`** — it mints tokens without authentication | — |
| `LOG_LEVEL` | `info` | — |

### Worker (VPS, same `.env` works)

| Variable | Value | Generate? |
|---|---|---|
| `DATABASE_URL` | same database as the web app (a direct, non-pooled URL is fine here) | provider |
| `ORCHESTRATOR_URL` | `http://127.0.0.1:4100` when co-located | — |
| `ORCHESTRATOR_API_KEY` | same as above | **copy from Vercel** |
| `CREDENTIALS_KEY` | same as Vercel | **copy from Vercel** |
| `WORKER_MAX_CONCURRENT_RUNS` | `2` on a 4 vCPU / 8 GB host | — |
| `WORKER_POLL_INTERVAL_MS` / `WORKER_REAP_INTERVAL_MS` | `15000` / `60000`. Every tick queries Postgres, so this is what keeps a managed database awake — at `2000` a Neon compute can never scale to zero. `15000` stays well inside the 2-minute stale-run cutoff and the 15 s run heartbeat | — |

### Local development

`cp .env.example .env` at the repository root; one file serves all three apps. It also
holds `NOTEA_DEV_PASSWORD` / `NOTEA_DEV_USERS` / `NOTEA_DEV_WORKSPACE` for
`npm run seed:dev -w @notea/web`, which are **development-only** and must not exist in
production.

## 3. GitHub (done)

The remote exists: **https://github.com/nikolovskiandrej/noteaworkspace**, over HTTPS, branch
`main`. Pushing is just `git push`. Before any push, `git ls-files | grep -E '^\.env$'` must
print nothing (it does: `.env` is ignored and only `.env.example` is tracked). The tracked
test files contain obviously fake credential *shapes* (`sk-ant-api03-abcdefghijklmnop`);
nothing real.

**How the VPS authenticates: a read-only deploy key.** Not a PAT. A deploy key is scoped to
this one repository, the private half is generated on the host and never leaves it, and
revoking it touches nothing else; a PAT — even fine-grained — is an account credential that
expires and has to be rotated. Read-only is enough because the host only ever pulls (§7);
agent commits happen inside the workspace container, against the clone on its own volume,
which never talks to GitHub. Do not grant the key write access, and do not copy it into a
container. §5 step 3 generates it.

## 4. Vercel, web app (done — recorded for reference)

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

## 5. The Linux host (orchestrator, worker) — the outstanding half

Ubuntu 24.04 (or any Linux with Docker Engine and Node 24). A 4 vCPU / 8 GB host runs
**one** workspace comfortably at the shipped 2 CPU / 3 GB per container, with roughly 1 GB
going to the host itself (Docker, Caddy, orchestrator, worker). A container's memory limit
is a cap, not a reservation: two workspaces are each entitled to their full 3 GB, so they
can exhaust the host before either hits its own limit, and the kernel then picks the
victim — which may be the orchestrator rather than a container. Add 4 GB of swap (cloud
images usually ship with none) so a spike degrades instead of being killed, and size up the
host before running two busy workspaces at once.

`caddy` is not in every Ubuntu release's default repositories, and where it is it lags:
check `apt-cache policy caddy` before step 1 and add Caddy's own repository if it comes
back empty.

### Pre-flight (verified 2026-09-22)

| Fact | Value |
|---|---|
| Hostname | `orchestrator.noteawork.com` |
| Host IPv4 | `178.105.211.58` (reverse DNS `static.58.211.105.178.clients.your-server.de` — Hetzner) |
| DNS | **Live and correct.** The A record resolves straight to the origin IP. |
| DNS provider | Cloudflare (`dakota`/`dana.ns.cloudflare.com`) |
| Proxy status | **DNS-only (grey cloud) — keep it that way.** A proxied record terminates TLS at Cloudflare, so Caddy's ACME challenge never reaches this host and the browser's `wss://` terminal goes through Cloudflare's proxy instead of straight to the orchestrator. |
| Port 22 | open (`OpenSSH_10.2p1`) |
| OS | **Ubuntu 26.04.1 LTS**, kernel 7.0.0-30-generic, hostname `noteaworkspace`, 74.77 GB root disk |
| Ports 80 / 443 / 4100 | **closed** — 80 and 443 must be opened before step 8 |

**The host is Ubuntu 26.04.1 LTS (`resolute`), not the 24.04 step 1 was written for.** All
three third-party sources were checked against that codename on 2026-09-22, and all three
work:

| Source | `resolute` | Note |
|---|---|---|
| `download.docker.com/linux/ubuntu` | **publishes it** | `get.docker.com` installs Docker CE unchanged |
| `deb.nodesource.com/node_24.x` | no per-codename suite, but publishes **`nodistro`** | NodeSource is codename-independent now, so `setup_24.x` works on any release |
| `dl.cloudsmith.io/public/caddy/stable` | **publishes it**, and `any-version` | Caddy's official install snippet works unchanged |

Still prefer the distribution's own `nodejs` when its candidate is 24 or newer: one less
third-party apt repository on a host that holds provider tokens. Check with
`apt-cache policy nodejs` **after** `apt-get update` — on a fresh image the package cache
is empty and every candidate reads as unavailable, which is not the same as absent.

Everything from step 2 onwards is release-independent.

```bash
# 1. system packages  (shown for a root shell; prefix with sudo if you are not root)
apt-get update && apt-get -y upgrade
apt-get install -y git curl ca-certificates

# Node 24 — distribution package if its candidate is >= 24, else NodeSource.
# Check the candidate FIRST: apt succeeds just as happily installing an older Node,
# so "the install worked" is not the same as "the version is right".
apt-cache policy nodejs
apt-get install -y nodejs npm
node --version                                   # must be v24 or newer
# Only if it is older, replace it with NodeSource's build:
#   apt-get purge -y nodejs npm && apt-get autoremove -y
#   curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
npm --version                                    # npm 11 expected alongside node 24

# Caddy — distribution package if present, else Caddy's own repository.
apt-cache policy caddy
apt-get install -y caddy   ||   {
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
}

# Docker Engine
curl -fsSL https://get.docker.com | sh

# Swap: cloud images ship with none, and 8 GB is tight (see the sizing note above).
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-notea-swappiness.conf && sysctl -p /etc/sysctl.d/99-notea-swappiness.conf
fi

# 2. a service account that may talk to Docker (the orchestrator needs the socket)
sudo useradd -r -m -d /opt/notea-workspace -s /bin/bash notea
sudo usermod -aG docker notea

# 3a. a read-only deploy key for this repository (§3), generated on the host
sudo -iu notea install -d -m 700 /opt/notea-workspace/.ssh
sudo -iu notea ssh-keygen -t ed25519 -N '' -C 'notea-vps' -f /opt/notea-workspace/.ssh/id_ed25519
sudo -u notea cat /opt/notea-workspace/.ssh/id_ed25519.pub
#    Paste that public key at GitHub → the repository → Settings → Deploy keys →
#    Add deploy key. Leave "Allow write access" UNCHECKED. The private half stays here.
sudo -iu notea bash -c 'ssh -o StrictHostKeyChecking=accept-new -T git@github.com; true'

# 3b. the code
sudo -iu notea bash -c 'git clone git@github.com:nikolovskiandrej/noteaworkspace.git /opt/notea-workspace/app'
cd /opt/notea-workspace/app
sudo -u notea npm ci                             # `node-pty` may warn: harmless, the host never uses it
sudo -u notea npm run build:image                # builds notea/workspace:dev on this host (a few minutes)

# 4. configuration (mode 600, owned by notea)
sudo -u notea cp infra/deploy/vps.env.example /opt/notea-workspace/app/.env
sudo -u notea chmod 600 /opt/notea-workspace/app/.env
sudo -u notea "${EDITOR:-nano}" /opt/notea-workspace/app/.env
#    Fill every GENERATE value, paste the two COPY values from Vercel (§2), and replace
#    DATABASE_URL with the managed database's direct URL — the template's 127.0.0.1 line
#    is only a shape, and leaving it makes the worker crash-loop on ECONNREFUSED.

# 5. database — ONLY for a Postgres on this host. With the web app on Vercel the database
#    is managed and already migrated, so skip both lines and just set DATABASE_URL.
#    A *fresh* managed database still needs the migrate line, run from this directory.
sudo -u notea docker compose -p notea -f infra/deploy/docker-compose.postgres.yml up -d
sudo -u notea npm run migrate -w @notea/db

# 6. the first account (production has no self sign-up) — already exists on the deployed
#    database; only for a fresh one.
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

Open ports 22, 80 and 443 in the firewall. 80 is not strictly required — Caddy falls back
to the TLS-ALPN-01 challenge on 443 — but without it the HTTP-01 challenge and the
automatic http→https redirect both fail. **Both 80 and 443 were closed on this host when
last checked**, so open them in the Hetzner Cloud Firewall *and* in any host firewall
before reloading Caddy, or certificate issuance will simply fail.

**9. Point the web app at this host.** `ORCHESTRATOR_URL` and `ORCHESTRATOR_PUBLIC_URL` on
Vercel are still the placeholder `https://orchestrator.example.com`. Set both to
`https://orchestrator.noteawork.com` and **redeploy** — changing an environment variable
does not affect the deployment already running. Until this is done §6 fails with
`orchestrator unreachable`, however healthy the host is.

## 6. Verify the live system

1. `curl https://orchestrator.noteawork.com/healthz` → `{"ok":true,"service":"notea-orchestrator"}`.
2. `curl -H 'Authorization: Bearer <ORCHESTRATOR_API_KEY>' https://orchestrator.noteawork.com/workspaces` → `{"workspaces":[]}`; without the header → 401.
3. Open the Vercel URL, sign in with the account from step 6, create a workspace, open a
   terminal (`whoami` → `dev`), save a file from the editor.
4. **Settings → AI & Claude → Connect** a credential, then **Check** it against the running
   workspace: the CLI must report `authenticated (oauth_token)` for a subscription token or
   `authenticated (api_key …)` for an API key.
5. Create a task, watch it reach `needs_review`, approve it, confirm the commit on `main`
   from the terminal.

**`AGENT_CONNECT_MODE=network` is verified on Linux** (`CURRENT_STATE.md`, known issue 10,
resolved in session 8): development moved to Ubuntu 26.04, where `auto` resolves to
`network`, and the Docker e2e, a live two-client session and a real authenticated agent run
all went over it with no published port. It is no longer the risk this section used to warn
about. If `/workspaces/:id/start` ever does time out waiting for the agent, `published`
remains a working fallback — the orchestrator then reaches containers through a port on
127.0.0.1, so nothing becomes publicly reachable — but expect not to need it.

## 7. Operations

- **Backups:** `pg_dump` the database; `docker run --rm -v notea-ws-<id>-home:/v -v $PWD:/b alpine tar czf /b/<id>.tgz -C /v .` per workspace volume.
- **Image upgrade:** `git pull && npm ci && npm run build:image`, then stop/start each workspace from the UI (the orchestrator recreates the container on the new image, keeping the volume).
- **Logs:** `journalctl -u notea-orchestrator -u notea-worker -f`. They carry ids only, never tokens.
- **Rotation:** changing `AGENT_TOKEN_SECRET` requires recreating containers; changing `CREDENTIALS_KEY` makes stored credentials undecryptable (members reconnect them).

## 8. Not covered here

Multi-tenant hardening (`SECURITY_MODEL.md` §5), previews, autoscaling, and running the
orchestrator itself inside a container (it can, with the Docker socket mounted, but that
is not the verified topology).
