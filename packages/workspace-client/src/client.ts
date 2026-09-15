import type { AgentMessage, AgentMessageOf, ClientMessage, ClientMessageOf, ErrorCode } from '@notea/protocol';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WorkspaceClientOptions {
  /**
   * Full WebSocket URL including the connect token, or a function producing one.
   * Use a function when tokens are short-lived: it is called on every (re)connect.
   */
  url: string | (() => Promise<string>);
  /** WebSocket constructor; defaults to the global one (browsers and Node >= 22). */
  WebSocketImpl?: typeof WebSocket;
  /** Reconnect automatically after an unexpected close (default true). */
  reconnect?: boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
}

export class WorkspaceRequestError extends Error {
  constructor(
    public readonly code: ErrorCode | 'timeout' | 'disconnected',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRequestError';
  }
}

/** Reply type produced by each request type (matched at runtime by `reqId`). */
type ResponseTypeOf<T extends ClientMessage['type']> = T extends 'term.create'
  ? 'term.created'
  : T extends 'term.attach'
    ? 'term.attached'
    : T extends 'term.kill'
      ? 'term.killed'
      : T extends 'term.list'
        ? 'term.listed'
        : T extends 'fs.list'
          ? 'fs.listed'
          : T extends 'fs.read'
            ? 'fs.content'
            : T extends 'fs.write'
              ? 'fs.written'
              : T extends 'ping'
                ? 'pong'
                : T extends 'exec.start'
                  ? 'exec.started'
                  : T extends 'exec.kill'
                    ? 'exec.killed'
                    : never;

export interface ExecResult {
  execId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

type RequestMessage = Extract<ClientMessage, { reqId: string }> | ClientMessageOf<'ping'>;
type RequestInput<T extends RequestMessage['type']> = Omit<ClientMessageOf<T>, 'reqId'>;

interface PendingRequest {
  resolve: (message: AgentMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Listener<T> = (event: T) => void;

/**
 * Small, dependency-free client for protocol v1. It owns the socket lifecycle
 * (reconnect with backoff), correlates requests with replies, and exposes typed
 * events. Session re-attachment after a reconnect is a UI decision: listen for
 * `hello` and re-attach the sessions you care about.
 */
export class WorkspaceClient {
  private socket: WebSocket | null = null;
  private stateValue: ConnectionState = 'connecting';
  private closedByUser = false;
  private attempts = 0;
  private reqCounter = 0;
  private connectGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<Listener<AgentMessage>>>();
  private readonly anyListeners = new Set<Listener<AgentMessage>>();
  private readonly stateListeners = new Set<Listener<{ state: ConnectionState; code?: number; reason?: string }>>();
  private helloValue: AgentMessageOf<'hello'> | null = null;

  constructor(private readonly opts: WorkspaceClientOptions) {
    this.connect();
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  /** The most recent `hello` (null until the first one arrives). */
  get hello(): AgentMessageOf<'hello'> | null {
    return this.helloValue;
  }

  on<T extends AgentMessage['type']>(type: T, listener: Listener<AgentMessageOf<T>>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const wrapped = listener as Listener<AgentMessage>;
    set.add(wrapped);
    return () => set?.delete(wrapped);
  }

  onAny(listener: Listener<AgentMessage>): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  onStateChange(listener: Listener<{ state: ConnectionState; code?: number; reason?: string }>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Resolves once the socket is open (immediately if it already is). */
  waitForOpen(timeoutMs = 10_000): Promise<void> {
    if (this.stateValue === 'open') return Promise.resolve();
    if (this.stateValue === 'closed') return Promise.reject(new WorkspaceRequestError('disconnected', 'client is closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new WorkspaceRequestError('timeout', 'timed out waiting for connection'));
      }, timeoutMs);
      const off = this.onStateChange(({ state }) => {
        if (state === 'open') {
          clearTimeout(timer);
          off();
          resolve();
        } else if (state === 'closed') {
          clearTimeout(timer);
          off();
          reject(new WorkspaceRequestError('disconnected', 'client is closed'));
        }
      });
    });
  }

  /** Resolves with the next `hello` (or the current one if already received on this connection). */
  waitForHello(timeoutMs = 10_000): Promise<AgentMessageOf<'hello'>> {
    if (this.helloValue && this.stateValue === 'open') return Promise.resolve(this.helloValue);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new WorkspaceRequestError('timeout', 'timed out waiting for hello'));
      }, timeoutMs);
      const off = this.on('hello', (hello) => {
        clearTimeout(timer);
        off();
        resolve(hello);
      });
    });
  }

  /** Fire-and-forget message. Throws if the socket is not open. */
  send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new WorkspaceRequestError('disconnected', 'socket is not open');
    }
    this.socket.send(JSON.stringify(message));
  }

  /** Sends a request and resolves with its reply, or rejects with the agent's error. */
  request<T extends RequestMessage['type']>(input: RequestInput<T>): Promise<AgentMessageOf<ResponseTypeOf<T>>> {
    const reqId = `r${++this.reqCounter}`;
    const message = { ...input, reqId } as ClientMessage;
    return new Promise((resolve, reject) => {
      try {
        this.send(message);
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new WorkspaceRequestError('timeout', `request ${input.type} timed out`));
      }, this.opts.requestTimeoutMs ?? 15_000);
      this.pending.set(reqId, {
        resolve: (reply) => resolve(reply as AgentMessageOf<ResponseTypeOf<T>>),
        reject,
        timer,
      });
    });
  }

  // Convenience wrappers -----------------------------------------------------

  createTerminal(input: Omit<RequestInput<'term.create'>, 'type'>) {
    return this.request<'term.create'>({ type: 'term.create', ...input });
  }

  attachTerminal(sessionId: string) {
    return this.request<'term.attach'>({ type: 'term.attach', sessionId });
  }

  detachTerminal(sessionId: string): void {
    this.send({ type: 'term.detach', sessionId });
  }

  input(sessionId: string, data: string): void {
    this.send({ type: 'term.input', sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'term.resize', sessionId, cols, rows });
  }

  killTerminal(sessionId: string) {
    return this.request<'term.kill'>({ type: 'term.kill', sessionId });
  }

  listTerminals() {
    return this.request<'term.list'>({ type: 'term.list' });
  }

  listFiles(path: string) {
    return this.request<'fs.list'>({ type: 'fs.list', path });
  }

  readFile(path: string) {
    return this.request<'fs.read'>({ type: 'fs.read', path });
  }

  writeFile(path: string, content: string, expectedEtag?: string) {
    return this.request<'fs.write'>({ type: 'fs.write', path, content, expectedEtag });
  }

  ping() {
    return this.request<'ping'>({ type: 'ping' });
  }

  startExec(input: Omit<RequestInput<'exec.start'>, 'type'>) {
    return this.request<'exec.start'>({ type: 'exec.start', ...input });
  }

  execStdin(execId: string, data: string, end = false): void {
    this.send({ type: 'exec.stdin', execId, data, end });
  }

  killExec(execId: string) {
    return this.request<'exec.kill'>({ type: 'exec.kill', execId });
  }

  /**
   * Starts a process and resolves when it exits, with its collected output. Suitable
   * for git and check commands; use `onOutput` to stream progress.
   */
  async runExec(
    input: Omit<RequestInput<'exec.start'>, 'type'> & { stdin?: string },
    onOutput?: (stream: 'stdout' | 'stderr', data: string) => void,
  ): Promise<ExecResult> {
    const { stdin, ...startInput } = input;
    let stdout = '';
    let stderr = '';
    let execId: string | null = null;
    const buffered: Array<AgentMessageOf<'exec.output'> | AgentMessageOf<'exec.exit'>> = [];
    let settle: ((result: ExecResult) => void) | null = null;

    const handle = (message: AgentMessageOf<'exec.output'> | AgentMessageOf<'exec.exit'>) => {
      if (message.type === 'exec.output') {
        if (message.stream === 'stdout') stdout += message.data;
        else stderr += message.data;
        onOutput?.(message.stream, message.data);
      } else {
        settle?.({ execId: message.execId, exitCode: message.exitCode, signal: message.signal, timedOut: message.timedOut, stdout, stderr });
      }
    };
    // Output can arrive before `exec.started` is processed; buffer until the id is known.
    const offOutput = this.on('exec.output', (message) => {
      if (execId === null) buffered.push(message);
      else if (message.execId === execId) handle(message);
    });
    const offExit = this.on('exec.exit', (message) => {
      if (execId === null) buffered.push(message);
      else if (message.execId === execId) handle(message);
    });
    try {
      const done = new Promise<ExecResult>((resolve) => {
        settle = resolve;
      });
      const started = await this.startExec(startInput);
      execId = started.execId;
      for (const message of buffered) if (message.execId === execId) handle(message);
      buffered.length = 0;
      if (stdin !== undefined) this.execStdin(execId, stdin, true);
      return await done;
    } finally {
      offOutput();
      offExit();
    }
  }

  /** Closes the connection permanently (no reconnect). */
  close(): void {
    this.closedByUser = true;
    this.connectGeneration += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.rejectPending(new WorkspaceRequestError('disconnected', 'client closed'));
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close(1000, 'client closed');
    this.setState('closed');
  }

  // Internals -----------------------------------------------------------------

  private connect(): void {
    if (this.closedByUser) return;
    const generation = ++this.connectGeneration;
    const resolveUrl = typeof this.opts.url === 'function' ? this.opts.url() : Promise.resolve(this.opts.url);
    resolveUrl.then(
      (url) => {
        if (this.closedByUser || generation !== this.connectGeneration) return;
        this.openSocket(url);
      },
      () => {
        if (this.closedByUser || generation !== this.connectGeneration) return;
        if (this.opts.reconnect ?? true) {
          this.setState('reconnecting');
          this.scheduleReconnect();
        } else {
          this.closedByUser = true;
          this.setState('closed');
        }
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
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      let message: AgentMessage;
      try {
        message = JSON.parse(raw) as AgentMessage;
      } catch {
        return;
      }
      this.dispatch(message);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.helloValue = null;
      this.rejectPending(new WorkspaceRequestError('disconnected', `connection closed (${event.code})`));
      // With a URL resolver a rejected token can be replaced, so keep retrying; with a
      // static URL an authentication failure is permanent.
      const canRefreshToken = typeof this.opts.url === 'function';
      const shouldReconnect =
        !this.closedByUser && (this.opts.reconnect ?? true) && (canRefreshToken || !isPermanentClose(event.code));
      if (shouldReconnect) {
        this.setState('reconnecting', event.code, event.reason);
        this.scheduleReconnect();
      } else {
        this.closedByUser = true;
        this.setState('closed', event.code, event.reason);
      }
    });
    socket.addEventListener('error', () => {
      // The subsequent `close` event carries the outcome; nothing to do here.
    });
  }

  private scheduleReconnect(): void {
    const min = this.opts.minBackoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 10_000;
    const delay = Math.min(max, min * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private dispatch(message: AgentMessage): void {
    if (message.type === 'hello') this.helloValue = message;
    if ('reqId' in message && message.reqId) {
      const pending = this.pending.get(message.reqId);
      if (pending) {
        this.pending.delete(message.reqId);
        clearTimeout(pending.timer);
        if (message.type === 'error') pending.reject(new WorkspaceRequestError(message.code, message.message));
        else pending.resolve(message);
        return;
      }
    }
    for (const listener of this.listeners.get(message.type) ?? []) listener(message);
    for (const listener of this.anyListeners) listener(message);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setState(state: ConnectionState, code?: number, reason?: string): void {
    this.stateValue = state;
    for (const listener of this.stateListeners) listener({ state, code, reason });
  }
}

/** Close codes after which reconnecting cannot succeed without a new token. */
function isPermanentClose(code: number): boolean {
  return code === 4401 || code === 4400;
}
