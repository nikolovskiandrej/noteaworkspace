import { ClientWorkspaceSession, WorkspaceCommandRunner } from '@notea/agents';
import type { CommandRunner, WorkspaceSession } from '@notea/agents';
import type { ClientIdentity } from '@notea/protocol';
import { OrchestratorClient, WorkspaceClient } from '@notea/workspace-client';

export interface WorkspaceConnection {
  session: WorkspaceSession;
  runner: CommandRunner;
  close(): void;
}

export type ConnectWorkspace = (workspaceId: string, identity: ClientIdentity) => Promise<WorkspaceConnection>;

/**
 * Connects to a workspace as an agent participant: starts the runtime if needed,
 * obtains connect tokens from the orchestrator (refreshed on every reconnect) and
 * wraps the socket for the runtimes and git helpers.
 */
export function createWorkspaceConnector(orchestrator: OrchestratorClient): ConnectWorkspace {
  return async (workspaceId, identity) => {
    const info = await orchestrator.getWorkspace(workspaceId);
    if (!info) throw new Error(`workspace runtime ${workspaceId} does not exist`);
    if (info.status !== 'running') await orchestrator.startWorkspace(workspaceId);

    const wsBase = orchestrator.baseUrl.replace(/^http/, 'ws');
    const client = new WorkspaceClient({
      url: async () => {
        const issued = await orchestrator.issueConnectToken({
          workspaceId,
          userId: identity.userId,
          name: identity.name,
          role: identity.role,
          kind: identity.kind,
          ttlSeconds: 600,
        });
        return `${wsBase}${issued.wsPath}?token=${encodeURIComponent(issued.token)}`;
      },
      minBackoffMs: 1000,
      maxBackoffMs: 15_000,
      requestTimeoutMs: 60_000,
    });
    await client.waitForHello(30_000);
    return {
      session: new ClientWorkspaceSession(client),
      runner: new WorkspaceCommandRunner(client, { timeoutMs: 10 * 60 * 1000 }),
      close: () => client.close(),
    };
  };
}
