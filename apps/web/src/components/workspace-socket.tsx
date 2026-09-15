'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentMessageOf, PresenceClient, TerminalSessionInfo } from '@notea/protocol';
import { WorkspaceClient, type ConnectionState } from '@notea/workspace-client';

export interface WorkspaceSocketValue {
  /** Null until the component has mounted in the browser. */
  client: WorkspaceClient | null;
  state: ConnectionState;
  hello: AgentMessageOf<'hello'> | null;
  presence: PresenceClient[];
  sessions: TerminalSessionInfo[];
  lastClose: { code?: number; reason?: string } | null;
}

const WorkspaceSocketContext = createContext<WorkspaceSocketValue | null>(null);

export function useWorkspaceSocket(): WorkspaceSocketValue {
  const value = useContext(WorkspaceSocketContext);
  if (!value) throw new Error('useWorkspaceSocket must be used inside WorkspaceSocketProvider');
  return value;
}

async function fetchConnectUrl(workspaceId: string): Promise<string> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/connect-token`, { method: 'POST' });
  if (!response.ok) throw new Error(`connect token request failed (${response.status})`);
  const body = (await response.json()) as { url: string };
  return body.url;
}

/**
 * Owns one WorkspaceClient per workspace page and mirrors its state into React.
 * The client is created inside an effect so it never runs during server rendering
 * (and so React's development double-mount closes and recreates it cleanly).
 */
export function WorkspaceSocketProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [client, setClient] = useState<WorkspaceClient | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [hello, setHello] = useState<AgentMessageOf<'hello'> | null>(null);
  const [presence, setPresence] = useState<PresenceClient[]>([]);
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [lastClose, setLastClose] = useState<{ code?: number; reason?: string } | null>(null);

  useEffect(() => {
    const instance = new WorkspaceClient({
      url: () => fetchConnectUrl(workspaceId),
      minBackoffMs: 1000,
      maxBackoffMs: 15_000,
    });
    const offs = [
      instance.onStateChange(({ state: next, code, reason }) => {
        setState(next);
        if (next !== 'open') setLastClose({ code, reason });
      }),
      instance.on('hello', (message) => {
        setHello(message);
        setPresence(message.clients);
        setSessions(message.sessions);
      }),
      instance.on('presence', (message) => setPresence(message.clients)),
      instance.on('term.opened', (message) =>
        setSessions((prev) => (prev.some((s) => s.id === message.session.id) ? prev : [...prev, message.session])),
      ),
      instance.on('term.exit', (message) => setSessions((prev) => prev.filter((s) => s.id !== message.sessionId))),
    ];
    setClient(instance);
    setState(instance.state);
    return () => {
      for (const off of offs) off();
      instance.close();
      setClient(null);
      setHello(null);
      setPresence([]);
      setSessions([]);
    };
  }, [workspaceId]);

  const value = useMemo(
    () => ({ client, state, hello, presence, sessions, lastClose }),
    [client, state, hello, presence, sessions, lastClose],
  );
  return <WorkspaceSocketContext.Provider value={value}>{children}</WorkspaceSocketContext.Provider>;
}
