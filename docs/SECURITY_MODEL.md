# Notea Workspace — Security Model

Last updated: 2026-09-15. Scope: what is implemented now, what is acceptable for **personal use**, and what must change before **public/commercial** use.

## 1. Assets and actors

Assets: the host machine, project source and secrets on workspace volumes, provider API keys and CLI logins, user accounts, other workspaces on the same host.

Actors:
- **Owner** (trusted): runs the host.
- **Invited collaborators** (semi-trusted): can run arbitrary code inside workspaces they are members of.
- **Untrusted project code**: cloned repositories, npm/pip packages with install scripts, anything an AI agent writes and runs.
- **Internet attackers**: once the service is reachable remotely (M2).
- **AI agents**: treated like collaborators with the role they were given; their output is untrusted code.

## 2. Boundaries and controls

### Browser ↔ control plane (M1, planned)
Auth.js sessions (HTTP-only cookies), argon2 password hashes, CSRF protection by same-site cookies and server actions, rate limiting on sign-in (M2).

### Browser ↔ orchestrator WebSocket (implemented)
- Connect tokens: HS256 JWT, issuer/audience pinned, 5-minute default TTL (max 1 hour), bound to one workspace id, carry role and identity. Verified in `apps/orchestrator/src/tokens.ts`; tested for expiry, tampering, wrong secret, wrong workspace.
- Identity binding: the orchestrator injects the `identify` frame; the agent ignores later identify frames (tested).
- The browser never receives the agent token or the REST API key.

### Control plane ↔ orchestrator REST (implemented)
Bearer API key compared in constant time (`routes/workspaces.ts`). Intended to run on a private network or loopback; in M2 it stays inside the compose network and is never exposed by Caddy.

### Orchestrator ↔ Docker (implemented)
The orchestrator holds the Docker socket and is therefore root-equivalent on the host. It is trusted infrastructure and must never execute user-controlled Docker parameters. Inputs are validated: workspace ids match a strict pattern, resource limits are bounded, image names come from configuration or a validated request field.

### Orchestrator ↔ workspace agent (implemented)
Per-workspace agent token (HMAC of a root secret) passed as `?token=` on an internal network or loopback. Constant-time comparison in the agent (`server.ts`). Processes inside the container can read the token from the agent's environment; this grants nothing they do not already have (they already run as `dev` in that container). The token is stripped from terminal environments (`index.ts`).

### Container ↔ host (implemented in `docker/spec.ts`, tested)
- Non-root user `dev` (uid 1000), no sudo, no setuid escalation (`no-new-privileges`), `CapDrop: ALL`, `Privileged: false`.
- No bind mounts; the only mount is the named volume at `/home/dev`. The Docker socket is never mounted into workspaces.
- Limits: CPU (`NanoCpus`), memory with swap disabled, pids, shm size, log rotation. `Init: true` for zombie reaping.
- Ports: nothing published except, in `published` mode, the agent port on `127.0.0.1`.

### Container ↔ container / control network
Workspaces share the `notea-workspaces` bridge network and can reach each other by IP. Acceptable for personal use (all workspaces belong to the owner). Postgres and the web app must live on a different network (M2 compose design) so workspaces cannot reach them.

### Workspace ↔ internet
Full egress (git, package registries, model APIs). No egress filtering.

## 3. Secrets

| Secret | Where | Notes |
|---|---|---|
| `ORCHESTRATOR_API_KEY`, `CONNECT_TOKEN_SECRET`, `AGENT_TOKEN_SECRET` | `.env` on the host (never committed; `.env.example` documents them) | Generate with `openssl rand -hex 32`. |
| Per-workspace agent token | Container env only | Derived; nothing stored. |
| Provider API keys (M4) | `provider_credentials`, AES-256-GCM with `CREDENTIALS_KEY` | Injected into agent sessions per run. |
| CLI logins made by users inside a workspace | Workspace volume under `/home/dev` | Personal-use shortcut; see §5. |
| Database URL, Auth secret (M1) | `.env` | |

Never log tokens. The orchestrator logs user ids and workspace ids only.

## 4. What is acceptable for personal use (current state)

- Docker (not a VM sandbox) on a host the owner controls, with hardened containers. A kernel exploit from inside a container is a risk the owner accepts for their own workspaces.
- Collaborators are people the owner invites; they get shell access inside the workspace container, nothing on the host.
- A single root secret for agent tokens.
- Users logging in to AI CLIs inside their workspace, storing tokens on the volume.
- No egress filtering, no disk quotas.

## 5. Required before public or commercial use

1. **Tenant isolation:** runtime sandbox (gVisor or Kata/Firecracker) or dedicated hosts per tenant; per-tenant networks; egress policies.
2. **Secrets:** per-workspace random agent tokens stored encrypted; managed key rotation; provider credentials only via the encrypted store and per-run injection (no CLI logins on shared volumes).
3. **Accounts:** email verification, password reset, MFA option, session revocation, OAuth/SSO.
4. **Quotas:** disk quotas on volumes, per-user workspace limits, run-time budgets for agents.
5. **Audit:** immutable activity/audit log per workspace and organisation.
6. **Abuse controls:** rate limits, CPU/network abuse detection, crypto-mining detection.
7. **Hardening:** seccomp/AppArmor profiles, read-only root filesystem with explicit writable paths, user namespaces (rootless Docker), image scanning, dependency review of the agent bundle.
8. **Data:** backups and restore drills for volumes and Postgres; data deletion on workspace removal (`deleteVolume=true` path already exists).

## 6. Operational checklist for M2 (single VPS)

- Only 443 (and SSH with keys) open; Caddy terminates TLS.
- Web and orchestrator REST reachable only inside the compose network; the orchestrator WebSocket path is proxied by Caddy at `/ws/`.
- `.env` permissions `600`; secrets generated, not typed.
- Automatic security updates on the host; Docker updated.
- Volume backups (`docker run --rm -v notea-ws-<id>-home:/data … tar`) scheduled.
- Sign-in rate limiting enabled; admin user created via script, no self sign-up.
