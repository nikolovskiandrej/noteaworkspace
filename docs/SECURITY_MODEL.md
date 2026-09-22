# Notea Workspace — Security Model

Last updated: 2026-09-15 (session 6). Scope: what is implemented, what is acceptable for **personal use**, what must change before **public/commercial** use.

## 1. Assets and actors
Assets: host machine, project files and secrets on workspace volumes, provider API keys, user accounts, other workspaces on the host, the Postgres database (tasks, events, encrypted credentials).
Actors: owner (trusted), invited collaborators (semi-trusted, shell access inside their workspaces), untrusted project code (dependencies, cloned repos, agent-written code), internet attackers (after M2), AI agents (treated as editors whose output is untrusted code).

## 2. Boundaries and controls (implemented unless noted)

**Browser ↔ control plane.** Auth.js JWT sessions in HTTP-only cookies; scrypt password hashes; constant-time-ish credential check (dummy hash for unknown emails); every server action and route handler re-checks the session and the workspace membership/role (`apps/web/src/lib/authz.ts`); non-members get "not found". No self sign-up. Failed sign-ins are rate limited per e-mail and per client address (`apps/web/src/lib/rate-limit.ts`; in memory, so per web process).

**Browser ↔ orchestrator WebSocket.** Short-lived HS256 connect tokens bound to one workspace, role and identity; identity injected by the orchestrator as the first frame; browsers cannot re-identify (tested). Tokens are re-issued on every reconnect through the authenticated web route. Frames a client sends while its token is still being verified are held, not dropped, and only ever reach the agent after the orchestrator's `identify`; that buffer is capped at 8 MB, so an unauthenticated peer cannot grow it.

**Control plane / worker ↔ orchestrator REST.** Bearer API key, constant-time comparison; loopback or private network only.

**Orchestrator ↔ Docker.** Root-equivalent; validated inputs only (id pattern, bounded resources, image from config/label). Container recreation reuses the stored image label, never a request value from a browser.

**Orchestrator ↔ workspace agent.** Per-workspace HMAC token on an internal network or loopback; stripped from terminal environments.

**Container ↔ host.** Non-root `dev`, no sudo, `no-new-privileges`, `CapDrop ALL`, no bind mounts, cpu/mem/pids/shm limits, log rotation, `Init: true`; only the agent port is reachable (loopback in `published` mode).

**Agent exec/env.** Injected environment names must match `^[A-Z][A-Z0-9_]{0,63}$`; `PATH`, `HOME`, `USER`, `SHELL`, `LD_*`, `NODE_OPTIONS` and `NOTEA_*` are rejected (tested). Exec output is capped (8 MB), timed out (≤60 min) and killed when the owning connection closes. Exec/terminal creation requires the editor role.

**Agent tasks.** Creating/approving/cancelling tasks requires editor; deleting tasks and editing the policy require owner. Agents run as **the uid of the member whose task it is** (never as `dev`, and never as another member); they cannot reach the control plane or other workspaces beyond what any shell in that container could. Agents never touch the main tree: integration is a fast-forward performed by the worker after a human (or the `auto` policy) approves.

**Claude Code permission bypass (D-025).** Runs use `--dangerously-skip-permissions`. Accepted because the blast radius is the container plus a disposable worktree, credentials are per-run, and integration needs approval. Do not expose such workspaces to untrusted collaborators without revisiting.

**Provider credentials.** AES-256-GCM under `CREDENTIALS_KEY` (64 hex chars), per-user ownership enforced when the task is created *and* re-checked by the worker before the run, injected only into a process running as that member's own uid, masked in the UI (the secret is never returned to a browser, only its shape). Alternative: a CLI login inside the member's private agent HOME on the workspace volume.

> **Resolved (session 6): every agent process runs as the Unix uid of the member whose task it is.**
>
> The exposure was real and was demonstrated: the agent ran as uid 1000 (`dev`), the
> same user as every human shell in the container, so anyone with terminal access
> could run `grep -a ANTHROPIC_API_KEY /proc/<agent pid>/environ` while a run was in
> flight. Session 5 established that no *incremental* mitigation existed — `hidepid`
> needs `CAP_SYS_ADMIN` and dropping to a second uid needs `CAP_SETUID`, and
> `CapDrop: ALL` + `no-new-privileges` (D-009) denies both by design — so the fix had
> to change the architecture rather than patch around it. It did:
>
> - Each Notea user owns a Unix uid (`users.agent_uid`, from `notea_agent_uid_seq`,
>   starting at 20001 and well clear of `dev`). It is stable for the user's lifetime,
>   because it owns their files as well as their processes.
> - Agent processes are started by the **Docker daemon** (`POST /workspaces/:id/agent-exec`
>   on the orchestrator, `User: <uid>:<dev gid>`), not by the in-container agent, which
>   as an unprivileged process cannot change uid. **No capability is restored**: an exec
>   under the new uid still reports `CapEff=0000000000000000` and `NoNewPrivs=1`.
> - The kernel then does the rest. `/proc/<pid>/environ` is mode `0400` owned by the
>   process's uid, and `ptrace_may_access` refuses it to every other uid — including
>   `dev`, and including a *different member's agent*.
> - HOME is per-uid (`/home/dev/.notea/agents/<uid>`, created `0700`), so a
>   `claude auth login` performed inside a workspace is private to that member too.
> - Exactly one credential variable is set per run, and every other provider variable
>   is cleared before the process starts, so a run cannot inherit an ambient key.
>
> **Verified against a real container** (`apps/orchestrator/test/docker.e2e.test.ts`,
> `npm run test:e2e -w @notea/orchestrator`): two members' agent processes run side by
> side, each holding a distinct marker secret; neither uid can read the other's
> environment, `dev` can read neither, a direct `cat` of the other's environ fails with
> `Permission denied`, each agent HOME is owner-only, and cancelling a run kills its
> whole process tree. `apps/worker/test/credential-isolation.test.ts` covers the other
> half: which uid a run is given, refusing a credential that belongs to another member,
> and the absence of any secret from logs, run events, workspace events, the task row
> and the agent's brief.
>
> **What this does not cover.** The container is still one trust domain for *code*: an
> agent or a shell can read the project files, and a member can read another member's
> worktree (that is the point of a shared project). The isolation is of identity and
> secrets, not of the source tree. And the per-workspace `NOTEA_AGENT_TOKEN` remains in
> PID 1's and the daemon's `/proc/<pid>/environ`, readable by any process in the
> container; its blast radius is the one workspace a container shell already controls.
> Giving the daemon a token that is not in its environment is the next step there.

**Agent identity isolation (how the pieces fit).**

| Who | Runs as | Can read |
|---|---|---|
| Human terminals, file tree, editor, integration | `dev` (uid 1000, gid 1000) | the project; not any agent's environment or HOME |
| Andrej's agent tasks | `users.agent_uid` for Andrej, gid 1000 | the project; only Andrej's credential and HOME |
| Niche's agent tasks | `users.agent_uid` for Niche, gid 1000 | the project; only Niche's credential and HOME |

The shared `dev` **group** is what lets all of them work on one project: the repository
is `core.sharedRepository=group`, `~/.notea/{worktrees,runs,agents}` are `2775`, and
agent processes run with `umask 002`. Nothing is granted to `other`. `dev` creates a
task's worktree and performs integration; the agent works inside it; the reaper (also
`dev`) can still delete what the agent wrote.

The orchestrator refuses any uid outside `AGENT_UID_MIN`–`AGENT_UID_MAX`, fixes the
gid itself, takes the command as argv (never a shell string), and rejects
`PATH`/`HOME`/`LD_*`/`NOTEA_*`/`NODE_OPTIONS` — so even a compromised control plane
cannot use this endpoint to become root or `dev`.

**Provider authentication and billing.** A credential belongs to exactly one user and
carries its mode (`provider_credentials.auth_mode`):

| Mode | Variable | Obtained by | Billing |
|---|---|---|---|
| `subscription` | `CLAUDE_CODE_OAUTH_TOKEN` | the member runs `claude setup-token` themselves | the member's Claude plan; no API charges |
| `api_key` | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | a key from the provider's console | pay-as-you-go on the key owner's account |

Notea never sets both. The CLI prefers the OAuth token when both are present, so
setting both would let a subscription silently become metered usage; the run clears
the modes it is not using. `claude auth status --json` is the authority on what
actually happened, and **Settings → AI & Claude** can run it inside a real container
under the member's own uid and show the answer. Notea implements no authentication
flow of its own: both mechanisms are the vendor CLI's, and no browser session, cookie
or token is ever scraped or relayed.

**Container ↔ container / control network.** Workspaces share `notea-workspaces`; Postgres must stay on a separate network in production (M2 compose).

**Workspace ↔ internet.** Full egress; no filtering.

## 3. Secrets
| Secret | Where | Notes |
|---|---|---|
| `ORCHESTRATOR_API_KEY`, `CONNECT_TOKEN_SECRET`, `AGENT_TOKEN_SECRET`, `AUTH_SECRET`, `CREDENTIALS_KEY` | root `.env` (gitignored; `.env.example` documents) | `openssl rand -hex 32` |
| Per-workspace agent token | container env | derived, not stored; readable inside the container (see above) |
| Provider credentials | `provider_credentials`, encrypted | decrypted only by the worker for one run, handed only to that member's uid |
| User passwords | scrypt hashes in `users` | |

Never log tokens or secrets; logs carry user/workspace/task ids only.

## 4. Acceptable for personal use (current)
Docker-level isolation on an owner-controlled host; shared workspace network; a single root secret for agent tokens; CLI logins on volumes; no egress filtering; no disk quotas; permission-bypass agent runs; one worker process.

Members of one workspace share the project and can read each other's files — that is
the product — but no longer each other's credentials.

## 5. Required before public/commercial use
1. Runtime sandbox (gVisor/Kata/Firecracker) or dedicated hosts per tenant; per-tenant networks; egress policy.
2. Per-workspace random agent tokens stored encrypted and kept out of the container's environment; key rotation; envelope encryption for credentials.
3. Accounts: verification, reset, MFA, session revocation, OAuth/SSO; rate limits everywhere.
4. Quotas: disk (volumes, images, build cache), workspaces per user, run-time and cost budgets per task/user.
5. Audit log per workspace; tamper-evident.
6. Abuse detection (mining, spam), resource alarms.
7. Agent policy: tool allow-lists, per-task permission modes, mandatory review for risky scopes.
8. Backups and restore drills; deletion guarantees.

## 6. Operational lessons and checklist
- **Disk exhaustion is a real failure mode.** During development a full host disk turned Docker's VM read-only, killed Postgres queries and the worker, and broke image builds. Give the Docker data root and volumes dedicated space, monitor free space, prune build cache regularly, and keep the database on a disk with headroom.
- M2 checklist (single VPS): only 443 + SSH open; Caddy TLS; web/orchestrator/worker/postgres on compose networks; `.env` mode 600; automatic OS updates; volume and database backups; admin user via script; dev console off; `AGENT_CONNECT_MODE=network`.
