'use client';

import { useEffect, useRef } from 'react';
import type { WorkspaceClient } from '@notea/workspace-client';
import '@xterm/xterm/css/xterm.css';

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
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed) return;
      const term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
        scrollback: 5000,
        theme: { background: '#0e1014', foreground: '#d7dae0', cursor: '#6ee7b7' },
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
      term.focus();
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
