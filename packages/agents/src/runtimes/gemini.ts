import { shellQuote } from '../command-runner';
import { runBriefPath } from '../layout';
import { now, startTerminalRun, stripAnsi } from '../terminal-run';
import type { AgentRunContext, AgentRunHandle, AgentRuntime, ModelRef, WorkspaceSession } from '../types';

/**
 * Gemini CLI in headless mode (`gemini -p … --approval-mode yolo`), verified against
 * gemini-cli 0.59.0. Gemini refuses autonomous tool use in folders it does not
 * trust, so on first use the runtime seeds `~/.gemini/settings.json` (only if the
 * file does not exist) with folder trust disabled: the container and worktree are
 * the sandbox. Output is treated as text (log events); structured `stream-json`
 * parsing is a follow-up once its record shapes are confirmed.
 */
export class GeminiRuntime implements AgentRuntime {
  readonly id = 'gemini-cli' as const;
  readonly label = 'Gemini CLI (headless)';
  readonly provider = 'google' as const;

  constructor(private readonly options: { binary?: string } = {}) {}

  supports(model: ModelRef | null): boolean {
    return model === null || model.provider === 'google';
  }

  buildCommandLine(ctx: AgentRunContext, briefPath: string): string {
    const binary = this.options.binary ?? 'gemini';
    const flags = ['--approval-mode', 'yolo'];
    if (ctx.model) flags.push('-m', shellQuote(ctx.model.modelId));
    flags.push('-p', `"$(cat ${shellQuote(briefPath)})"`);
    return `cd ${shellQuote(ctx.worktreePath)} && ${binary} ${flags.join(' ')} < /dev/null`;
  }

  async start(ctx: AgentRunContext, session: WorkspaceSession): Promise<AgentRunHandle> {
    const briefPath = runBriefPath(ctx.runId);
    await session.writeHostFile(briefPath, ctx.brief);
    await session.ensureHostFile('/home/dev/.gemini/settings.json', JSON.stringify({ security: { folderTrust: { enabled: false } } }, null, 2) + '\n');
    return startTerminalRun(session, {
      command: '/bin/bash',
      args: ['-lc', this.buildCommandLine(ctx, briefPath)],
      cwd: ctx.worktreePath,
      title: `agent: ${ctx.identity.name}`,
      env: ctx.credentialEnv,
      maxMinutes: ctx.limits.maxMinutes,
      parseLine: (line) => {
        const text = stripAnsi(line).trim();
        if (!text) return [];
        const level = /\b(error|failed|unauthorized)\b/i.test(text) ? 'error' : 'info';
        return [{ type: 'log', level, text: text.slice(0, 1000), at: now() }];
      },
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
