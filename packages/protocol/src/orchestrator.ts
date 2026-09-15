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

export interface OrchestratorErrorBody {
  error: {
    code: string;
    message: string;
  };
}
