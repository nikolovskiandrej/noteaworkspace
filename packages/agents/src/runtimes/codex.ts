import { shellQuote } from '../command-runner';
import { now, startTerminalRun, stripAnsi } from '../terminal-run';
import type { AgentRunContext, AgentRunEvent, AgentRunHandle, AgentRuntime, ModelRef, WorkspaceSession } from '../types';

/**
 * OpenAI Codex CLI in headless mode (`codex exec --json …`). Flags verified against
 * codex-cli 0.154.0: `--dangerously-bypass-approvals-and-sandbox` (our container and
 * worktree are the sandbox), `--skip-git-repo-check`, `--json`, `-m`. The JSONL
 * record shapes below follow the documented `codex exec --json` events and are parsed
 * defensively; unknown records become log events.
 */
export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex-cli' as const;
  readonly label = 'OpenAI Codex CLI (headless)';
  readonly provider = 'openai' as const;

  constructor(private readonly options: { binary?: string } = {}) {}

  supports(model: ModelRef | null): boolean {
    return model === null || model.provider === 'openai';
  }

  buildCommandLine(ctx: AgentRunContext, briefPath: string): string {
    const binary = this.options.binary ?? 'codex';
    const flags = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
    if (ctx.model) flags.push('-m', shellQuote(ctx.model.modelId));
    flags.push(`"$(cat ${shellQuote(briefPath)})"`);
    return `cd ${shellQuote(ctx.worktreePath)} && ${binary} ${flags.join(' ')} < /dev/null`;
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
      parseLine: parseCodexLine,
      onExit: (exitCode, state) => ({
        type: 'finished',
        outcome: state.cancelled ? 'cancelled' : state.timedOut ? 'timeout' : exitCode === 0 ? 'completed' : 'failed',
        summary: state.summary,
        exitCode,
        at: now(),
      }),
    });
  }
}

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  status?: string;
}

/** Parses one line of `codex exec --json` output. */
export function parseCodexLine(line: string): AgentRunEvent[] {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed) return [];
  const at = now();
  if (!trimmed.startsWith('{')) {
    const level = /\bERROR\b/.test(trimmed) ? 'error' : /\bWARN\b/.test(trimmed) ? 'warn' : 'info';
    return [{ type: 'log', level, text: trimmed.slice(0, 1000), at }];
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [{ type: 'log', level: 'info', text: trimmed.slice(0, 1000), at }];
  }
  const type = typeof record.type === 'string' ? record.type : 'unknown';
  switch (type) {
    case 'thread.started':
    case 'turn.started':
      return [{ type: 'log', level: 'debug', text: type, at }];
    case 'error':
      return [{ type: 'log', level: 'error', text: String(record.message ?? 'error'), at }];
    case 'item.completed':
    case 'item.started': {
      const item = (record.item ?? {}) as CodexItem;
      const events: AgentRunEvent[] = [];
      if (type === 'item.completed' && item.type === 'agent_message' && item.text) {
        events.push({ type: 'message', role: 'assistant', text: item.text, at });
      } else if (type === 'item.started' && item.type === 'command_execution' && item.command) {
        events.push({ type: 'tool_call', name: 'shell', input: { command: item.command }, at });
      } else if (type === 'item.completed' && item.type === 'file_change') {
        for (const change of item.changes ?? []) {
          if (change.path) events.push({ type: 'file_changed', path: change.path, at });
        }
      } else if (type === 'item.completed' && item.type === 'reasoning' && item.text) {
        events.push({ type: 'log', level: 'debug', text: item.text.slice(0, 500), at });
      }
      return events;
    }
    case 'turn.completed': {
      const usage = (record.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      return [{ type: 'usage', inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, costUsd: null, at }];
    }
    case 'turn.failed':
      return [{ type: 'log', level: 'error', text: String((record.error as { message?: string } | undefined)?.message ?? 'turn failed'), at }];
    default:
      return [{ type: 'log', level: 'debug', text: trimmed.slice(0, 500), at }];
  }
}
