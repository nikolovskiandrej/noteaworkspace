/**
 * Types for the orchestrator's HTTP API (control plane -> orchestrator) and the
 * connect tokens it verifies on browser WebSocket connections.
 *
 * The orchestrator is a *runtime* service: it manages containers and bridges
 * WebSockets. It deliberately knows nothing about users, memberships or billing.
 * The control plane (apps/web) owns that metadata in Postgres and calls this API.
 */
import type { ClientKind, WorkspaceRole } from './messages';

export type WorkspaceRuntimeStatus =
  | 'creating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'unknown';

export interface WorkspaceResources {
  /** CPU quota in whole or fractional CPUs, e.g. 2 or 0.5. */
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
}

export interface WorkspaceRuntimeInfo {
  workspaceId: string;
  status: WorkspaceRuntimeStatus;
  containerId: string | null;
  image: string;
  volumeName: string;
  resources: WorkspaceResources | null;
  createdAt: string | null;
  startedAt: string | null;
  /** Docker's textual status, for debugging. */
  dockerStatus: string | null;
}

export interface CreateWorkspaceRuntimeRequest {
  /** Control-plane workspace id. Must be a URL-safe slug or UUID. */
  workspaceId: string;
  image?: string;
  resources?: Partial<WorkspaceResources>;
  /** Start the container right after creation (default true). */
  start?: boolean;
}

export interface IssueConnectTokenRequest {
  workspaceId: string;
  userId: string;
  name: string;
  role: WorkspaceRole;
  kind?: ClientKind;
  /** Seconds. Default and maximum are enforced by the orchestrator. */
  ttlSeconds?: number;
}

export interface IssueConnectTokenResponse {
  token: string;
  expiresAt: string;
  /** Absolute or relative WebSocket URL the browser should open. */
  wsPath: string;
}

/** Claims embedded in a connect token (JWT, HS256, short lived). */
export interface ConnectTokenClaims {
  /** userId */
  sub: string;
  /** workspaceId */
  ws: string;
  name: string;
  role: WorkspaceRole;
  kind: ClientKind;
}

/**
 * Runs one process inside a workspace container as a specific Unix uid.
 *
 * This exists because the in-container agent daemon runs as `dev` (uid 1000) and,
 * with `CapDrop: ALL` + `no-new-privileges`, cannot change uid — only the Docker
 * daemon can. Running each member's agent under their own uid is what stops one
 * member reading another's provider credential out of `/proc/<pid>/environ`.
 *
 * The orchestrator refuses any uid outside the agent range, so this endpoint can
 * never be used to obtain root or the `dev` user's identity.
 */
export interface AgentExecRequest {
  /** Unix uid to run as. Must be inside the orchestrator's agent uid range. */
  uid: number;
  /** Argv. Not a shell string: the orchestrator never concatenates commands. */
  cmd: string[];
  /** Working directory inside the container. */
  cwd?: string;
  /** Extra environment for this process only. Names must be SHOUTY_SNAKE_CASE. */
  env?: Record<string, string>;
  /** Names to remove from the inherited environment before the process starts. */
  unsetEnv?: string[];
  /** Allocate a pty. Agent CLIs behave better with one; buffered runs do not need it. */
  tty?: boolean;
  /** Stream output as it arrives (NDJSON) instead of buffering it. */
  stream?: boolean;
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
}

/** Response of a buffered (`stream: false`) agent exec. */
export interface AgentExecResult {
  execId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when output was cut at the orchestrator's cap. */
  truncated: boolean;
}

/** One NDJSON frame of a streamed (`stream: true`) agent exec. */
export type AgentExecFrame =
  | { type: 'started'; execId: string }
  | { type: 'out'; data: string }
  | { type: 'err'; data: string }
  | { type: 'exit'; exitCode: number | null; timedOut: boolean }
  /**
   * Sent periodically while the process runs. An agent can be silent for minutes (a
   * long test run inside one tool call), and Node's fetch aborts a response body
   * that receives nothing for 300 s, which reads as the process having ended.
   */
  | { type: 'keepalive' };

export interface OrchestratorErrorBody {
  error: {
    code: string;
    message: string;
  };
}
