# Notea Workspace — Decision Log

Format: context → options → decision → why → revisit when. Numbers are stable; never renumber. Mark superseded decisions instead of deleting them.

---

### D-001 Project root is `D:\ClaudeProjects\notea-workspace`
**Context.** The session was launched in `D:\ClaudeProjects`, a folder holding nine unrelated projects (including `Notea`, a pitch website, and `notea-app`, a Firebase study app for a different product).
**Decision.** Create a dedicated subfolder with its own git repository and treat it as the only writable project root.
**Why.** Scaffolding into the shared folder would have mixed this project with others and violated the isolation rule.
**Revisit.** Never; move the folder if desired, nothing depends on the absolute path.

### D-002 TypeScript monorepo with npm workspaces
**Options.** npm workspaces; pnpm (not installed; would need corepack/global install); Turborepo/Nx.
**Decision.** npm workspaces, TypeScript 5.9 (not the 7.x native preview), `moduleResolution: bundler`, packages export TypeScript source directly, `tsx` for dev, esbuild for bundles, vitest for tests.
**Why.** Zero global installs on the user's machine; simple for the next agent; source exports remove build steps between packages. TS 7 is too new for the tooling around it (Next.js, vitest) to be a safe default.
**Revisit.** If install times or hoisting problems appear, switch to pnpm (mechanical change).

### D-003 In-container workspace agent instead of `docker exec`-based terminals
**Options.** (a) Orchestrator spawns terminals via Docker exec streams. (b) A daemon inside the container owns PTYs and exposes a WebSocket.
**Decision.** (b), written in TypeScript, bundled to one file, using node-pty.
**Why.** Sessions must survive orchestrator restarts and browser disconnects, support many viewers, replay scrollback, and later host file watching, port detection and agent runners. Docker exec streams cannot be re-attached and tie terminal lifetime to the orchestrator process. This is the pattern used by Coder, Gitpod and Codespaces.
**Revisit.** A Go static binary would shrink the image and remove Node from the agent's dependencies; only worth it if Node-in-image becomes a problem (it will not, since dev images ship Node anyway).

### D-004 Orchestrator is a separate service from the web app
**Options.** (a) Next.js custom server doing Docker + WebSockets. (b) Separate Fastify service for runtime concerns; Next.js for the control plane.
**Decision.** (b).
**Why.** Long-lived WebSockets and Docker socket access do not belong in a Next.js process (custom servers disable optimisations, serverless deployment becomes impossible, and the control plane would be pinned to the Docker host). The split is the seam for multi-host and multi-tenant later.
**Revisit.** Not expected. If the web app is ever deployed off-host (Vercel), the split is what makes that possible.

### D-005 Orchestrator is stateless; Docker is the source of truth for runtime state
**Decision.** No database in the orchestrator. Containers are found by labels; status is derived from `docker inspect`. The control plane owns metadata.
**Why.** Restart safety and simplicity; avoids two sources of truth for "is it running".
**Revisit.** If per-host scheduling state is needed (many hosts), add a small table in the control plane keyed by `runtimeHostId`, still not in the orchestrator.

### D-006 Protocol v1: JSON text frames, `type` discriminator, `reqId` correlation
**Options.** JSON; MessagePack/binary frames with channel prefixes; gRPC-web.
**Decision.** JSON text frames; zod validation for untrusted direction; explicit protocol version in `hello`.
**Why.** Debuggable, trivial in browsers, fast enough for terminal traffic at personal scale. node-pty already delivers strings, so no encoding issue.
**Revisit.** If terminal throughput or CPU becomes a problem, add a binary frame variant for `term.output`/`term.input` under a new protocol version; keep JSON for control messages.

### D-007 Identity is asserted once, by the orchestrator, in the first frame
**Decision.** The agent accepts `identify` only as the first frame of a connection; later `identify` frames are ignored. The orchestrator always sends it before forwarding client bytes.
**Why.** Lets the orchestrator remain a pure pipe (no per-frame parsing) while making identity unforgeable from the browser. Tested.
**Revisit.** If agents ever accept direct browser connections (no orchestrator), the agent would need to verify JWTs itself; the token service is small enough to embed.

### D-008 Connect tokens are short-lived HS256 JWTs; agent tokens are HMAC-derived
**Decision.** Browser connect tokens: JWT (jose), 5-minute default, 1-hour max, claims `{sub=userId, ws=workspaceId, name, role, kind}`, issuer/audience pinned. Agent tokens: `HMAC-SHA256(AGENT_TOKEN_SECRET, "agent:"+workspaceId)` injected into the container environment at creation.
**Why.** No token storage; verifiable offline; the browser never sees the agent token; rotating the root secret invalidates all agent tokens (containers must be recreated, which is acceptable).
**Revisit.** For multi-tenant hosting, move to per-workspace random tokens stored encrypted so a single root secret leak does not expose every workspace.

### D-009 Container hardening: non-root, cap-drop ALL, no-new-privileges, limits, no sudo
**Options.** Keep Docker default capabilities and offer passwordless sudo (friendlier); drop everything and forbid privilege escalation (safer).
**Decision.** Drop everything. System packages belong in the image. `Init: true`, cpu/memory/pids/shm limits, json-file log rotation, no bind mounts ever.
**Why.** Personal MVP still executes untrusted project code (npm postinstall scripts, cloned repositories). Removing capabilities and setuid escalation costs little for a dev environment and removes whole classes of escape paths.
**Revisit.** Per-workspace opt-in `allowSudo` that restores a minimal capability set could be added for owners who accept the risk; per-project images are the intended answer.

### D-010 Persistent volume mounted at `/home/dev`; project at `/home/dev/project`
**Options.** Volume at `/workspace` only (files persist, tool state does not); volume at HOME (both persist).
**Decision.** HOME.
**Why.** AI CLIs store logins under `~/.claude`, `~/.codex` etc.; shell history and caches matter for a "come back tomorrow" workspace. The container layer remains disposable.
**Revisit.** If volume growth from caches becomes a problem, add quotas or a separate cache volume.

### D-011 Two agent connectivity modes (`network` vs `published`)
**Decision.** Linux hosts connect to the container IP on the workspace network; Docker Desktop hosts publish the agent port on `127.0.0.1` with a random host port. `auto` chooses by platform.
**Why.** Docker Desktop on Windows/macOS cannot route from the host to container IPs. Publishing on loopback keeps the port private to the host.
**Revisit.** Running the orchestrator inside compose in development would remove the need for `published`; keep both until then.

### D-012 No CRDT editor in the MVP; etag-based conflict detection instead
**Decision.** `fs.write` accepts `expectedEtag` and fails with `conflict` if the file changed. The editor (M1) reads, edits, writes with the etag; on conflict it offers reload/overwrite. File-change notifications come in M3.
**Why.** Real-time co-editing is a large feature with subtle failure modes and is not what proves the product. Terminals are already shared.
**Revisit.** M3+: add Yjs with a provider in the agent (`y-websocket` style), keeping the file API for non-collaborative saves.

### D-013 Agent isolation by git worktree per task; integration is serialised
**Options.** Shared working tree with file locks; worktree per task; container per agent with a copied repo.
**Decision.** Worktree per task inside the same container (`/home/dev/.notea/worktrees/<taskId>` on branch `notea/task/<taskId>`), advisory scope leases checked at task start, integration through a single-writer queue (rebase, run checks, fast-forward). Details in `AGENT_SYSTEM.md`.
**Why.** File locks do not work with CLI agents; copying repos wastes space and loses shared tool state; worktrees are cheap, git-native, and what Claude Code / Codex tooling already understands.
**Revisit.** If tasks routinely need isolated dependency installs or ports, move heavy tasks to sibling containers that mount the same volume.

### D-014 Provider abstraction starts with CLI runtimes, not a custom agent loop
**Decision.** First agent runtimes drive existing CLIs (Claude Code, Codex CLI, Gemini CLI) in tagged terminal sessions (interactive) or headless mode with JSON event streams. A custom API-driven agent loop is a later runtime behind the same interface.
**Why.** The CLIs are the state of the art, maintained by the providers, and already read `AGENTS.md`/`CLAUDE.md`. Writing a competing loop first would burn budget without proving the product.
**Revisit.** When cost tracking, fine-grained tool permissions or custom tools require it, implement the `api-loop` runtime against the provider SDKs.

### D-015 Postgres + Drizzle; Auth.js v5 with credentials
**Options.** Supabase/Clerk (external accounts); custom auth; Prisma.
**Decision.** Self-hosted Postgres, Drizzle ORM, Auth.js credentials provider with argon2 hashes and JWT sessions.
**Why.** No external service dependency for a self-hosted personal tool; Drizzle keeps SQL visible; Auth.js makes adding OAuth later a configuration change.
**Revisit.** Multi-tenant SaaS may justify a managed identity provider.

### D-016 Next.js 16 (App Router) for the control plane
**Options.** Vite SPA + Fastify API; Next.js.
**Decision.** Next.js 16, React 19, Tailwind 4, xterm.js 6.
**Why.** Server-rendered pages, route handlers and server actions cover the small control-plane API without a second backend; best supported by the next implementing agent.
**Revisit.** Only if the control plane grows a large realtime surface that Next.js handles poorly; SSE covers what is planned.

### D-017 Logging: dependency-free JSON logger in the agent, pino in the orchestrator
**Why.** Keeps the agent bundle predictable inside the image; pino comes with Fastify.

### D-018 No ESLint/Prettier configured yet (accepted debt)
**Why.** Budget went to architecture and the runtime path. Formatting is consistent by hand; add ESLint 10 flat config + Prettier in M1.

### D-019 Restart policy `unless-stopped` for workspace containers
**Why.** Workspaces should survive host reboots without orchestrator logic. The orchestrator's `stop` uses Docker stop, which `unless-stopped` respects.

### D-020 Terminal replay uses raw scrollback bytes
**Why.** Simple and good enough for shells. Exact screen reconstruction (headless xterm serialisation) is a listed improvement.

### D-022 A development-only browser console lives in the orchestrator
**Decision.** `GET /dev/console` (enabled only with `DEV_CONSOLE=true`) serves a static xterm.js page that creates/starts a workspace and embeds a one-hour connect token.
**Why.** Proves the browser path before the Next.js app exists, gives the M1 terminal component a working reference (attach/replay, resize, reconnect), and costs ~150 lines. It must never be enabled on a reachable host (no auth, mints tokens).
**Revisit.** Delete it once `apps/web` has a terminal, or keep it as an operator debugging tool behind the API key.

### D-021 npm install scripts are allow-listed explicitly
**Context.** npm 11.16+ blocks package install scripts unless allow-listed. `esbuild` and `node-pty` are approved in the root `package.json`; `node-pty` is approved in the image's `package.json`. `ssh2` and `protobufjs` (dockerode transitive) are deliberately not approved; they work without their optional native builds.

---

### D-023 Password hashing with Node's scrypt, no native dependency
**Decision.** `scrypt$N$r$p$salt$hash` via `node:crypto`; parameters recorded per hash.
**Why.** No install scripts, no platform binaries; memory-hard and adequate for a self-hosted tool.

### D-024 Agent runs execute in watchable terminal sessions; exec is for short commands
**Decision.** Runtimes start the CLI in a PTY session created through the protocol (everyone can attach); `exec` (protocol 1.1) is used for git/check commands and is killed when its connection closes.
**Why.** Glass-box agents (PROJECT_SPEC principle 1) and scrollback replay for free; exec stays simple and cannot leak detached processes.

### D-025 Claude Code runs headless with `--dangerously-skip-permissions`
**Decision.** Default `permissionMode: bypass` in `ClaudeCodeRuntime`; `acceptEdits` available.
**Why.** Headless runs cannot answer permission prompts; the container, the throw-away worktree, scoped credentials and human review before integration are the sandbox. Revisit when per-tool permission policies exist.

### D-026 A separate worker process drives agent tasks
**Options.** Inside the web app (unreliable for long jobs), inside the orchestrator (mixes control-plane logic into the runtime plane), separate process polling Postgres.
**Decision.** `apps/worker`, polling every 2 s, optimistic claims, heartbeats, stale-run recovery.
**Why.** Durable queue in the database, restart-safe, scalable to several workers later without touching the orchestrator.
**Revisit.** Use LISTEN/NOTIFY instead of polling if latency matters.

### D-027 Provider credentials encrypted with AES-256-GCM under CREDENTIALS_KEY
**Decision.** Stored as `v1:<iv>:<tag>:<ciphertext>`; decrypted by the worker only for the run that selected them; injected into the session env only; the web app decrypts solely to render a masked hint.
**Revisit.** Envelope encryption / KMS for multi-tenant hosting.

### D-028 Containers are recreated on start when the image behind the tag changed
**Why.** Otherwise image upgrades (new agent, new CLIs) never reach existing workspaces; found when the first real task failed against a stale agent.

### D-029 OrchestratorClient lives in `packages/workspace-client`
**Why.** The web app and the worker share one implementation.

### D-030 Coordination policy is a per-workspace JSON document; integration is serialised in-process
**Decision.** `{overlap: warn|block, integration: auto|human, checkCommand, baseBranch}` on `workspaces`; `PerKeyMutex` serialises integrations per workspace within the worker.
**Why.** Enough for one worker; a database advisory lock is the upgrade path for several workers.

### D-031 Next.js development must allow the 127.0.0.1 origin
**Context.** Next 16 blocks its dev resources cross-origin; pages reached as 127.0.0.1 silently never hydrated. `allowedDevOrigins` is set in `next.config.ts`. Operational note, not a design choice.

### D-032 The development host's storage lives on D:, and Docker's data disk moved there
**Context.** The machine's system drive is 145 GB and was at 1 GB free; the data drive has 328 GB. Docker Desktop's WSL2 data disk (15.5 GB, holding every image, container, volume and build-cache entry) sat on the system drive, and a single image rebuild was enough to fill it — that is what turned Docker's VM read-only mid-session and broke the dev database and the worker.
**Decision.** Move Docker Desktop's data disk to `D:\DockerDesktop\wsl`, point the npm cache at `D:\NoteaWorkspaceData\npm-cache`, and redirect test scratch to a repository-local `.tmp`. Everything else this project stores was already inside the repository or inside a Docker named volume, so it followed automatically.
**Why this way.** The move was done through Docker Desktop's own routine (the `wslDataFolder` setting on its backend API, persisted as `CustomWslDistroDir`), which stops the engine, unregisters the WSL distro, moves the disk and re-registers it. Copying the VHDX by hand would have left the WSL registration pointing at the old path, and editing `settings-store.json` directly is silently ignored — Docker starts on a fresh empty disk instead, which is indistinguishable from data loss until you look.
**Consequence.** Docker's storage is shared with an unrelated project on this machine, so this moved that project's containers and volumes too. They were preserved and restarted; nothing was pruned or deleted. The storage location is therefore a property of the machine, not of this repository: only `.tmp` follows a clone.
**Revisit.** On a Linux production host this is moot — set `data-root` in `daemon.json` at install time instead.

### D-033 Query strings never reach the orchestrator log
**Context.** Browsers and the worker open the bridge as `/ws/workspaces/<id>?token=<connect JWT>`. Fastify's default request serializer logs `req.url` verbatim, so every connection wrote a live workspace credential — owner role included — into the orchestrator's log, contradicting SECURITY_MODEL.md §3.
**Decision.** `buildApp` installs a request serializer that replaces any query string with `?<redacted>`, applied last so a caller's serializers cannot restore full-URL logging. Method, path, host, address and status are still logged, so requests stay traceable.
**Revisit.** If a route ever needs a query value in the log, log that field explicitly rather than the raw URL.

### D-034 The worker's concurrency limit is counted in-process, not in the database
**Context.** The tick claimed tasks while `countOwnRunningRuns` (a database query) was below the limit, but `runTask` writes its `agent_runs` row several round trips after the claim. The count therefore read zero while previous claims were still starting up, and a single tick could claim every queued task at once, ignoring `WORKER_MAX_CONCURRENT_RUNS`.
**Decision.** `RunSlots` counts the run promises this process is holding; `startDueRuns` claims only while a slot is free. Accurate, immediate, and it does not strand a restarted worker behind its own stale `running` rows.
**Consequence.** The limit is per worker, not global. Run one worker (CURRENT_STATE known issue 8).

### D-035 The integration lease is taken inside the per-workspace mutex
**Context.** The lease was acquired before `PerKeyMutex.run`. Two approved tasks in one workspace both acquired it (the holder check passes for the same `workerId`); when the first finished, its release cleared the lease while the second was still queued on the mutex, so the second integrated into the main tree holding no cross-process lock.
**Decision.** Claim the task (`approved → integrating`), then take the lease inside the mutex and release it in the same scope. If another worker holds it, the task is set back to `approved` and retried on a later tick.

### D-036 The agent event stream always terminates
**Context.** The worker consumes `handle.events` with `for await` and has no timeout of its own, while its heartbeat keeps refreshing. If a session's exit notification was lost, the stream never ended: the task sat in `running` forever and stale-run recovery — which looks for a *stopped* heartbeat — never reclaimed it.
**Decision.** `startTerminalRun` routes every terminal event through one `settle()`, and after a kill (timeout or cancellation) it ends the stream itself if no exit arrives within `EXIT_GRACE_MS` (10 s, overridable for tests).

### D-037 A run's failure keeps the CLI's own explanation
**Context.** A CLI can report a success-shaped result that is actually a failure, then exit non-zero; the runtime overrides the outcome on the exit code, and the worker keeps the last `finished` event. That correctly produced `failed` — and threw away the summary, so the UI showed a failure with no reason.
**Decision.** `startTerminalRun` remembers the last non-empty `finished` summary and passes it to `onExit` as `state.summary`; the runtimes carry it into the overriding event. Verified against the real claude-code CLI: the run ends `failed` exit 1 with summary "Not logged in · Please run /login".
