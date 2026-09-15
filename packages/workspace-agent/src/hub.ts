import type { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  WS_CLOSE,
  parseClientMessage,
  type AgentMessage,
  type ClientIdentity,
  type ClientMessage,
  type PresenceClient,
  type WorkspaceRole,
} from '@notea/protocol';
import { AgentError, errorMessage } from './errors';
import type { FsService } from './fs-service';
import type { Logger } from './logger';
import type { ProcessManager } from './process-manager';
import type { SessionManager } from './session-manager';

export interface HubOptions {
  sessions: SessionManager;
  processes: ProcessManager;
  fs: FsService;
  workspaceId: string;
  projectDir: string;
  agentVersion: string;
  log: Logger;
  /** How long a fresh connection may stay unidentified. */
  identifyTimeoutMs?: number;
}

interface ConnectedClient {
  id: string;
  socket: WebSocket;
  identity: ClientIdentity | null;
  identifyTimer: NodeJS.Timeout | null;
}

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, editor: 1, owner: 2 };

/**
 * Routes messages between connected clients and the session manager / file service.
 * One instance per agent process (i.e. per workspace container).
 */
export class AgentHub {
  private readonly clients = new Map<string, ConnectedClient>();
  private pendingCounter = 0;

  constructor(private readonly opts: HubOptions) {
    const { sessions } = opts;
    sessions.on('opened', (session) => this.broadcast({ type: 'term.opened', session }));
    sessions.on('output', (sessionId, data) => {
      for (const clientId of sessions.attachedClients(sessionId)) {
        const client = this.clients.get(clientId);
        if (client) this.send(client, { type: 'term.output', sessionId, data });
      }
    });
    sessions.on('resized', (sessionId, cols, rows) => {
      for (const clientId of sessions.attachedClients(sessionId)) {
        const client = this.clients.get(clientId);
        if (client) this.send(client, { type: 'term.resized', sessionId, cols, rows });
      }
    });
    sessions.on('exit', (sessionId, exitCode, signal) => {
      this.broadcast({ type: 'term.exit', sessionId, exitCode, signal });
      this.broadcastPresence();
    });
    sessions.on('attached', () => this.broadcastPresence());
    sessions.on('detached', () => this.broadcastPresence());

    const { processes } = opts;
    processes.on('output', (execId, ownerId, stream, data) => {
      const owner = this.clients.get(ownerId);
      if (owner) this.send(owner, { type: 'exec.output', execId, stream, data });
    });
    processes.on('exit', (execId, ownerId, exitCode, signal, timedOut) => {
      const owner = this.clients.get(ownerId);
      if (owner) this.send(owner, { type: 'exec.exit', execId, exitCode, signal, timedOut });
    });
  }

  /** Registers a freshly authenticated socket. The first frame must be `identify`. */
  addSocket(socket: WebSocket): void {
    const pendingId = `pending-${++this.pendingCounter}`;
    const client: ConnectedClient = { id: pendingId, socket, identity: null, identifyTimer: null };
    client.identifyTimer = setTimeout(() => {
      if (!client.identity) {
        this.opts.log.warn('client did not identify in time', { pendingId });
        socket.close(WS_CLOSE.UNAUTHORIZED, 'identify timeout');
      }
    }, this.opts.identifyTimeoutMs ?? 5000);
    client.identifyTimer.unref();

    socket.on('message', (raw) => {
      this.handleRaw(client, raw.toString());
    });
    socket.on('close', () => this.removeClient(client));
    socket.on('error', (err) => {
      this.opts.log.warn('client socket error', { clientId: client.id, error: err.message });
    });
  }

  presence(): PresenceClient[] {
    const list: PresenceClient[] = [];
    for (const client of this.clients.values()) {
      if (!client.identity) continue;
      list.push({
        id: client.id,
        userId: client.identity.userId,
        name: client.identity.name,
        kind: client.identity.kind,
        role: client.identity.role,
        attachedSessionIds: this.opts.sessions
          .list()
          .filter((s) => s.attachedClientIds.includes(client.id))
          .map((s) => s.id),
      });
    }
    return list;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Closes every connection (agent shutdown). Sessions are handled by the caller. */
  closeAll(): void {
    for (const client of this.clients.values()) {
      if (client.identifyTimer) clearTimeout(client.identifyTimer);
      client.socket.close(WS_CLOSE.SHUTTING_DOWN, 'agent shutting down');
    }
    this.clients.clear();
  }

  private handleRaw(client: ConnectedClient, raw: string): void {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      if (!client.identity) {
        client.socket.close(WS_CLOSE.PROTOCOL_ERROR, 'invalid identify frame');
        return;
      }
      this.send(client, { type: 'error', code: 'bad_request', message: parsed.error });
      return;
    }
    const message = parsed.message;

    if (!client.identity) {
      if (message.type !== 'identify') {
        client.socket.close(WS_CLOSE.PROTOCOL_ERROR, 'first frame must be identify');
        return;
      }
      this.identify(client, message.client);
      return;
    }

    try {
      this.dispatch(client, client.identity, message);
    } catch (err) {
      const reqId = 'reqId' in message ? message.reqId : undefined;
      if (err instanceof AgentError) {
        this.send(client, { type: 'error', reqId, code: err.code, message: err.message });
      } else {
        this.opts.log.error('unhandled error while dispatching message', {
          clientId: client.id,
          messageType: message.type,
          error: errorMessage(err),
        });
        this.send(client, { type: 'error', reqId, code: 'internal', message: 'internal error' });
      }
    }
  }

  private identify(client: ConnectedClient, identity: ClientIdentity): void {
    if (client.identifyTimer) {
      clearTimeout(client.identifyTimer);
      client.identifyTimer = null;
    }
    // Connection ids come from the orchestrator and are expected to be unique; keep
    // the invariant locally anyway so attachments never alias.
    let id = identity.id;
    while (this.clients.has(id)) id = `${id}-`;
    client.id = id;
    client.identity = { ...identity, id };
    this.clients.set(id, client);
    this.opts.log.info('client identified', {
      clientId: id,
      userId: identity.userId,
      kind: identity.kind,
      role: identity.role,
    });
    this.send(client, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      agentVersion: this.opts.agentVersion,
      workspaceId: this.opts.workspaceId,
      projectDir: this.opts.projectDir,
      you: client.identity,
      sessions: this.opts.sessions.list(),
      clients: this.presence(),
    });
    this.broadcastPresence();
  }

  private dispatch(client: ConnectedClient, identity: ClientIdentity, message: ClientMessage): void {
    const { sessions, fs } = this.opts;
    switch (message.type) {
      case 'identify':
        // Only the first frame of a connection may identify; later ones are ignored.
        return;
      case 'ping':
        this.send(client, { type: 'pong', reqId: message.reqId });
        return;
      case 'term.create': {
        requireRole(identity, 'editor');
        const session = sessions.create({
          cols: message.cols,
          rows: message.rows,
          cwd: message.cwd,
          command: message.command,
          args: message.args,
          title: message.title,
          createdBy: { userId: identity.userId, name: identity.name, kind: identity.kind },
          env: message.env,
        });
        const attach = message.attach !== false;
        if (attach) sessions.attach(session.id, client.id);
        this.send(client, {
          type: 'term.created',
          reqId: message.reqId,
          session: sessions.get(session.id) ?? session,
          attached: attach,
        });
        return;
      }
      case 'term.attach': {
        const { session, scrollback } = sessions.attach(message.sessionId, client.id);
        this.send(client, { type: 'term.attached', reqId: message.reqId, session, scrollback });
        return;
      }
      case 'term.detach':
        sessions.detach(message.sessionId, client.id);
        return;
      case 'term.input':
        requireRole(identity, 'editor');
        sessions.input(message.sessionId, message.data);
        return;
      case 'term.resize':
        requireRole(identity, 'editor');
        sessions.resize(message.sessionId, message.cols, message.rows);
        return;
      case 'term.kill':
        requireRole(identity, 'editor');
        sessions.kill(message.sessionId);
        this.send(client, { type: 'term.killed', reqId: message.reqId, sessionId: message.sessionId });
        return;
      case 'term.list':
        this.send(client, { type: 'term.listed', reqId: message.reqId, sessions: sessions.list() });
        return;
      case 'fs.list':
        void this.respondAsync(client, message.reqId, async () => {
          const result = await fs.list(message.path);
          return { type: 'fs.listed', reqId: message.reqId, ...result };
        });
        return;
      case 'fs.read':
        void this.respondAsync(client, message.reqId, async () => {
          const result = await fs.read(message.path);
          return { type: 'fs.content', reqId: message.reqId, ...result };
        });
        return;
      case 'fs.write':
        requireRole(identity, 'editor');
        void this.respondAsync(client, message.reqId, async () => {
          const result = await fs.write(message.path, message.content, message.expectedEtag);
          this.broadcast({
            type: 'fs.changed',
            path: result.path,
            kind: 'write',
            etag: result.etag,
            by: { userId: identity.userId, name: identity.name, kind: identity.kind },
          });
          return { type: 'fs.written', reqId: message.reqId, ...result };
        });
        return;
      case 'exec.start': {
        requireRole(identity, 'editor');
        void this.respondAsync(client, message.reqId, async () => {
          const cwd = message.cwd ? await this.opts.fs.resolveAnyDir(message.cwd) : undefined;
          const { execId, pid } = this.opts.processes.start({
            ownerId: client.id,
            command: message.command,
            args: message.args,
            shell: message.shell,
            cwd,
            env: message.env,
            timeoutMs: message.timeoutMs,
          });
          return { type: 'exec.started', reqId: message.reqId, execId, pid };
        });
        return;
      }
      case 'exec.stdin':
        requireRole(identity, 'editor');
        this.opts.processes.writeStdin(message.execId, client.id, message.data, message.end === true);
        return;
      case 'exec.kill':
        requireRole(identity, 'editor');
        this.opts.processes.kill(message.execId, client.id);
        this.send(client, { type: 'exec.killed', reqId: message.reqId, execId: message.execId });
        return;
      default: {
        const exhaustive: never = message;
        throw new AgentError('bad_request', `unsupported message ${String(exhaustive)}`);
      }
    }
  }

  private async respondAsync(
    client: ConnectedClient,
    reqId: string,
    work: () => Promise<AgentMessage>,
  ): Promise<void> {
    try {
      this.send(client, await work());
    } catch (err) {
      if (err instanceof AgentError) {
        this.send(client, { type: 'error', reqId, code: err.code, message: err.message });
      } else {
        this.opts.log.error('unhandled async error', { clientId: client.id, error: errorMessage(err) });
        this.send(client, { type: 'error', reqId, code: 'internal', message: 'internal error' });
      }
    }
  }

  private removeClient(client: ConnectedClient): void {
    if (client.identifyTimer) clearTimeout(client.identifyTimer);
    if (!client.identity) return;
    this.clients.delete(client.id);
    this.opts.sessions.detachAll(client.id);
    this.opts.processes.killOwnedBy(client.id);
    this.opts.log.info('client disconnected', { clientId: client.id });
    this.broadcastPresence();
  }

  private send(client: ConnectedClient, message: AgentMessage): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    client.socket.send(JSON.stringify(message));
  }

  private broadcast(message: AgentMessage): void {
    const encoded = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.identity && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(encoded);
      }
    }
  }

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence', clients: this.presence() });
  }
}

function requireRole(identity: ClientIdentity, minimum: WorkspaceRole): void {
  if (ROLE_RANK[identity.role] < ROLE_RANK[minimum]) {
    throw new AgentError('unauthorized', `this action requires the ${minimum} role`);
  }
}
