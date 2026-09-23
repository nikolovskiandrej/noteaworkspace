# Notea Workspace — Implementation Plan

Last updated: 2026-09-15 (session 2). Ordered steps for the next implementing agent.

> **Status (session 11).** This plan predates sessions 3–11 and is kept for its reasoning. Done since: Step 1 (authenticated Claude Code runs and their fixtures, sessions 7–8), sign-in rate limiting from Step 4, and Step 5's deployment templates (`infra/deploy/`, `DEPLOYMENT.md`; the control plane is live, the runtime host is not). Runs are no longer `agent:` terminals (D-039); follow them in the task's run log. The current, ordered next steps are in `HANDOFF.md` §24.

## Conventions
TypeScript strict; zod at trust boundaries; tests beside code in `test/`; packages export TS source; protocol changes are additive within v1.x (schema + type + test together); `npm run typecheck && npm test` (with `DATABASE_URL`) before every commit; keep `docs/CURRENT_STATE.md` accurate.

## Step 1 — First real Claude Code run (highest value)
1. Connect a Claude credential under Settings → AI & Claude (a subscription token from `claude setup-token`, or an API key); it is injected only into that member's own agent processes.
2. Create a Claude Code task with a small scope; watch the `agent:` terminal.
3. Compare the real stream-json records with `parseClaudeStreamLine`; fix flags/parsing in `packages/agents/src/runtimes/claude-code.ts`; add real lines as fixtures in `packages/agents/test/runtimes.test.ts`.
4. Confirm usage/cost extraction and the `finished` summary; confirm the commit/diff flow and approval.

## Step 2 — Codex and Gemini
Verify command lines in `packages/agents/src/runtimes/index.ts` against `codex 0.154.0` and `gemini 0.59.0`; implement parsers if they emit JSON; otherwise keep them generic and document.

## Step 3 — Live run events
Add an SSE route (`/api/tasks/[id]/events`) or reuse the workspace WebSocket (a `task.event` broadcast from the worker through a small orchestrator-side or web-side channel) so the tasks panel updates without page refresh. Keep the 5 s refresh as fallback.

## Step 4 — Collaboration leftovers (M2)
Sign-in rate limiting (token bucket per email+IP in the credentials `authorize`), invite links (`workspace_invites`), file watcher in the agent (`fs.watch` recursive with ignore list) emitting `fs.changed` for terminal-side edits, activity events for connections (bridge → web internal endpoint).

## Step 5 — Deployment (M2)
`infra/compose/docker-compose.prod.yml` (caddy, web `next build`+`next start`, orchestrator bundle, worker, postgres on `notea-control`), `Caddyfile`, `.env.production.example`, bootstrap script, backup notes. Use `AGENT_CONNECT_MODE=network`. Keep the Docker data root on a disk with headroom (see SECURITY_MODEL §6).

## Step 6 — Quality
ESLint 10 + Prettier; a Docker e2e for the worker pipeline (spin orchestrator + worker + Postgres in the test); slim image variant; N+1 cleanup in `listTasksForWorkspace`.

## Step 7 — Coordination extras (M4)
Cost budgets (`maxCostUsd` on tasks; cancel on exceed), per-task permission mode, reviewer agents (a task type that reviews another task's diff), automatic follow-up task on `needs_rebase`, branch cleanup policy.

## Step 8 — Previews (M5)
Agent: listening-port detection → `ports.changed`; orchestrator: authenticated HTTP proxy; UI preview tab.

## Testing plan
Step 1: parser fixtures + a recorded run transcript. Step 3: SSE route test. Step 4: rate-limit unit test, watcher test in the agent, invite flow test. Step 5: compose smoke script. Step 6: worker Docker e2e.
