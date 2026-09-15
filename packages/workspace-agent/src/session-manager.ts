import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { TerminalCreator, TerminalSessionInfo } from '@notea/protocol';
import { AgentError, errorMessage } from './errors';
import type { PtyFactory, PtyProcess } from './pty';
import { ScrollbackBuffer } from './scrollback';

export interface SessionManagerOptions {
  spawn: PtyFactory;
  defaultCwd: string;
  defaultCommand: string;
  defaultArgs: string[];
  env: Record<string, string>;
  maxSessions: number;
  scrollbackBytes: number;
  /** Grace period between SIGHUP and SIGKILL when killing a session. */
  killGraceMs?: number;
  idGenerator?: () => string;
  now?: () => Date;
}

export interface CreateSessionInput {
  cols: number;
  rows: number;
  cwd?: string;
  command?: string;
  args?: string[];
  title?: string;
  createdBy: TerminalCreator | null;
}

export interface SessionEvents {
  opened: [session: TerminalSessionInfo];
  output: [sessionId: string, data: string];
  resized: [sessionId: string, cols: number, rows: number];
  exit: [sessionId: string, exitCode: number | null, signal: number | null];
  attached: [sessionId: string, clientId: string];
  detached: [sessionId: string, clientId: string];
}

interface TerminalSession {
  id: string;
  title: string;
  cols: number;
  rows: number;
  cwd: string;
  command: string;
  args: string[];
  createdAt: string;
  createdBy: TerminalCreator | null;
  pty: PtyProcess;
  scrollback: ScrollbackBuffer;
  attached: Set<string>;
  exited: boolean;
  killTimer: NodeJS.Timeout | null;
}

/**
 * Owns every PTY session in a workspace. Sessions outlive client connections:
 * a browser can disconnect and re-attach later, and several clients (humans or
 * agents) can be attached to the same session at once.
 */
export class SessionManager extends EventEmitter<SessionEvents> {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly opts: SessionManagerOptions) {
    super();
  }

  create(input: CreateSessionInput): TerminalSessionInfo {
    if (this.sessions.size >= this.opts.maxSessions) {
      throw new AgentError(
        'limit_exceeded',
        `at most ${this.opts.maxSessions} terminal sessions per workspace`,
      );
    }
    const id = (this.opts.idGenerator ?? randomUUID)();
    const command = input.command ?? this.opts.defaultCommand;
    const args = input.args ?? (input.command ? [] : this.opts.defaultArgs);
    const cwd = input.cwd ?? this.opts.defaultCwd;

    let pty: PtyProcess;
    try {
      pty = this.opts.spawn({
        command,
        args,
        cwd,
        env: this.opts.env,
        cols: input.cols,
        rows: input.rows,
      });
    } catch (err) {
      throw new AgentError('bad_request', `failed to start terminal: ${errorMessage(err)}`);
    }

    const session: TerminalSession = {
      id,
      title: input.title ?? command,
      cols: input.cols,
      rows: input.rows,
      cwd,
      command,
      args,
      createdAt: (this.opts.now ?? (() => new Date()))().toISOString(),
      createdBy: input.createdBy,
      pty,
      scrollback: new ScrollbackBuffer(this.opts.scrollbackBytes),
      attached: new Set(),
      exited: false,
      killTimer: null,
    };
    this.sessions.set(id, session);

    pty.onData((data) => {
      session.scrollback.append(data);
      this.emit('output', id, data);
    });
    pty.onExit(({ exitCode, signal }) => {
      if (session.exited) return;
      session.exited = true;
      if (session.killTimer) clearTimeout(session.killTimer);
      this.sessions.delete(id);
      this.emit('exit', id, exitCode ?? null, signal ?? null);
    });

    const info = this.toInfo(session);
    this.emit('opened', info);
    return info;
  }

  attach(sessionId: string, clientId: string): { session: TerminalSessionInfo; scrollback: string } {
    const session = this.mustGet(sessionId);
    session.attached.add(clientId);
    this.emit('attached', sessionId, clientId);
    return { session: this.toInfo(session), scrollback: session.scrollback.snapshot() };
  }

  detach(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.attached.delete(clientId)) {
      this.emit('detached', sessionId, clientId);
    }
  }

  /** Detaches a client from every session (on disconnect). Returns the affected session ids. */
  detachAll(clientId: string): string[] {
    const affected: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.attached.delete(clientId)) {
        affected.push(session.id);
        this.emit('detached', session.id, clientId);
      }
    }
    return affected;
  }

  attachedClients(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.attached] : [];
  }

  input(sessionId: string, data: string): void {
    this.mustGet(sessionId).pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.mustGet(sessionId);
    if (session.cols === cols && session.rows === rows) return;
    session.cols = cols;
    session.rows = rows;
    session.pty.resize(cols, rows);
    this.emit('resized', sessionId, cols, rows);
  }

  /** Sends SIGHUP, escalating to SIGKILL after the grace period if the process lingers. */
  kill(sessionId: string): void {
    const session = this.mustGet(sessionId);
    session.pty.kill();
    if (session.exited || session.killTimer) return;
    const grace = this.opts.killGraceMs ?? 5000;
    session.killTimer = setTimeout(() => {
      if (!session.exited) session.pty.kill('SIGKILL');
    }, grace);
    session.killTimer.unref();
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((s) => this.toInfo(s));
  }

  get(sessionId: string): TerminalSessionInfo | null {
    const session = this.sessions.get(sessionId);
    return session ? this.toInfo(session) : null;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Kills every session. Used on agent shutdown. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.killTimer) clearTimeout(session.killTimer);
      try {
        session.pty.kill('SIGKILL');
      } catch {
        // best effort
      }
    }
    this.sessions.clear();
  }

  private mustGet(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AgentError('not_found', `terminal session ${sessionId} not found`);
    return session;
  }

  private toInfo(session: TerminalSession): TerminalSessionInfo {
    return {
      id: session.id,
      title: session.title,
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      command: session.command,
      args: [...session.args],
      createdAt: session.createdAt,
      createdBy: session.createdBy,
      pid: session.pty.pid,
      attachedClientIds: [...session.attached],
    };
  }
}
