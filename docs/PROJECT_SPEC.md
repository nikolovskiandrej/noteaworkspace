# Notea Workspace — Project Specification

Status vocabulary used across all docs: **planned** (agreed, no code), **designed** (concrete design written, no code), **partially implemented**, **implemented** (code exists), **tested** (automated tests pass), **broken**, **postponed**.

Last updated: 2026-09-20 (session 8). §6 and §7 were checked against the code in session 8; the status words there had been left at session 1's values long after the code caught up.

## 1. One sentence

Notea Workspace is a self-hosted, browser-based, shared remote development workspace in which several people and several AI coding agents work on the same software project at the same time, with terminals, files, previews and coordination built in.

## 2. The problem

Today a developer who wants to work with a co-founder in another city and with two or three AI coding agents at once has to glue together: a remote machine or codespace, a shared terminal tool, a way to run each agent CLI, a git worktree per agent, and a chat to agree on who touches what. Every agent session rediscovers the project. Nobody can see what the other agents are doing. Conflicts appear at merge time.

## 3. Vision (long term)

A shared live AI engineering workspace:

- one persistent Linux environment per project, reachable from any browser;
- multiple humans in the same workspace with shared terminals, files and previews;
- multiple AI agents (Claude, Codex, Gemini, others) running inside the workspace as visible participants, each on its own task, coordinated so they do not trample each other;
- project memory that lives with the project so agents and people never start from zero;
- previews, and later deployment, from the same environment.

## 4. Explicit non-goals for now

- Not "GitHub with AI" and not a Git hosting product. Git is used as the isolation and integration mechanism, not as the product.
- No commercial SaaS features now: billing, organisations, quotas, audit exports, SSO. Documented as FUTURE in `ARCHITECTURE.md` and `SECURITY_MODEL.md`.
- No Kubernetes, no multi-host scheduling, no microVMs in the personal MVP.
- No real-time CRDT co-editing in the MVP (etag-based conflict detection instead; see `DECISIONS.md` D-012).
- Not building an AI model or a coding agent from scratch. Existing agent CLIs and provider APIs are integrated.

## 5. Users and operating mode

- **Now:** personal use by the project owner and a small number of invited collaborators on a machine the owner controls (Windows dev machine with Docker Desktop today; a single Linux VPS later).
- **Later:** teams; multi-tenant hosting. The architecture keeps a control plane / runtime plane split and per-workspace identities so this remains possible without a rewrite.

## 6. Core concepts (glossary)

| Term | Meaning |
|---|---|
| **Workspace** | The unit of collaboration: one project, one persistent Linux environment, a set of members, a set of terminal sessions, tasks and activity. |
| **Workspace runtime** | The Docker container plus named volume that realise a workspace. Managed by the orchestrator. |
| **Workspace agent** | A small daemon inside every workspace container. Owns PTYs, file operations and presence. `packages/workspace-agent`. |
| **Orchestrator** | The runtime service on the Docker host: creates/starts/stops containers and bridges browser WebSockets to workspace agents. `apps/orchestrator`. |
| **Control plane** | The web application: users, auth, workspace metadata, memberships, tasks, activity. Talks to the orchestrator over an internal REST API. `apps/web`. Implemented. |
| **Participant / client** | Any connection to a workspace: a human in a browser or an AI agent runner. Both carry an identity `{userId, name, kind, role}`. |
| **Role** | `owner`, `editor`, `viewer`. Viewers can watch terminals and read files but not type or write. |
| **Terminal session** | A PTY running inside the workspace. Sessions outlive browser connections; several participants can attach to one session. |
| **Agent runtime** | An adapter that runs an AI coding agent (for example the Claude Code CLI) inside a workspace for a task. Implemented: `claude-code-cli`, `codex-cli`, `gemini-cli`, `generic-cli`. |
| **Provider / model / credential** | Where a model comes from (Anthropic, OpenAI, Google), which model, and whose key. Implemented: `provider_credentials`, per user, encrypted, with an `auth_mode` that decides billing (D-040). |
| **Task** | A unit of agent work with a description, a scope (paths), a branch/worktree and a status. Implemented: `agent_tasks` + the state machine in `packages/agents`. |
| **Integration queue** | Serialised merge of finished task branches into the main tree with checks. Implemented — as task statuses plus a per-workspace integration lease, not as a queue table. |
| **Activity feed** | Time-ordered record of who did what in a workspace (human and agent). Implemented: `workspace_events`, shown in the workspace UI. |

## 7. Target user flow

1. Open Notea Workspace, sign in.
2. Create a workspace: **a name, and optionally a slug — that is all the code accepts** (`createWorkspace` in `apps/web/src/lib/workspaces.ts`). There is no repository-URL field and no image picker; the image comes from the `workspaces.image` column default. The `workspaces.repo_url` column exists but is never written or read by any code path, so a new workspace starts with an **empty** `/home/dev/project`.
3. The orchestrator creates a container + volume; the workspace agent starts inside it.
3a. You populate the project yourself, by asking your Claude (step 4) to clone or create it in `/home/dev/project`. Cloning on creation is not implemented.
4. Enter the workspace: the middle is one Claude terminal per member who can write, side by side (since session 12, D-045; there is no file tree, editor or shell tab any more), with people, activity and tasks on the right.
5. Your Claude starts by itself: Claude Code, interactive, in `/home/dev/project`, as your own Unix user. The first time, it asks you to sign in with your own Claude account, right in the terminal; the sign-in is private to you and kept on the workspace volume.
6. Type or paste prompts into it; it edits files and runs the app (`!` runs a shell command); see it in a preview tab (preview proxying is a later milestone).
7. Add a collaborator by email (they need an account); they sign in and land in the same workspace, with a Claude of their own.
8. Both see both Claudes live, working on the same files, and who is doing what; each can type only into their own.
9. Start an AI agent on a task; the agent appears as a participant, and everyone can follow its run log in the task (since D-039 a run is no longer a terminal session, so it cannot be attached to live).
10. Start a second agent on a different task with a different provider; the coordinator gives each its own worktree and warns on overlapping scopes.
11. Finished tasks are integrated one at a time after checks pass; humans approve when the workspace policy says so.
12. Stop the workspace; files, shell history and tool logins persist on the volume; start it again tomorrow.

## 8. Milestones

| Milestone | Statement | Status |
|---|---|---|
| **M0 Foundation** | Monorepo, protocol, workspace agent, orchestrator, base image; a terminal can be driven end to end through the orchestrator against a real container. | implemented; tested (55 unit/integration tests + Docker e2e passing on 2026-09-15) |
| **M1 Personal workspace** | "I can create a Notea Workspace in a browser and get a terminal in a remote Linux environment." Web app with sign-in, workspace list, terminal UI, file tree + editor. | implemented; tested; verified in Chrome (2026-09-15) |
| **M2 Remote access** | "I can reach the same workspace from another computer." Single-VPS deployment with TLS, password auth, hardened defaults. | planned (deployment); auth and hardening exist |
| **M3 Multiplayer** | "Two people can use the same workspace simultaneously." Invites, roles, shared terminals with presence, file-change notifications, activity feed. | partially implemented (members/roles/presence/shared terminals/change notices/activity); invite links and watcher pending |
| **M4 Agents in the workspace** | "AI coding agents can operate inside the workspace." Headless task runs in worktrees; provider credentials scoped per run; runs followed through their run log. | implemented; tested; authenticated Claude Code runs end to end (sessions 7 and 8); Codex and Gemini await credentials |
| **M5 Coordination** | Tasks, scope leases, integration queue, approvals, cost tracking. | implemented (leases, serialized integration, approvals, basic usage); budgets pending |
| **M6 Previews and deployment** | Port detection and proxied preview URLs; later deployment targets. | planned |

Details, acceptance criteria and ordering: `MVP_ROADMAP.md`.

## 9. Product principles

1. **Glass-box agents.** An AI agent is a participant with a visible terminal and an activity trail, never a hidden background job.
2. **Humans and agents are peers in the protocol.** Same identity shape, same roles, same session model. Policy differs; plumbing does not.
3. **Isolation by default, integration by design.** Each agent task works in its own worktree; a serialised integration step brings work together. Literal simultaneous editing of the same file is not the model.
4. **The repository is the memory.** Project knowledge lives in versioned files in the project (`AGENTS.md`, `docs/*.md`), not in the platform database, so any tool and any provider can read it.
5. **Provider-agnostic.** No component other than a provider adapter knows the name of a model vendor.
6. **Personal first, commercial-compatible.** Build only what personal use needs, but keep identities, memberships and a control-plane/runtime split so multi-tenancy is an extension, not a rewrite.
7. **Boring, replaceable infrastructure.** Docker, Postgres, WebSockets, Node. Each is swappable behind a small interface.

## 10. Prior art and differentiation

Checked on 2026-09-15 (web search; see `ARCHITECTURE.md` §12 for detail):

- **Remote dev environments:** Coder, Gitpod/Ona, GitHub Codespaces, Daytona, DevPod. Standard: container/VM per workspace with an in-workspace agent, browser IDE, persistent volume. Notea adopts this shape.
- **Pairing on agent terminals:** Coterm (macOS, two developers pairing on Claude Code sessions), CodeSwarm (terminal relay for agents). Standard: shared PTY streaming.
- **Parallel agent orchestration:** Conductor, Claude Squad, Vibe Kanban (company shut down April 2026, project community-maintained), cmux, Clopen. Standard: one git worktree per agent, a dashboard of runs. Worktree-per-agent is now the accepted pattern.
- **Research:** GitHub Next "Ace" prototype: realtime multiplayer agent workspace on shared cloud machines. Closest to the Notea vision; not a product.

Genuinely hard and not commodity: (a) multi-human + multi-agent presence and coordination in one live environment, (b) provider-agnostic agent runtimes sharing one coordination model, (c) serialised integration with policy (leases, approvals) rather than "open a PR per agent".

Where Notea can differentiate: the combination, self-hosting, and treating agents as visible peers instead of a queue of background jobs.

## 11. Intellectual property note

Not a patent exercise. The search surfaced granted US patents titled "Collaborative remote interactive platform" (US 11,314,474; 11,249,715; 11,662,970; 12,014,106). Nothing here relies on them, but before any commercial launch a professional freedom-to-operate review is advisable. No claim is made that Notea's concept is patentable.
