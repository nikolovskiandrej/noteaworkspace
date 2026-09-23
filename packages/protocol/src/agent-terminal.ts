/**
 * A member's own Claude terminal (D-045).
 *
 * Every member who can write to a workspace gets one: the Claude Code CLI, running
 * interactively inside the workspace container under that member's own Unix uid —
 * the identity their agent tasks already run as (D-039). The login the CLI keeps in
 * that uid's private HOME is therefore unreadable by every other member.
 *
 * Only the Docker daemon can start a process as another uid, so the terminal's pty
 * belongs to a `docker exec`, and the orchestrator holds its stream and serves it on
 * a WebSocket of its own (`/ws/workspaces/<id>/agent-terminal`) rather than through
 * the workspace agent. Everyone in the workspace may watch any member's terminal;
 * only the member it belongs to may start, type into, resize or stop it.
 */
import { z } from 'zod';
import { MAX_TERMINAL_INPUT_CHARS, type WorkspaceRole } from './messages';

export type AgentTerminalStatus = 'idle' | 'starting' | 'running' | 'exited';

export interface AgentTerminalInfo {
  /** `idle`: not started since the orchestrator started. `exited`: it ran and ended. */
  status: AgentTerminalStatus;
  cols: number;
  rows: number;
  /** Exit code of the last run; null while it runs, or when it could not be read. */
  exitCode: number | null;
  /** ISO-8601; when the current or last run started. */
  startedAt: string | null;
  /** Why the last start failed, when it did. */
  error: string | null;
}

/** The member a terminal belongs to. */
export interface AgentTerminalOwner {
  userId: string;
  name: string;
  /** Used as the author of the commits their Claude makes. */
  email: string;
  /** Their Unix uid inside the container (users.agent_uid). */
  uid: number;
}

const TerminalCols = z.number().int().min(10).max(500);
const TerminalRows = z.number().int().min(4).max(300);

export const AgentTerminalClientMessageSchema = z.discriminatedUnion('type', [
  /** Start the CLI if it is not running. Ignored while it starts or runs. */
  z.object({ type: z.literal('start'), cols: TerminalCols, rows: TerminalRows }),
  z.object({ type: z.literal('input'), data: z.string().max(MAX_TERMINAL_INPUT_CHARS) }),
  z.object({ type: z.literal('resize'), cols: TerminalCols, rows: TerminalRows }),
  /** Ends the CLI and everything it started. */
  z.object({ type: z.literal('stop') }),
]);

export type AgentTerminalClientMessage = z.infer<typeof AgentTerminalClientMessageSchema>;

export function parseAgentTerminalClientMessage(
  raw: string,
): { ok: true; message: AgentTerminalClientMessage } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const result = AgentTerminalClientMessageSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  }
  return { ok: true, message: result.data };
}

export type AgentTerminalServerMessage =
  /**
   * First message of every connection. `screen` reproduces what the terminal shows
   * (its scrollback included) when written into an empty terminal of `cols` × `rows`.
   * It cannot carry hyperlinks, so `links` lists the addresses of those printed so far
   * (Claude's sign-in link among them), for the client to find on screen again.
   */
  | {
      type: 'hello';
      canInput: boolean;
      owner: { userId: string; name: string };
      terminal: AgentTerminalInfo;
      screen: string;
      links: string[];
    }
  | { type: 'state'; terminal: AgentTerminalInfo }
  | { type: 'output'; data: string }
  /** A new run is starting: empty the terminal. */
  | { type: 'clear' }
  | { type: 'error'; message: string };

export interface IssueAgentTerminalTokenRequest {
  workspaceId: string;
  /** The member opening the connection. */
  userId: string;
  name: string;
  role: WorkspaceRole;
  /** The member whose terminal it is (possibly the same person). */
  owner: AgentTerminalOwner;
  ttlSeconds?: number;
}

export interface IssueAgentTerminalTokenResponse {
  token: string;
  expiresAt: string;
  wsPath: string;
  /** True only when the member opening it is its owner and may write. */
  canInput: boolean;
}

/** Claims of an agent-terminal token (JWT, HS256, short lived, its own audience). */
export interface AgentTerminalTokenClaims {
  sub: string;
  ws: string;
  name: string;
  role: WorkspaceRole;
  owner: AgentTerminalOwner;
  input: boolean;
}
