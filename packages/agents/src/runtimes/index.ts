import { shellQuote } from '../command-runner';
import type { AgentRuntime, RuntimeId } from '../types';
import { ClaudeCodeRuntime } from './claude-code';
import { GenericCliRuntime } from './generic-cli';

/**
 * Runtime registry. Codex and Gemini command shapes are best-effort and must be
 * verified against the installed CLI versions before relying on them (their
 * structured output is not parsed yet; they run as generic CLIs).
 */
export function createRuntimeRegistry(): Map<RuntimeId, AgentRuntime> {
  const runtimes: AgentRuntime[] = [
    new ClaudeCodeRuntime(),
    new GenericCliRuntime({
      id: 'codex-cli',
      label: 'OpenAI Codex CLI (unverified flags)',
      provider: 'openai',
      command: (ctx, briefPath) =>
        `cd ${shellQuote(ctx.worktreePath)} && codex exec --full-auto ${ctx.model ? `--model ${shellQuote(ctx.model.modelId)} ` : ''}"$(cat ${shellQuote(briefPath)})"`,
    }),
    new GenericCliRuntime({
      id: 'gemini-cli',
      label: 'Gemini CLI (unverified flags)',
      provider: 'google',
      command: (ctx, briefPath) =>
        `cd ${shellQuote(ctx.worktreePath)} && gemini --yolo ${ctx.model ? `--model ${shellQuote(ctx.model.modelId)} ` : ''}--prompt "$(cat ${shellQuote(briefPath)})"`,
    }),
    new GenericCliRuntime({
      id: 'generic-cli',
      label: 'Any command',
      provider: null,
      command: (ctx) => `cd ${shellQuote(ctx.worktreePath)} && ${ctx.command ?? 'echo "no command configured"; exit 1'}`,
    }),
  ];
  return new Map(runtimes.map((runtime) => [runtime.id, runtime]));
}
