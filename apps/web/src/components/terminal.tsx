'use client';

import { useEffect, useRef } from 'react';
import type { WorkspaceClient } from '@notea/workspace-client';
import '@xterm/xterm/css/xterm.css';

/** The terminal in the workspace palette: the canvas behind, mint cursor, muted ANSI colours. */
const THEME = {
  background: '#090b0a',
  foreground: '#d9dcd3',
  cursor: '#7cc4a0',
  cursorAccent: '#090b0a',
  selectionBackground: 'rgba(124, 196, 160, 0.26)',
  black: '#1a1f1c',
  red: '#ec7c73',
  green: '#7cc4a0',
  yellow: '#dcae5a',
  blue: '#8fb4e6',
  magenta: '#ad9df3',
  cyan: '#7fc2c2',
  white: '#d9dcd3',
  brightBlack: '#5b635d',
  brightRed: '#f29a92',
  brightGreen: '#9ed8b9',
  brightYellow: '#e8c47e',
  brightBlue: '#abc8ef',
  brightMagenta: '#c5b9f7',
  brightCyan: '#a0d8d8',
  brightWhite: '#f4f5ef',
};

/**
 * xterm measures its character cell once, when it opens, so it has to measure the
 * font it will draw with. Waits for the self-hosted mono font (at most 1.5 s, then
 * carries on with whatever is available).
 */
async function monoFontReady(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await Promise.race([
      Promise.all([document.fonts.load('13px "IBM Plex Mono"'), document.fonts.load('600 13px "IBM Plex Mono"')]),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // A font that fails to load is not a reason to have no terminal.
  }
}

/**
 * One xterm.js instance attached to one agent session. Mounting attaches (and
 * replays scrollback); unmounting detaches. On every new `hello` (reconnect) it
 * re-attaches so the terminal keeps working after network blips.
 */
export function Terminal({ client, sessionId, canInput }: { client: WorkspaceClient; sessionId: string; canInput: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canInputRef = useRef(canInput);
  canInputRef.current = canInput;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];

    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), monoFontReady()]);
      if (disposed) return;
      const term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        lineHeight: 1.2,
        fontFamily: '"IBM Plex Mono", ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace',
        fontWeightBold: 600,
        scrollback: 5000,
        theme: THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      fit.fit();
      cleanups.push(() => term.dispose());

      const attach = async () => {
        try {
          const reply = await client.attachTerminal(sessionId);
          if (disposed) return;
          term.reset();
          term.write(reply.scrollback);
          if (canInputRef.current) client.resize(sessionId, term.cols, term.rows);
        } catch {
          // Session may have exited; the panel removes the tab on `term.exit`.
        }
      };
      await attach();

      cleanups.push(
        client.on('term.output', (message) => {
          if (message.sessionId === sessionId) term.write(message.data);
        }),
        client.on('hello', () => void attach()),
      );
      const dataDisposable = term.onData((data) => {
        if (canInputRef.current && client.state === 'open') client.input(sessionId, data);
      });
      cleanups.push(() => dataDisposable.dispose());

      const observer = new ResizeObserver(() => {
        fit.fit();
        if (canInputRef.current && client.state === 'open') client.resize(sessionId, term.cols, term.rows);
      });
      observer.observe(container);
      cleanups.push(() => observer.disconnect());
      // Take the keyboard only if nothing else has it, or it is already in the terminal
      // panel (a tab or "New terminal" was just clicked). Attaching is asynchronous, and a
      // terminal that finishes while someone is typing in the editor must not send the
      // rest of their keystrokes to a shell.
      const active = document.activeElement;
      if (!active || active === document.body || active.closest('[data-terminal-panel]')) term.focus();
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
      try {
        if (client.state === 'open') client.detachTerminal(sessionId);
      } catch {
        // socket already gone
      }
    };
  }, [client, sessionId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
