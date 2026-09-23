'use client';

import { CircleAlert, Eye, LoaderCircle, Play, Square, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentTerminalClientMessage, AgentTerminalInfo } from '@notea/protocol';
import { AgentTerminalClient, type ConnectionState } from '@notea/workspace-client';
import { firstName, type ClaudePane } from '@/lib/claude-panes';
import { findKnownLinks } from '@/lib/terminal-links';
import { Avatar } from './ui/avatar';
import { cx } from './ui/cx';
import { TERMINAL_FONT_FAMILY, TERMINAL_THEME, monoFontReady } from './xterm-theme';
import '@xterm/xterm/css/xterm.css';

async function fetchTerminalUrl(workspaceId: string, ownerId: string): Promise<string> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/agent-terminal-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerId }),
  });
  if (!response.ok) throw new Error(`terminal token request failed (${response.status})`);
  return ((await response.json()) as { url: string }).url;
}

interface PaneStatus {
  label: string;
  tone: 'live' | 'warn' | 'danger' | 'neutral' | 'muted';
  pulse?: boolean;
  hollow?: boolean;
}

function statusOf(connection: ConnectionState, terminal: AgentTerminalInfo | null, canInput: boolean): PaneStatus {
  if (!terminal || connection !== 'open') {
    return connection === 'reconnecting' ? { label: 'Reconnecting', tone: 'warn', pulse: true } : { label: 'Connecting', tone: 'muted', pulse: true };
  }
  switch (terminal.status) {
    case 'running':
      return { label: 'Running', tone: 'live' };
    case 'starting':
      return { label: 'Starting', tone: 'warn', pulse: true };
    case 'idle':
      return canInput ? { label: 'Starting', tone: 'warn', pulse: true } : { label: 'Not started', tone: 'muted', hollow: true };
    case 'exited':
      return terminal.error ? { label: 'Failed', tone: 'danger' } : { label: 'Stopped', tone: 'neutral', hollow: true };
  }
}

/**
 * One member's Claude terminal (D-045): the Claude Code CLI running as that member,
 * in the workspace's shared project, logged in with their own account. Everyone in
 * the workspace watches it live; only its member can type into it. It starts by
 * itself when its member opens the workspace, and keeps running when they leave.
 */
export function ClaudeTerminal({ workspaceId, pane }: { workspaceId: string; pane: ClaudePane }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sendRef = useRef<(message: AgentTerminalClientMessage) => void>(() => undefined);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [terminal, setTerminal] = useState<AgentTerminalInfo | null>(null);
  const [canInput, setCanInput] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const owner = firstName(pane.name);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { ClipboardAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
        import('@xterm/addon-clipboard'),
        monoFontReady(),
      ]);
      if (disposed) return;

      /** Set by the server's hello: true only in the viewer's own terminal. */
      let mayType = false;
      let info: AgentTerminalInfo | null = null;
      /** Addresses of the links on a screen restored from a snapshot, which has lost them. */
      let knownLinks: string[] = [];

      // Claude prints its sign-in page as a link; open links in a new tab, never here.
      const openLink = (_event: MouseEvent, uri: string) => {
        if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
      };
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        lineHeight: 1.2,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontWeightBold: 600,
        scrollback: 5000,
        theme: TERMINAL_THEME,
        // Until the server says this is the viewer's own terminal.
        disableStdin: true,
        linkHandler: { activate: openLink },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // Before the URL detector, so that on a restored screen the whole sign-in link
      // wins over the detector's reading of its first line as a shorter address.
      const LINK_WINDOW = 40;
      term.registerLinkProvider({
        provideLinks: (lineNumber, callback) => {
          if (knownLinks.length === 0) return callback(undefined);
          const buffer = term.buffer.active;
          const row = lineNumber - 1;
          const first = Math.max(0, row - LINK_WINDOW);
          const last = Math.min(buffer.length - 1, row + LINK_WINDOW);
          const rows: string[][] = [];
          for (let y = first; y <= last; y += 1) {
            const line = buffer.getLine(y);
            const cells: string[] = [];
            for (let x = 0; line && x < line.length; x += 1) {
              const cell = line.getCell(x);
              cells.push(!cell ? ' ' : cell.getWidth() === 0 ? '' : cell.getChars() || ' ');
            }
            rows.push(cells);
          }
          const found = findKnownLinks(rows, row - first, knownLinks);
          callback(
            found.length === 0
              ? undefined
              : found.map((link) => ({
                  range: { start: { x: link.start.x + 1, y: link.start.y + first + 1 }, end: { x: link.end.x + 1, y: link.end.y + first + 1 } },
                  text: link.uri,
                  activate: (event: MouseEvent) => openLink(event, link.uri),
                })),
          );
        },
      });
      term.loadAddon(new WebLinksAddon(openLink));
      // OSC 52, which Claude uses for "c to copy" and /copy. Only a member's own
      // terminal may write to their clipboard, and no terminal may read it: another
      // member's Claude must never be able to reach into the clipboard of someone
      // who is only watching it.
      term.loadAddon(
        new ClipboardAddon(undefined, {
          readText: () => '',
          writeText: async (selection, text) => {
            if (!mayType || selection !== 'c') return;
            await navigator.clipboard?.writeText(text).catch(() => undefined);
          },
        }),
      );
      term.open(container);
      cleanups.push(() => term.dispose());

      // Ctrl/Cmd+V pastes (a prompt, the sign-in code) instead of sending ^V, and
      // Ctrl/Cmd+C copies when something is selected instead of interrupting Claude.
      // Returning false leaves the key to the browser, whose paste and copy events
      // xterm handles itself (bracketed paste included).
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const key = event.key.toLowerCase();
        const modifier = event.ctrlKey || event.metaKey;
        if (modifier && key === 'v') return false;
        if (modifier && key === 'c' && (event.shiftKey || event.metaKey || term.hasSelection())) return false;
        return true;
      });

      /** The owner's terminal fills its pane; the pty follows it. */
      const fitToPane = (): { cols: number; rows: number } | null => {
        const proposed = fit.proposeDimensions();
        if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows) || proposed.cols < 10 || proposed.rows < 4) return null;
        if (proposed.cols !== term.cols || proposed.rows !== term.rows) term.resize(proposed.cols, proposed.rows);
        return { cols: proposed.cols, rows: proposed.rows };
      };
      /** A watcher's terminal has the owner's size, so Claude's layout reads as it does for them. */
      const matchPty = (cols: number, rows: number) => {
        if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      };
      const focusIfFree = () => {
        const active = document.activeElement;
        if (!active || active === document.body || container.contains(active)) term.focus();
      };

      const client = new AgentTerminalClient({ url: () => fetchTerminalUrl(workspaceId, pane.userId) });
      cleanups.push(() => client.close());
      const send = (message: AgentTerminalClientMessage) => {
        client.send(message);
      };
      sendRef.current = (message) => {
        if (message.type === 'start') {
          const size = fitToPane() ?? { cols: term.cols, rows: term.rows };
          send({ type: 'start', cols: size.cols, rows: size.rows });
          term.focus();
          return;
        }
        send(message);
      };
      cleanups.push(() => {
        sendRef.current = () => undefined;
      });

      cleanups.push(
        client.onStateChange(({ state }) => {
          setConnection(state);
        }),
        client.onMessage((message) => {
          switch (message.type) {
            case 'hello': {
              mayType = message.canInput;
              info = message.terminal;
              knownLinks = message.links;
              term.options.disableStdin = !mayType;
              // RIS through the parser, so output still queued from before a reconnect
              // cannot land on top of the fresh screen; then draw the screen at the
              // size it was captured at.
              term.write('\x1bc');
              matchPty(info.cols, info.rows);
              const snapshot = info;
              term.write(message.screen, () => {
                if (!mayType) return;
                const size = fitToPane() ?? { cols: term.cols, rows: term.rows };
                if (snapshot.status === 'idle') {
                  send({ type: 'start', cols: size.cols, rows: size.rows });
                } else if (snapshot.status === 'running' && (size.cols !== snapshot.cols || size.rows !== snapshot.rows)) {
                  send({ type: 'resize', cols: size.cols, rows: size.rows });
                }
                focusIfFree();
              });
              setCanInput(mayType);
              setTerminal(info);
              setNotice(null);
              return;
            }
            case 'state':
              info = message.terminal;
              if (!mayType) matchPty(info.cols, info.rows);
              setTerminal(info);
              return;
            case 'output':
              term.write(message.data);
              return;
            case 'clear':
              term.write('\x1bc');
              return;
            case 'error':
              setNotice(message.message);
              return;
          }
        }),
      );

      const dataDisposable = term.onData((data) => {
        if (mayType) send({ type: 'input', data });
      });
      cleanups.push(() => dataDisposable.dispose());

      // Follow the pane's size. Hidden panes (the phone layout shows one at a time)
      // measure as nothing and are left alone until they are shown.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (!mayType) return;
          const size = fitToPane();
          if (size && info && (info.status === 'running' || info.status === 'starting') && (size.cols !== info.cols || size.rows !== info.rows)) {
            send({ type: 'resize', cols: size.cols, rows: size.rows });
          }
        }, 80);
      });
      observer.observe(container);
      cleanups.push(() => {
        observer.disconnect();
        if (timer) clearTimeout(timer);
      });
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
      setConnection('connecting');
      setTerminal(null);
      setCanInput(false);
    };
  }, [workspaceId, pane.userId]);

  const status = statusOf(connection, terminal, canInput);
  const known = terminal !== null && connection === 'open';
  const waitingForOwner = known && !canInput && terminal.status === 'idle';
  const starting = known && canInput && (terminal.status === 'idle' || terminal.status === 'starting');
  const exited = known && terminal.status === 'exited';

  return (
    <section aria-label={pane.title} className="flex h-full min-h-0 min-w-0 flex-col bg-canvas" data-claude-pane={pane.userId}>
      <header className="pane-header gap-2.5 pl-3 pr-2">
        <Avatar name={pane.name} size="sm" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="pane-title truncate">{pane.title}</h2>
          {pane.isYou ? <span className="flex-none text-xs text-fg-subtle">You</span> : null}
          {pane.detail ? <span className="truncate text-xs text-fg-faint">{pane.detail}</span> : null}
        </div>
        {known && !canInput ? (
          <span className="hidden flex-none items-center gap-1 text-xs text-fg-subtle sm:flex" title={`Only ${owner} can type in ${owner}'s Claude`}>
            <Eye className="size-3.5" aria-hidden />
            Watching
          </span>
        ) : null}
        <span className={cx('status', `tone-${status.tone}`)} role="status">
          <span className="status-dot" data-pulse={status.pulse ? '' : undefined} data-hollow={status.hollow ? '' : undefined} aria-hidden />
          {status.label}
        </span>
        {known && canInput && terminal.status === 'running' ? (
          <button
            type="button"
            onClick={() => sendRef.current({ type: 'stop' })}
            className="btn btn-ghost btn-icon btn-xs flex-none hover:text-danger"
            aria-label="Stop Claude"
            title="Stop Claude and everything it started"
          >
            <Square aria-hidden />
          </button>
        ) : null}
      </header>

      {notice ? (
        <div role="alert" className="flex flex-none animate-enter items-center gap-2 border-b border-danger/25 bg-danger/[0.06] px-3 py-1.5 text-xs text-[#f3b1aa]">
          <CircleAlert className="size-3.5 flex-none text-danger" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="grid size-5 place-items-center rounded opacity-70 hover:opacity-100" aria-label="Dismiss">
            <X className="size-3" aria-hidden />
          </button>
        </div>
      ) : null}

      {/* Clipped: xterm's measuring helpers and fractional row heights must never make the page scroll. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 pb-1 pl-3 pr-1 pt-2">
          <div ref={containerRef} className={cx('h-full w-full', !canInput && 'overflow-auto')} />
        </div>

        {/* Only before the first connection: after that a reconnect keeps showing the
            last screen, and the status pill says so. */}
        {terminal === null ? (
          <PaneMessage icon={<LoaderCircle className="size-[18px] animate-spin" aria-hidden />} title="Connecting…" />
        ) : waitingForOwner ? (
          <PaneMessage
            icon={<Avatar name={pane.name} />}
            title={`${owner} hasn't opened Claude yet`}
            body="It shows up here, live, when they open this workspace. Only they can type in it."
          />
        ) : starting ? (
          <PaneMessage icon={<LoaderCircle className="size-[18px] animate-spin" aria-hidden />} title="Starting Claude…" body="The first time, Claude asks you to sign in with your own account, right here." />
        ) : null}

        {exited ? (
          <div className="absolute inset-x-0 bottom-0 flex animate-enter flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-panel/95 px-3 py-2.5 backdrop-blur-sm">
            <p className="min-w-0 flex-1 text-[12.5px] text-fg-muted">
              {terminal.error ? terminal.error : canInput ? 'Claude has stopped. Your conversations are kept: /resume picks one up.' : `${owner}'s Claude has stopped.`}
            </p>
            {canInput ? (
              <button type="button" onClick={() => sendRef.current({ type: 'start', cols: 80, rows: 24 })} className="btn btn-primary btn-sm">
                <Play aria-hidden />
                Start Claude
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PaneMessage({ icon, title, body }: { icon: ReactNode; title: string; body?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center bg-canvas p-6">
      <div className="max-w-xs text-center">
        <span className="mx-auto grid size-10 place-items-center rounded-full border border-line bg-panel text-fg-subtle">{icon}</span>
        <p className="mt-3 text-[13px] font-medium text-fg">{title}</p>
        {body ? <p className="mt-1 text-[12.5px] leading-relaxed text-fg-subtle">{body}</p> : null}
      </div>
    </div>
  );
}
