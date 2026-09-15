import { shellQuote } from '../command-runner';
import { now, startTerminalRun } from '../terminal-run';
import type { AgentRunContext, AgentRunEvent, AgentRunHandle, AgentRuntime, ModelRef, WorkspaceSession } from '../types';

export const CLAUDE_CODE_TOOLS_THAT_WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface ClaudeCodeRuntimeOptions {
  /** Binary name or path inside the workspace image. */
  binary?: string;
  /**
   * `bypass` runs with --dangerously-skip-permissions: acceptable only because the
   * run is confined to a container and a throw-away worktree, and a human reviews
   * the diff before integration. `acceptEdits` cannot run shell commands headlessly.
   */
  permissionMode?: 'bypass' | 'acceptEdits';
}

/**
 * Claude Code CLI in headless mode (`claude -p … --output-format stream-json`).
 * The JSON-lines protocol is parsed defensively: unknown records become log events
 * so a CLI upgrade degrades to "less structure", not failure.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id = 'claude-code-cli' as const;
  readonly label = 'Claude Code (headless)';
  readonly provider = 'anthropic' as const;

  constructor(private readonly options: ClaudeCodeRuntimeOptions = {}) {}

  supports(model: ModelRef | null): boolean {
    return model === null || model.provider === 'anthropic';
  }

  buildCommandLine(ctx: AgentRunContext, briefPath: string): string {
    const binary = this.options.binary ?? 'claude';
    const flags = ['-p', `"$(cat ${shellQuote(briefPath)})"`, '--output-format', 'stream-json', '--verbose'];
    if (ctx.model) flags.push('--model', shellQuote(ctx.model.modelId));
    if (ctx.limits.maxTurns) flags.push('--max-turns', String(ctx.limits.maxTurns));
    if ((this.options.permissionMode ?? 'bypass') === 'bypass') flags.push('--dangerously-skip-permissions');
    else flags.push('--permission-mode', 'acceptEdits');
    return `cd ${shellQuote(ctx.worktreePath)} && ${binary} ${flags.join(' ')}`;
  }

  async start(ctx: AgentRunContext, session: WorkspaceSession): Promise<AgentRunHandle> {
    const briefPath = `/home/dev/.notea/runs/${ctx.runId}/brief.md`;
    await session.writeHostFile(briefPath, ctx.brief);
    return startTerminalRun(session, {
      command: '/bin/bash',
      args: ['-lc', this.buildCommandLine(ctx, briefPath)],
      cwd: ctx.worktreePath,
      title: `agent: ${ctx.identity.name}`,
      env: ctx.credentialEnv,
      maxMinutes: ctx.limits.maxMinutes,
      parseLine: parseClaudeStreamLine,
      onExit: (exitCode, state) => {
        if (state.sawFinished) {
          // The `result` record already produced the finished event; emit a log only.
          return { type: 'log', level: 'debug', text: `process exited with ${exitCode}`, at: now() };
        }
        return {
          type: 'finished',
          outcome: state.cancelled ? 'cancelled' : state.timedOut ? 'timeout' : exitCode === 0 ? 'completed' : 'failed',
          summary: null,
          exitCode,
          at: now(),
        };
      },
    });
  }
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** Parses one line of Claude Code stream-json output into run events. */
export function parseClaudeStreamLine(line: string): AgentRunEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith('{')) return [{ type: 'log', level: 'info', text: trimmed, at: now() }];
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [{ type: 'log', level: 'info', text: trimmed, at: now() }];
  }
  const at = now();
  const type = record.type;
  if (type === 'assistant' || type === 'user') {
    const message = record.message as { content?: ContentBlock[] | string } | undefined;
    const content = message?.content;
    const events: AgentRunEvent[] = [];
    if (typeof content === 'string') {
      events.push({ type: 'message', role: type, text: content, at });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) events.push({ type: 'message', role: type, text: block.text, at });
        else if (block.type === 'tool_use' && block.name) {
          events.push({ type: 'tool_call', name: block.name, input: block.input ?? {}, at });
          const filePath = block.input?.file_path ?? block.input?.path;
          if (CLAUDE_CODE_TOOLS_THAT_WRITE.has(block.name) && typeof filePath === 'string') {
            events.push({ type: 'file_changed', path: filePath, at });
          }
        }
      }
    }
    return events;
  }
  if (type === 'result') {
    const usage = record.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const cost = typeof record.total_cost_usd === 'number' ? record.total_cost_usd : null;
    const subtype = typeof record.subtype === 'string' ? record.subtype : 'unknown';
    const events: AgentRunEvent[] = [];
    if (usage || cost !== null) {
      events.push({ type: 'usage', inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, costUsd: cost, at });
    }
    events.push({
      type: 'finished',
      outcome: subtype === 'success' ? 'completed' : 'failed',
      summary: typeof record.result === 'string' ? record.result : null,
      exitCode: null,
      at,
    });
    return events;
  }
  if (type === 'system') {
    return [{ type: 'log', level: 'debug', text: `system ${String(record.subtype ?? '')}`.trim(), at }];
  }
  return [{ type: 'log', level: 'debug', text: trimmed.slice(0, 500), at }];
}
