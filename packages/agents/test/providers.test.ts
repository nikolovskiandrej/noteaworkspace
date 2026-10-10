import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROVIDERS, findModel } from '../src/providers';

/**
 * The members' Claude terminals run the CLI baked into the workspace image and never
 * update themselves, so the image's pin decides which models `/model` offers. Sessions
 * 13 and 14 both hit that: a model in the catalog (or in the API) that the pinned CLI
 * did not know about. Each entry is the first claude-code version whose binary contains
 * the model id.
 */
const FIRST_CLAUDE_CODE_WITH: Record<string, string> = {
  'claude-opus-5-5': '2.1.280',
  'claude-sonnet-5-5': '2.1.284',
};

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number(part));
}

function atLeast(version: string, floor: string): boolean {
  const a = versionParts(version);
  const b = versionParts(floor);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return true;
}

function pinnedClaudeCode(): string {
  const dockerfile = readFileSync(new URL('../../../infra/workspace-image/Dockerfile', import.meta.url), 'utf8');
  const match = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/.exec(dockerfile);
  if (!match) throw new Error('the workspace image no longer pins @anthropic-ai/claude-code');
  return match[1]!;
}

/** The model the orchestrator starts every member's Claude terminal on (`--model`). */
function terminalModel(): string {
  const source = readFileSync(new URL('../../../apps/orchestrator/src/docker/agent-terminal.ts', import.meta.url), 'utf8');
  const match = /AGENT_TERMINAL_MODEL\s*=\s*'([^']+)'/.exec(source);
  if (!match) throw new Error('the members’ Claude terminals no longer name a model');
  return match[1]!;
}

describe('the Anthropic model catalog', () => {
  it('offers Sonnet 5.5 for background tasks', () => {
    expect(findModel({ provider: 'anthropic', modelId: 'claude-sonnet-5-5' })).toMatchObject({
      label: 'Claude Sonnet 5.5',
      capabilities: { tools: true, contextTokens: 1_000_000 },
    });
  });

  it('lists every model id once', () => {
    const ids = PROVIDERS.anthropic.models.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is not ahead of the Claude Code the workspace image pins', () => {
    const pinned = pinnedClaudeCode();
    for (const model of PROVIDERS.anthropic.models) {
      const floor = FIRST_CLAUDE_CODE_WITH[model.id];
      if (floor) expect(atLeast(pinned, floor), `${model.id} needs claude-code ${floor}; the image pins ${pinned}`).toBe(true);
    }
    // A model added to the table above must also be in the catalog.
    for (const id of Object.keys(FIRST_CLAUDE_CODE_WITH)) {
      expect(findModel({ provider: 'anthropic', modelId: id }), id).not.toBeNull();
    }
  });

  it('includes the model the members’ terminals start on, which the pinned Claude Code knows', () => {
    const id = terminalModel();
    expect(findModel({ provider: 'anthropic', modelId: id }), `${id} is not in the catalog`).not.toBeNull();
    const floor = FIRST_CLAUDE_CODE_WITH[id];
    if (floor) expect(atLeast(pinnedClaudeCode(), floor), `${id} needs claude-code ${floor}; the image pins ${pinnedClaudeCode()}`).toBe(true);
  });
});
