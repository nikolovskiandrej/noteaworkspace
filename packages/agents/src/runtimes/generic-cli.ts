import { runBriefPath } from '../layout';
import { now, startTerminalRun } from '../terminal-run';
import type { AgentRunContext, AgentRunHandle, AgentRuntime, ModelRef, ProviderId, RuntimeId, WorkspaceSession } from '../types';

export interface GenericCliRuntimeConfig {
  id: RuntimeId;
  label: string;
  provider: ProviderId | null;
  /** Builds the shell command line; the brief path holds the prompt. */
  command: (ctx: AgentRunContext, briefPath: string) => string;
}

/**
 * Runs any command line in a watchable terminal and reports its output as log
 * events. Used for CLIs whose structured output has not been integrated yet
 * (Codex CLI, Gemini CLI) and for arbitrary scripts.
 */
export class GenericCliRuntime implements AgentRuntime {
  readonly id: RuntimeId;
  readonly label: string;
  readonly provider: ProviderId | null;

  constructor(private readonly config: GenericCliRuntimeConfig) {
    this.id = config.id;
    this.label = config.label;
    this.provider = config.provider;
  }

  supports(model: ModelRef | null): boolean {
    return this.provider === null || model === null || model.provider === this.provider;
  }

  async start(ctx: AgentRunContext, session: WorkspaceSession): Promise<AgentRunHandle> {
    const briefPath = runBriefPath(ctx.runId);
    await session.writeHostFile(briefPath, ctx.brief);
    return startTerminalRun(session, {
      command: '/bin/bash',
      args: ['-lc', this.config.command(ctx, briefPath)],
      cwd: ctx.worktreePath,
      title: `agent: ${ctx.identity.name}`,
      env: ctx.credentialEnv,
      maxMinutes: ctx.limits.maxMinutes,
      parseLine: (line) => (line.trim() ? [{ type: 'log', level: 'info', text: line, at: now() }] : []),
      onExit: (exitCode, state) => ({
        type: 'finished',
        outcome: state.cancelled ? 'cancelled' : state.timedOut ? 'timeout' : exitCode === 0 ? 'completed' : 'failed',
        summary: null,
        exitCode,
        at: now(),
      }),
    });
  }
}
