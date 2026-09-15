import { shellQuote } from '../command-runner';
import type { AgentRuntime, RuntimeId } from '../types';
import { ClaudeCodeRuntime } from './claude-code';
import { CodexRuntime } from './codex';
import { GeminiRuntime } from './gemini';
import { GenericCliRuntime } from './generic-cli';

/**
 * Runtime registry. Command lines were verified against the CLIs baked into the
 * workspace image (claude-code 2.1.272, codex-cli 0.154.0, gemini-cli 0.59.0) by
 * running each through the full task pipeline (they fail cleanly without
 * credentials). Authenticated runs still need a user credential.
 */
export function createRuntimeRegistry(): Map<RuntimeId, AgentRuntime> {
  const runtimes: AgentRuntime[] = [
    new ClaudeCodeRuntime(),
    new CodexRuntime(),
    new GeminiRuntime(),
    new GenericCliRuntime({
      id: 'generic-cli',
      label: 'Any command',
      provider: null,
      command: (ctx) => `cd ${shellQuote(ctx.worktreePath)} && ${ctx.command ?? 'echo "no command configured"; exit 1'}`,
    }),
  ];
  return new Map(runtimes.map((runtime) => [runtime.id, runtime]));
}
