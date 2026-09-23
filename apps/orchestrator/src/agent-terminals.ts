import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import type { AgentTerminalInfo, AgentTerminalServerMessage } from '@notea/protocol';
import type { AgentTerminalIdentity, AgentTerminalSize, AgentTtyHandle, AgentTtyRunner } from './docker/agent-terminal';

// xterm ships CommonJS bundles without named ESM exports.
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

type Screen = InstanceType<typeof HeadlessTerminal>;
type Serializer = InstanceType<typeof SerializeAddon>;

export type AgentTerminalListener = (message: AgentTerminalServerMessage) => void;

export interface AttachedTerminal {
  terminal: AgentTerminalInfo;
  /** Reproduces the current screen and scrollback when written into an empty terminal. */
  screen: string;
  /** Addresses of the hyperlinks printed in this run, which `screen` cannot carry. */
  links: string[];
  /** Starts delivering what happened since the snapshot. Call after sending it. */
  resume(): void;
  detach(): void;
}

export interface AgentTerminalsOptions {
  /** Lines of scrollback kept for people who open a terminal later (default 5000). */
  scrollbackLines?: number;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  now?: () => Date;
}

interface Entry {
  workspaceId: string;
  uid: number;
  info: AgentTerminalInfo;
  /** A headless terminal fed with everything the process prints: the source of snapshots. */
  screen: Screen;
  serializer: Serializer;
  listeners: Set<AgentTerminalListener>;
  /** Hyperlink (OSC 8) addresses printed in this run, oldest first, without repeats. */
  links: string[];
  handle: AgentTtyHandle | null;
  containerId: string | null;
  /** Increments with every start, so a late event from an earlier run is ignored. */
  run: number;
  stopRequested: boolean;
}

const DEFAULT_SIZE: AgentTerminalSize = { cols: 100, rows: 30 };
/** Hyperlinks remembered per terminal for viewers who arrive later. */
const MAX_LINKS = 50;
const MAX_LINK_LENGTH = 4096;

/**
 * Members' own Claude terminals (D-045), one per member per workspace, kept here in
 * the orchestrator because the Docker daemon owns their ptys (see
 * docker/agent-terminal.ts).
 *
 * A terminal outlives its viewers: Claude keeps working when every tab is closed,
 * and whoever opens it later gets the current screen. That screen is kept by a
 * headless xterm fed with the same output the browsers get, rather than as a byte
 * log: a TUI redraws itself many times a second, and a replay of the last few
 * hundred kilobytes of redraws would lose everything that scrolled past.
 *
 * Nothing here checks who may do what; the WebSocket route does, from the token.
 */
export class AgentTerminals {
  private readonly entries = new Map<string, Entry>();
  private closing = false;

  constructor(
    private readonly runner: AgentTtyRunner,
    private readonly opts: AgentTerminalsOptions = {},
  ) {}

  /** Snapshot plus live updates of a member's terminal. Never starts it. */
  async attach(workspaceId: string, uid: number, listener: AgentTerminalListener): Promise<AttachedTerminal> {
    const entry = this.entry(workspaceId, uid);
    // Listen before taking the snapshot. The parser works in order, so output that
    // arrives while the snapshot is taken is not in it but is in `pending`: every
    // byte reaches the new viewer exactly once.
    let live = false;
    const pending: AgentTerminalServerMessage[] = [];
    const wrapped: AgentTerminalListener = (message) => {
      if (live) listener(message);
      else pending.push(message);
    };
    entry.listeners.add(wrapped);
    // Screen, state and links read together, once the parser has caught up.
    const snapshot = await new Promise<{ screen: string; terminal: AgentTerminalInfo; links: string[] }>((resolve) =>
      entry.screen.write('', () => resolve({ screen: entry.serializer.serialize(), terminal: { ...entry.info }, links: [...entry.links] })),
    );
    return {
      ...snapshot,
      resume: () => {
        if (live) return;
        live = true;
        for (const message of pending.splice(0)) listener(message);
      },
      detach: () => {
        entry.listeners.delete(wrapped);
        this.collect(entry);
      },
    };
  }

  info(workspaceId: string, uid: number): AgentTerminalInfo | null {
    const entry = this.entries.get(key(workspaceId, uid));
    return entry ? { ...entry.info } : null;
  }

  /** Starts the member's terminal unless it is already starting or running. */
  async start(workspaceId: string, containerId: string, identity: AgentTerminalIdentity, size: AgentTerminalSize): Promise<void> {
    if (this.closing) return;
    const entry = this.entry(workspaceId, identity.uid);
    if (entry.info.status === 'starting' || entry.info.status === 'running') return;
    const run = ++entry.run;
    entry.stopRequested = false;
    entry.containerId = containerId;
    // RIS through the parser rather than reset(), which would act before output of the
    // last run that is still queued there.
    entry.screen.write('\x1bc', () => {
      entry.links.length = 0;
    });
    entry.screen.resize(size.cols, size.rows);
    this.broadcast(entry, { type: 'clear' });
    this.setInfo(entry, {
      status: 'starting',
      cols: size.cols,
      rows: size.rows,
      exitCode: null,
      startedAt: (this.opts.now ?? (() => new Date()))().toISOString(),
      error: null,
    });

    let handle: AgentTtyHandle;
    try {
      await this.runner.prepare(containerId).catch((err: unknown) => {
        // Claude still starts; files `dev` created may stay read-only for it.
        this.opts.log?.warn({ workspaceId, uid: identity.uid, err: message(err) }, 'could not share the project with member uids');
      });
      // One an earlier orchestrator left behind would otherwise run on, unwatched.
      await this.runner.stop(containerId, identity.uid);
      handle = await this.runner.start(containerId, identity, size);
    } catch (err) {
      if (entry.run !== run) return;
      this.setInfo(entry, { ...entry.info, status: 'exited', error: `Claude could not start: ${message(err)}` });
      this.opts.log?.warn({ workspaceId, uid: identity.uid, err: message(err) }, 'agent terminal failed to start');
      this.collect(entry);
      return;
    }

    entry.handle = handle;
    this.setInfo(entry, { ...entry.info, status: 'running' });
    this.opts.log?.info({ workspaceId, uid: identity.uid }, 'agent terminal started');

    const decoder = new StringDecoder('utf8');
    const emit = (text: string) => {
      if (!text) return;
      entry.screen.write(text);
      this.broadcast(entry, { type: 'output', data: text });
    };
    handle.output.on('data', (chunk: Buffer | string) => emit(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
    handle.output.on('error', () => undefined);
    void handle.done.then(
      (exitCode) => this.finish(entry, run, exitCode, decoder.end()),
      () => this.finish(entry, run, null, decoder.end()),
    );

    if (entry.stopRequested || this.closing) await this.stop(workspaceId, identity.uid);
  }

  input(workspaceId: string, uid: number, data: string): void {
    const entry = this.entries.get(key(workspaceId, uid));
    if (entry?.handle && entry.info.status === 'running') entry.handle.write(data);
  }

  async resize(workspaceId: string, uid: number, size: AgentTerminalSize): Promise<void> {
    const entry = this.entries.get(key(workspaceId, uid));
    if (!entry || (entry.info.cols === size.cols && entry.info.rows === size.rows)) return;
    entry.screen.resize(size.cols, size.rows);
    this.setInfo(entry, { ...entry.info, cols: size.cols, rows: size.rows });
    if (entry.handle) await entry.handle.resize(size).catch(() => undefined);
  }

  /**
   * Ends the member's terminal. With `containerId`, also one this orchestrator does
   * not know about (a restart lost its stream): used when a member leaves.
   */
  async stop(workspaceId: string, uid: number, containerId?: string): Promise<void> {
    const entry = this.entries.get(key(workspaceId, uid));
    if (entry?.info.status === 'starting') {
      entry.stopRequested = true;
      return;
    }
    const target = entry?.info.status === 'running' ? entry.containerId : (containerId ?? null);
    if (!target) return;
    // The exec's stream ends with the process, and `finish` records the exit.
    await this.runner.stop(target, uid);
  }

  /** Stops every terminal (orchestrator shutdown). A stream cannot be re-attached, so leaving them running would orphan them. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.closing = true;
    const running = [...this.entries.values()].filter((e) => e.info.status === 'running' && e.containerId);
    await Promise.race([
      Promise.allSettled(running.map((e) => this.runner.stop(e.containerId!, e.uid))),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
    for (const entry of this.entries.values()) entry.screen.dispose();
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private finish(entry: Entry, run: number, exitCode: number | null, tail: string): void {
    if (tail) {
      entry.screen.write(tail);
      this.broadcast(entry, { type: 'output', data: tail });
    }
    if (entry.run !== run) return;
    entry.handle = null;
    this.setInfo(entry, { ...entry.info, status: 'exited', exitCode });
    this.opts.log?.info({ workspaceId: entry.workspaceId, uid: entry.uid, exitCode }, 'agent terminal exited');
    this.collect(entry);
  }

  private entry(workspaceId: string, uid: number): Entry {
    const id = key(workspaceId, uid);
    let entry = this.entries.get(id);
    if (!entry) {
      const screen = new HeadlessTerminal({
        cols: DEFAULT_SIZE.cols,
        rows: DEFAULT_SIZE.rows,
        scrollback: this.opts.scrollbackLines ?? 5000,
        allowProposedApi: true,
      });
      const serializer = new SerializeAddon();
      screen.loadAddon(serializer);
      const links: string[] = [];
      // The serializer drops OSC 8 hyperlinks, and the CLI breaks a long one (its
      // sign-in link) over several lines, so a viewer who arrives later could not
      // follow it. Remember the addresses; the browser finds them on screen again.
      screen.parser.registerOscHandler(8, (data) => {
        const uri = data.slice(data.indexOf(';') + 1);
        if (data.includes(';') && /^https?:\/\//i.test(uri) && uri.length <= MAX_LINK_LENGTH) {
          const known = links.indexOf(uri);
          if (known !== -1) links.splice(known, 1);
          links.push(uri);
          if (links.length > MAX_LINKS) links.shift();
        }
        return false;
      });
      entry = {
        workspaceId,
        uid,
        info: { status: 'idle', ...DEFAULT_SIZE, exitCode: null, startedAt: null, error: null },
        screen,
        serializer,
        listeners: new Set(),
        links,
        handle: null,
        containerId: null,
        run: 0,
        stopRequested: false,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /** Forgets a terminal nobody watches that is not running either. */
  private collect(entry: Entry): void {
    if (entry.listeners.size > 0 || entry.info.status === 'starting' || entry.info.status === 'running') return;
    const id = key(entry.workspaceId, entry.uid);
    if (this.entries.get(id) !== entry) return;
    this.entries.delete(id);
    entry.screen.dispose();
  }

  private setInfo(entry: Entry, info: AgentTerminalInfo): void {
    entry.info = info;
    this.broadcast(entry, { type: 'state', terminal: { ...info } });
  }

  private broadcast(entry: Entry, message: AgentTerminalServerMessage): void {
    for (const listener of entry.listeners) {
      try {
        listener(message);
      } catch {
        // One broken viewer must not stop the others.
      }
    }
  }
}

function key(workspaceId: string, uid: number): string {
  return `${workspaceId}:${uid}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
