import { ClientWorkspaceSession, IsolatedAgentSession, WorkspaceCommandRunner } from '@notea/agents';
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
 * Builds the session an agent run executes in: a process under the owning member's
 * own Unix uid, started by the Docker daemon through the orchestrator.
 *
 * Separate from {@link ConnectWorkspace} because it is a different trust boundary.
 * The workspace connection acts as `dev` and does the shared git work (worktrees,
 * rebase, fast-forward); this one acts as one member and is the only thing a
 * provider credential is ever handed to.
 */
export type CreateIsolatedSession = (workspaceId: string, uid: number) => WorkspaceSession;

export function createIsolatedSessionFactory(orchestrator: OrchestratorClient): CreateIsolatedSession {
  return (workspaceId, uid) => new IsolatedAgentSession(orchestrator, { workspaceId, uid });
}

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
      // umask 002: the project is shared with the per-member agent uids through the
      // `dev` group, so a checkout or a rebase performed here has to stay writable
      // by the agent that owns the run.
      runner: new WorkspaceCommandRunner(client, { timeoutMs: 10 * 60 * 1000, prefix: 'umask 002; ' }),
      close: () => client.close(),
    };
  };
}
