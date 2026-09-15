import type {
  CreateWorkspaceRuntimeRequest,
  IssueConnectTokenRequest,
  IssueConnectTokenResponse,
  WorkspaceRuntimeInfo,
} from '@notea/protocol';

export class OrchestratorError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export interface OrchestratorClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Milliseconds; workspace creation waits for the agent, so keep this generous. */
  timeoutMs?: number;
}

/** Typed client for the orchestrator's control-plane REST API. Server side only. */
export class OrchestratorClient {
  constructor(private readonly opts: OrchestratorClientOptions) {}

  get baseUrl(): string {
    return this.opts.baseUrl.replace(/\/$/, '');
  }

  listWorkspaces(): Promise<{ workspaces: WorkspaceRuntimeInfo[] }> {
    return this.call('GET', '/workspaces');
  }

  createWorkspace(request: CreateWorkspaceRuntimeRequest & { wait?: boolean }): Promise<WorkspaceRuntimeInfo> {
    return this.call('POST', '/workspaces', request);
  }

  getWorkspace(workspaceId: string): Promise<WorkspaceRuntimeInfo | null> {
    return this.call<WorkspaceRuntimeInfo>('GET', `/workspaces/${encodeURIComponent(workspaceId)}`).catch((err) => {
      if (err instanceof OrchestratorError && err.status === 404) return null;
      throw err;
    });
  }

  startWorkspace(workspaceId: string): Promise<WorkspaceRuntimeInfo> {
    return this.call('POST', `/workspaces/${encodeURIComponent(workspaceId)}/start`);
  }

  stopWorkspace(workspaceId: string): Promise<WorkspaceRuntimeInfo> {
    return this.call('POST', `/workspaces/${encodeURIComponent(workspaceId)}/stop`);
  }

  deleteWorkspace(workspaceId: string, options: { deleteVolume: boolean }): Promise<void> {
    return this.call(
      'DELETE',
      `/workspaces/${encodeURIComponent(workspaceId)}?deleteVolume=${options.deleteVolume ? 'true' : 'false'}`,
    );
  }

  issueConnectToken(request: IssueConnectTokenRequest): Promise<IssueConnectTokenResponse> {
    return this.call('POST', '/connect-tokens', request);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 90_000),
      });
    } catch (err) {
      throw new OrchestratorError(503, 'unreachable', `orchestrator unreachable: ${(err as Error).message}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new OrchestratorError(response.status, error?.code ?? 'error', error?.message ?? `orchestrator returned ${response.status}`);
    }
    return json as T;
  }
}
