# Notea Workspace — Implementation Plan

Last updated: 2026-09-15 (session 2). Ordered steps for the next implementing agent.

## Conventions
TypeScript strict; zod at trust boundaries; tests beside code in `test/`; packages export TS source; protocol changes are additive within v1.x (schema + type + test together); `npm run typecheck && npm test` (with `DATABASE_URL`) before every commit; keep `docs/CURRENT_STATE.md` accurate.

## Step 1 — First real Claude Code run (highest value)
1. Store an Anthropic key under Settings → Credentials (or `claude login` in a workspace terminal).
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
