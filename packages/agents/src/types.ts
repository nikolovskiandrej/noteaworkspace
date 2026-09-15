import type { ClientIdentity } from '@notea/protocol';

export type ProviderId = 'anthropic' | 'openai' | 'google';

/**
 * How a provider credential authenticates, which decides both the environment
 * variable it becomes and who pays. Kept explicit everywhere so a subscription can
 * never silently turn into metered API usage.
 */
export type AuthMode = 'subscription' | 'api_key';

export interface AuthModeInfo {
  id: AuthMode;
  /** The single environment variable the CLI reads this credential from. */
  env: string;
  /** Shown in the UI, e.g. "Claude subscription". */
  label: string;
  /** Shown in the UI next to the mode, e.g. "no API charges". */
  billing: string;
  /** Instruction for the user on how to obtain the secret themselves. */
  obtain: string;
  /** Shape check used to warn when a secret is pasted into the wrong mode. */
  secretPattern?: RegExp;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Free-form capability flags used by the UI and runtimes. */
  capabilities: { tools: boolean; contextTokens: number };
  /** Set when unsure; the UI shows a hint to verify the id with the provider. */
  unverified?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** Environment variable the CLIs and SDKs read the API key from (`api_key` mode). */
  credentialEnv: string;
  models: ModelInfo[];
}

export interface ModelRef {
  provider: ProviderId;
  modelId: string;
}

export type RuntimeId = 'claude-code-cli' | 'codex-cli' | 'gemini-cli' | 'generic-cli';

/** Everything a runtime needs to execute one run of one task inside a workspace. */
export interface AgentRunContext {
  workspaceId: string;
  taskId: string;
  runId: string;
  /** Absolute path of the task worktree inside the container. */
  worktreePath: string;
  branch: string;
  /** The generated task brief (prompt). */
  brief: string;
  model: ModelRef | null;
  /**
   * The one credential variable for this run (e.g. CLAUDE_CODE_OAUTH_TOKEN *or*
   * ANTHROPIC_API_KEY, never both). Injected into the agent process only, and only
   * into a process running as the task owner's own uid.
   */
  credentialEnv: Record<string, string>;
  identity: ClientIdentity;
  /** Wall-clock and spend limits; runtimes pass what their CLI supports. */
  limits: { maxMinutes: number; maxBudgetUsd?: number };
  /** For `generic-cli`: the command line to run in the worktree. */
  command?: string;
}

export type AgentRunOutcome = 'completed' | 'failed' | 'cancelled' | 'timeout';

export type AgentRunEvent =
  | { type: 'started'; sessionId: string; at: string }
  | { type: 'message'; role: 'assistant' | 'user' | 'system'; text: string; at: string }
  | { type: 'tool_call'; name: string; input: unknown; at: string }
  | { type: 'file_changed'; path: string; at: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number | null; at: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; text: string; at: string }
  | { type: 'finished'; outcome: AgentRunOutcome; summary: string | null; exitCode: number | null; at: string };

export interface AgentRunHandle {
  sessionId: string;
  events: AsyncIterable<AgentRunEvent>;
  /** Interrupts the run (kills the session). The event stream ends with `finished`. */
  cancel(): Promise<void>;
}

/** Minimal surface the runtimes need from a workspace connection. */
export interface WorkspaceSession {
  createTerminal(input: {
    cols: number;
    rows: number;
    command: string;
    args: string[];
    cwd: string;
    title: string;
    env?: Record<string, string>;
    attach?: boolean;
    /**
     * Hard deadline for the process, honoured by sessions whose transport can
     * enforce one. A backstop for the run's own timer, not a replacement.
     */
    timeoutMs?: number;
  }): Promise<{ sessionId: string }>;
  killTerminal(sessionId: string): Promise<void>;
  onTerminalOutput(sessionId: string, listener: (data: string) => void): () => void;
  onTerminalExit(sessionId: string, listener: (exitCode: number | null) => void): () => void;
  /** Writes a file outside the project (e.g. the brief) via a shell; returns nothing. */
  writeHostFile(path: string, content: string): Promise<void>;
  /** Writes the file only if it does not exist yet (first-run defaults such as CLI settings). */
  ensureHostFile(path: string, content: string): Promise<void>;
}

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly label: string;
  readonly provider: ProviderId | null;
  supports(model: ModelRef | null): boolean;
  start(ctx: AgentRunContext, session: WorkspaceSession): Promise<AgentRunHandle>;
}

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'needs_review'
  | 'approved'
  | 'integrating'
  | 'needs_rebase'
  | 'checks_failed'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface ExecOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  /** Runs a shell command line (bash -lc) in the given directory. Never throws on non-zero exit. */
  run(command: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecOutcome>;
}
