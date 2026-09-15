# Notea Workspace — Security Model

Last updated: 2026-09-15 (session 2). Scope: what is implemented, what is acceptable for **personal use**, what must change before **public/commercial** use.

## 1. Assets and actors
Assets: host machine, project files and secrets on workspace volumes, provider API keys, user accounts, other workspaces on the host, the Postgres database (tasks, events, encrypted credentials).
Actors: owner (trusted), invited collaborators (semi-trusted, shell access inside their workspaces), untrusted project code (dependencies, cloned repos, agent-written code), internet attackers (after M2), AI agents (treated as editors whose output is untrusted code).

## 2. Boundaries and controls (implemented unless noted)

**Browser ↔ control plane.** Auth.js JWT sessions in HTTP-only cookies; scrypt password hashes; constant-time-ish credential check (dummy hash for unknown emails); every server action and route handler re-checks the session and the workspace membership/role (`apps/web/src/lib/authz.ts`); non-members get "not found". No self sign-up. Pending: sign-in rate limiting (M2).

**Browser ↔ orchestrator WebSocket.** Short-lived HS256 connect tokens bound to one workspace, role and identity; identity injected by the orchestrator as the first frame; browsers cannot re-identify (tested). Tokens are re-issued on every reconnect through the authenticated web route.

**Control plane / worker ↔ orchestrator REST.** Bearer API key, constant-time comparison; loopback or private network only.

**Orchestrator ↔ Docker.** Root-equivalent; validated inputs only (id pattern, bounded resources, image from config/label). Container recreation reuses the stored image label, never a request value from a browser.

**Orchestrator ↔ workspace agent.** Per-workspace HMAC token on an internal network or loopback; stripped from terminal environments.

**Container ↔ host.** Non-root `dev`, no sudo, `no-new-privileges`, `CapDrop ALL`, no bind mounts, cpu/mem/pids/shm limits, log rotation, `Init: true`; only the agent port is reachable (loopback in `published` mode).

**Agent exec/env.** Injected environment names must match `^[A-Z][A-Z0-9_]{0,63}$`; `PATH`, `HOME`, `USER`, `SHELL`, `LD_*`, `NODE_OPTIONS` and `NOTEA_*` are rejected (tested). Exec output is capped (8 MB), timed out (≤60 min) and killed when the owning connection closes. Exec/terminal creation requires the editor role.

**Agent tasks.** Creating/approving/cancelling tasks requires editor; deleting tasks and editing the policy require owner. Agents run as the workspace's `dev` user inside the container; they cannot reach the control plane or other workspaces beyond what any shell in that container could. Agents never touch the main tree: integration is a fast-forward performed by the worker after a human (or the `auto` policy) approves.

**Claude Code permission bypass (D-025).** Runs use `--dangerously-skip-permissions`. Accepted because the blast radius is the container plus a disposable worktree, credentials are per-run, and integration needs approval. Do not expose such workspaces to untrusted collaborators without revisiting.

**Provider credentials.** AES-256-GCM under `CREDENTIALS_KEY` (64 hex chars), per-user ownership enforced on every access, injected only into the run's session environment, masked in the UI. Alternative: CLI logins stored on the workspace volume (personal-use shortcut).

**Container ↔ container / control network.** Workspaces share `notea-workspaces`; Postgres must stay on a separate network in production (M2 compose).

**Workspace ↔ internet.** Full egress; no filtering.

## 3. Secrets
| Secret | Where | Notes |
|---|---|---|
| `ORCHESTRATOR_API_KEY`, `CONNECT_TOKEN_SECRET`, `AGENT_TOKEN_SECRET`, `AUTH_SECRET`, `CREDENTIALS_KEY` | root `.env` (gitignored; `.env.example` documents) | `openssl rand -hex 32` |
| Per-workspace agent token | container env | derived, not stored |
| Provider API keys | `provider_credentials`, encrypted | decrypted only by the worker for a run |
| User passwords | scrypt hashes in `users` | |

Never log tokens or secrets; logs carry user/workspace/task ids only.

## 4. Acceptable for personal use (current)
Docker-level isolation on an owner-controlled host; shared workspace network; a single root secret for agent tokens; CLI logins on volumes; no egress filtering; no disk quotas; permission-bypass agent runs; one worker process.

## 5. Required before public/commercial use
1. Runtime sandbox (gVisor/Kata/Firecracker) or dedicated hosts per tenant; per-tenant networks; egress policy.
2. Per-workspace random agent tokens stored encrypted; key rotation; envelope encryption for credentials.
3. Accounts: verification, reset, MFA, session revocation, OAuth/SSO; rate limits everywhere.
4. Quotas: disk (volumes, images, build cache), workspaces per user, run-time and cost budgets per task/user.
5. Audit log per workspace; tamper-evident.
6. Abuse detection (mining, spam), resource alarms.
7. Agent policy: tool allow-lists, per-task permission modes, mandatory review for risky scopes.
8. Backups and restore drills; deletion guarantees.

## 6. Operational lessons and checklist
- **Disk exhaustion is a real failure mode.** During development a full host disk turned Docker's VM read-only, killed Postgres queries and the worker, and broke image builds. Give the Docker data root and volumes dedicated space, monitor free space, prune build cache regularly, and keep the database on a disk with headroom.
- M2 checklist (single VPS): only 443 + SSH open; Caddy TLS; web/orchestrator/worker/postgres on compose networks; `.env` mode 600; automatic OS updates; volume and database backups; admin user via script; dev console off; `AGENT_CONNECT_MODE=network`.
