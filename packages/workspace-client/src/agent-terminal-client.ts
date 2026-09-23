import type { AgentTerminalClientMessage, AgentTerminalServerMessage } from '@notea/protocol';
import type { ConnectionState } from './client';

export interface AgentTerminalClientOptions {
  /** Produces the WebSocket URL, token included. Called on every (re)connect: tokens are short-lived. */
  url: () => Promise<string>;
  /** WebSocket constructor; defaults to the global one (browsers and Node >= 22). */
  WebSocketImpl?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

type Listener<T> = (event: T) => void;
export type AgentTerminalStateEvent = { state: ConnectionState; code?: number; reason?: string };

/**
 * Client for one member's Claude terminal (`@notea/protocol` agent-terminal, D-045).
 *
 * It reconnects with backoff and a fresh URL until closed. Every connection begins
 * with a `hello` carrying the whole screen, so after a reconnect the caller redraws
 * from it and needs no bookkeeping of its own.
 */
export class AgentTerminalClient {
  private socket: WebSocket | null = null;
  private stateValue: ConnectionState = 'connecting';
  private closedByUser = false;
  private attempts = 0;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly messageListeners = new Set<Listener<AgentTerminalServerMessage>>();
  private readonly stateListeners = new Set<Listener<AgentTerminalStateEvent>>();

  constructor(private readonly opts: AgentTerminalClientOptions) {
    this.connect();
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  onMessage(listener: Listener<AgentTerminalServerMessage>): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStateChange(listener: Listener<AgentTerminalStateEvent>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Sends if connected. Returns false otherwise: keystrokes typed while disconnected are dropped, not queued. */
  send(message: AgentTerminalClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /** Closes the connection for good. */
  close(): void {
    this.closedByUser = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close(1000, 'client closed');
    this.setState('closed');
  }

  private connect(): void {
    if (this.closedByUser) return;
    const generation = ++this.generation;
    this.opts.url().then(
      (url) => {
        if (this.closedByUser || generation !== this.generation) return;
        this.openSocket(url);
      },
      () => {
        if (this.closedByUser || generation !== this.generation) return;
        this.setState('reconnecting');
        this.scheduleReconnect();
      },
    );
  }

  private openSocket(url: string): void {
    const Impl = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    if (!Impl) throw new Error('no WebSocket implementation available');
    const socket = new Impl(url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.setState('open');
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      let message: AgentTerminalServerMessage;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) as AgentTerminalServerMessage;
      } catch {
        return;
      }
      for (const listener of this.messageListeners) listener(message);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closedByUser) return;
      // Every close is worth retrying: an expired token is replaced by the next URL,
      // and a stopped workspace may be started again.
      this.setState('reconnecting', event.code, event.reason);
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // The `close` that follows carries the outcome.
    });
  }

  private scheduleReconnect(): void {
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 15_000;
    const delay = Math.min(max, min * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: ConnectionState, code?: number, reason?: string): void {
    this.stateValue = state;
    for (const listener of this.stateListeners) listener({ state, code, reason });
  }
}
