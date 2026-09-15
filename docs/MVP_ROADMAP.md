# Notea Workspace — MVP Roadmap

Last updated: 2026-09-15 (session 2).

| Milestone | Statement | Status |
|---|---|---|
| **M0 Foundation** | Protocol, workspace agent, base image, orchestrator; terminal driven end to end against a real container. | **done, tested** (session 1) |
| **M1 Personal workspace** | Create a workspace in a browser, get a terminal, browse and edit files. | **done, tested, verified in Chrome** (session 2) |
| **M2 Remote access + collaboration** | Reach the same workspace from another computer; two people simultaneously. | **partial**: membership, roles, shared terminals, presence, change notices done; deployment (compose/Caddy), rate limiting, invite links, watcher pending |
| **M3 Agents in the workspace** | AI coding agents operate inside the workspace on tasks, in isolation, with review. | **done for the pipeline** (worktree runs, review, serialized integration, credentials) and **verified in Docker with the generic runtime**; real Claude Code run pending |
| **M4 Coordination extras** | Leases, approvals, cost accounting, agent roles. | leases + approvals + basic usage done; budgets, roles, richer policies pending |
| **M5 Previews and deployment** | Port detection, preview proxy, deploy adapters. | not started |

## Acceptance evidence so far
- `npm test`: 114 tests across 8 packages (see `CURRENT_STATE.md`).
- Docker e2e: container lifecycle, terminal I/O, exec, persistence.
- Browser: sign-in → create workspace → terminal → edit/save → tasks panel → task run → approve → integrated commit visible in `git log`.

## Next milestones in order
1. **M3 completion**: first real Claude Code run; parser fixtures from real output; Codex/Gemini structured parsing; live run events in the UI.
2. **M2 completion**: compose for a single VPS (caddy, web, orchestrator, worker, postgres), sign-in rate limiting, invite links, file watcher, `network` connect mode verification on Linux.
3. **M4**: cost budgets per task/user, per-task permission modes, agent roles (implementer/reviewer), conflict follow-up tasks generated automatically.
4. **M5**: previews.
