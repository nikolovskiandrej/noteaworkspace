/**
 * Workspace protocol, version 1.
 *
 * One WebSocket connection per browser tab (or per AI agent runner) carries every
 * channel for a workspace: terminals, files, presence. Messages are JSON text frames
 * with a `type` discriminator. Requests carry a `reqId`; the matching reply echoes it.
 * Unsolicited events (output, presence, exits) have no `reqId`.
 *
 * Direction naming:
 *   client  -> agent : `ClientMessage` (validated with zod, because clients are untrusted)
 *   agent   -> client: `AgentMessage`  (typed only)
 *
 * The orchestrator sits between browser and agent as a pure pipe. Its only
 * protocol-level action is to send the `identify` frame first, on the client's behalf.
 * The agent honours `identify` only as the very first frame of a connection, so a
 * browser can never spoof its own identity.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const AGENT_WS_PATH = '/ws';
export const AGENT_HEALTH_PATH = '/healthz';
export const DEFAULT_AGENT_PORT = 7070;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export const ClientKindSchema = z.enum(['user', 'agent', 'system']);
export type ClientKind = z.infer<typeof ClientKindSchema>;

export const WorkspaceRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const ClientIdentitySchema = z.object({
  /** Connection id, assigned by the orchestrator. Unique per live connection. */
  id: z.string().min(1).max(128),
  /** Stable id of the human user or AI agent behind this connection. */
  userId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  kind: ClientKindSchema,
  role: WorkspaceRoleSchema,
});
export type ClientIdentity = z.infer<typeof ClientIdentitySchema>;

export interface TerminalCreator {
  userId: string;
  name: string;
  kind: ClientKind;
}

export interface TerminalSessionInfo {
  id: string;
  title: string;
  cols: number;
  rows: number;
  cwd: string;
  command: string;
  args: string[];
  /** ISO-8601 */
  createdAt: string;
  createdBy: TerminalCreator | null;
  pid: number | null;
  attachedClientIds: string[];
}

export interface PresenceClient {
  id: string;
  userId: string;
  name: string;
  kind: ClientKind;
  role: WorkspaceRole;
  attachedSessionIds: string[];
}

export type FsEntryType = 'file' | 'dir' | 'symlink' | 'other';

export interface FsEntry {
  name: string;
  type: FsEntryType;
  size: number;
  mtimeMs: number;
}

export type ErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'limit_exceeded'
  | 'internal';

// ---------------------------------------------------------------------------
// Client -> agent messages (validated)
// ---------------------------------------------------------------------------

const ReqId = z.string().min(1).max(64);
const SessionId = z.string().min(1).max(64);
const Cols = z.number().int().min(1).max(1000);
const Rows = z.number().int().min(1).max(1000);
const FsPath = z.string().max(4096);

export const MAX_TERMINAL_INPUT_CHARS = 1_000_000;
export const MAX_FILE_CONTENT_CHARS = 2_000_000;

export const IdentifyMessageSchema = z.object({
  type: z.literal('identify'),
  client: ClientIdentitySchema,
});

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
  reqId: ReqId.optional(),
});

export const TermCreateMessageSchema = z.object({
  type: z.literal('term.create'),
  reqId: ReqId,
  cols: Cols,
  rows: Rows,
  /** Absolute path, or relative to the project directory. Defaults to the project directory. */
  cwd: z.string().max(4096).optional(),
  /** Defaults to the workspace login shell. */
  command: z.string().min(1).max(1024).optional(),
  args: z.array(z.string().max(4096)).max(64).optional(),
  title: z.string().max(200).optional(),
  /** Attach the creating client immediately (default true). */
  attach: z.boolean().optional(),
});

export const TermAttachMessageSchema = z.object({
  type: z.literal('term.attach'),
  reqId: ReqId,
  sessionId: SessionId,
});

export const TermDetachMessageSchema = z.object({
  type: z.literal('term.detach'),
  sessionId: SessionId,
});

export const TermInputMessageSchema = z.object({
  type: z.literal('term.input'),
  sessionId: SessionId,
  data: z.string().max(MAX_TERMINAL_INPUT_CHARS),
});

export const TermResizeMessageSchema = z.object({
  type: z.literal('term.resize'),
  sessionId: SessionId,
  cols: Cols,
  rows: Rows,
});

export const TermKillMessageSchema = z.object({
  type: z.literal('term.kill'),
  reqId: ReqId,
  sessionId: SessionId,
});

export const TermListMessageSchema = z.object({
  type: z.literal('term.list'),
  reqId: ReqId,
});

export const FsListMessageSchema = z.object({
  type: z.literal('fs.list'),
  reqId: ReqId,
  path: FsPath,
});

export const FsReadMessageSchema = z.object({
  type: z.literal('fs.read'),
  reqId: ReqId,
  path: FsPath,
});

export const FsWriteMessageSchema = z.object({
  type: z.literal('fs.write'),
  reqId: ReqId,
  path: FsPath,
  content: z.string().max(MAX_FILE_CONTENT_CHARS),
  /** Optimistic concurrency: reject with `conflict` if the file's current etag differs. */
  expectedEtag: z.string().max(128).optional(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  IdentifyMessageSchema,
  PingMessageSchema,
  TermCreateMessageSchema,
  TermAttachMessageSchema,
  TermDetachMessageSchema,
  TermInputMessageSchema,
  TermResizeMessageSchema,
  TermKillMessageSchema,
  TermListMessageSchema,
  FsListMessageSchema,
  FsReadMessageSchema,
  FsWriteMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageOf<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

export type ParseClientMessageResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

export function parseClientMessage(raw: string): ParseClientMessageResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const result = ClientMessageSchema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: detail };
  }
  return { ok: true, message: result.data };
}

// ---------------------------------------------------------------------------
// Agent -> client messages
// ---------------------------------------------------------------------------

export type AgentMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      agentVersion: string;
      workspaceId: string;
      projectDir: string;
      /** The identity the agent recorded for this connection. */
      you: ClientIdentity;
      sessions: TerminalSessionInfo[];
      clients: PresenceClient[];
    }
  | { type: 'pong'; reqId?: string }
  | { type: 'error'; reqId?: string; code: ErrorCode; message: string }
  | { type: 'term.created'; reqId: string; session: TerminalSessionInfo; attached: boolean }
  | { type: 'term.attached'; reqId: string; session: TerminalSessionInfo; scrollback: string }
  | { type: 'term.listed'; reqId: string; sessions: TerminalSessionInfo[] }
  | { type: 'term.killed'; reqId: string; sessionId: string }
  /** Broadcast to every client when any client opens a terminal. */
  | { type: 'term.opened'; session: TerminalSessionInfo }
  /** Sent only to clients attached to the session. */
  | { type: 'term.output'; sessionId: string; data: string }
  | { type: 'term.resized'; sessionId: string; cols: number; rows: number }
  /** Broadcast to every client; the session no longer exists afterwards. */
  | { type: 'term.exit'; sessionId: string; exitCode: number | null; signal: number | null }
  /** Broadcast whenever the set of clients or their attachments changes. */
  | { type: 'presence'; clients: PresenceClient[] }
  | { type: 'fs.listed'; reqId: string; path: string; entries: FsEntry[] }
  | {
      type: 'fs.content';
      reqId: string;
      path: string;
      content: string;
      etag: string;
      size: number;
      mtimeMs: number;
    }
  | { type: 'fs.written'; reqId: string; path: string; etag: string; size: number; mtimeMs: number };

export type AgentMessageOf<T extends AgentMessage['type']> = Extract<AgentMessage, { type: T }>;

/** WebSocket close codes used by the agent and orchestrator (4xxx = application defined). */
export const WS_CLOSE = {
  /** Connection was not authenticated or did not identify in time. */
  UNAUTHORIZED: 4401,
  /** First frame was not `identify`, or the payload was invalid. */
  PROTOCOL_ERROR: 4400,
  /** The workspace runtime is not running / reachable. */
  UPSTREAM_UNAVAILABLE: 4503,
  /** Agent is shutting down. */
  SHUTTING_DOWN: 4500,
} as const;
