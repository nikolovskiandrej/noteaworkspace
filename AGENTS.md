# Instructions for AI coding agents working on this repository

1. Read `docs/HANDOFF.md`, then `docs/CURRENT_STATE.md`, `docs/PROJECT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.
2. Verify the docs against the code before changing anything; if they disagree, fix the docs in the same change.
3. Do not redesign the architecture without a concrete technical reason recorded as a new entry in `docs/DECISIONS.md`.
4. Only modify files inside this repository.
5. Commands: `npm run typecheck`, `npm test`, `npm run build:image`, `npm run test:e2e -w @notea/orchestrator`.
6. Keep `docs/CURRENT_STATE.md` and `docs/HANDOFF.md` accurate as you work; they are the bridge between sessions.
7. Protocol changes (`packages/protocol`) are additive within v1; add schema + type + test together.
8. Never commit `.env`; never log tokens.
