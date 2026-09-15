import type { WorkspaceClient } from '@notea/workspace-client';
import type { CommandRunner, ExecOutcome } from './types';

export class CommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly outcome: ExecOutcome,
  ) {
    super(`command failed (${outcome.exitCode ?? outcome.signal}): ${command}\n${outcome.stderr || outcome.stdout}`.trim());
    this.name = 'CommandError';
  }
}

/**
 * Runs commands through a workspace connection (protocol exec), as the container's
 * `dev` user.
 *
 * `prefix` exists for the umask. The project is shared between `dev` and the
 * per-member agent uids through the `dev` group, so anything `dev` creates in a
 * worktree (`git worktree add`, a rebase) has to stay group-writable or the agent
 * that owns the run could not edit its own checkout. Default umask 022 would make
 * those files read-only to the group.
 */
export class WorkspaceCommandRunner implements CommandRunner {
  constructor(
    private readonly client: WorkspaceClient,
    private readonly defaults: { timeoutMs?: number; env?: Record<string, string>; prefix?: string } = {},
  ) {}

  async run(command: string, options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ExecOutcome> {
    const result = await this.client.runExec({
      command: this.defaults.prefix ? `${this.defaults.prefix}${command}` : command,
      shell: true,
      cwd: options.cwd,
      env: { ...(this.defaults.env ?? {}), ...(options.env ?? {}) },
      timeoutMs: options.timeoutMs ?? this.defaults.timeoutMs,
    });
    return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr };
  }
}

export type ScriptedResponse = Partial<ExecOutcome> | ((command: string, cwd: string | undefined) => Partial<ExecOutcome>);

/**
 * Test double: maps command lines (exact string or RegExp) to canned outcomes and
 * records every call. Unmatched commands succeed with empty output.
 */
export class ScriptedCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; cwd: string | undefined }> = [];
  private readonly rules: Array<{ match: string | RegExp; response: ScriptedResponse; once: boolean }> = [];

  on(match: string | RegExp, response: ScriptedResponse, options: { once?: boolean } = {}): this {
    this.rules.push({ match, response, once: options.once ?? false });
    return this;
  }

  async run(command: string, options: { cwd?: string } = {}): Promise<ExecOutcome> {
    this.calls.push({ command, cwd: options.cwd });
    const index = this.rules.findIndex((rule) =>
      typeof rule.match === 'string' ? rule.match === command : rule.match.test(command),
    );
    let partial: Partial<ExecOutcome> = {};
    if (index >= 0) {
      const rule = this.rules[index]!;
      partial = typeof rule.response === 'function' ? rule.response(command, options.cwd) : rule.response;
      if (rule.once) this.rules.splice(index, 1);
    }
    return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', ...partial };
  }
}

export async function runOrThrow(runner: CommandRunner, command: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecOutcome> {
  const outcome = await runner.run(command, options);
  if (outcome.exitCode !== 0) throw new CommandError(command, outcome);
  return outcome;
}

/** Quotes a string for bash. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
