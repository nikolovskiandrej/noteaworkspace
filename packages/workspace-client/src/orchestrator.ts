import type {
  AgentExecFrame,
  AgentExecRequest,
  AgentExecResult,
  CreateWorkspaceRuntimeRequest,
  IssueAgentTerminalTokenRequest,
  IssueAgentTerminalTokenResponse,
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

  /** A token for watching (and, for its own member, typing into) a member's Claude terminal. */
  issueAgentTerminalToken(request: IssueAgentTerminalTokenRequest): Promise<IssueAgentTerminalTokenResponse> {
    return this.call('POST', '/agent-terminal-tokens', request);
  }

  /** Ends a member's Claude terminal in a workspace, if one runs. */
  stopAgentTerminal(workspaceId: string, uid: number): Promise<void> {
    return this.call('POST', `/workspaces/${encodeURIComponent(workspaceId)}/agent-terminals/${encodeURIComponent(String(uid))}/stop`);
  }

  /** Runs a command in a workspace container as `request.uid` and buffers its output. */
  agentExec(workspaceId: string, request: AgentExecRequest): Promise<AgentExecResult> {
    return this.call('POST', `/workspaces/${encodeURIComponent(workspaceId)}/agent-exec`, { ...request, stream: false });
  }

  /**
   * Starts a command in a workspace container as `request.uid` and streams its
   * output as it arrives. The returned `frames` always ends with an `exit` frame
   * (or with the stream closing), so a consumer's `for await` cannot hang forever.
   */
  async agentExecStream(
    workspaceId: string,
    request: AgentExecRequest,
  ): Promise<{ execId: string; frames: AsyncIterable<AgentExecFrame>; kill: () => Promise<void> }> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/agent-exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    }).catch((err: unknown) => {
      throw new OrchestratorError(503, 'unreachable', `orchestrator unreachable: ${(err as Error).message}`);
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let message = `orchestrator returned ${response.status}`;
      let code = 'error';
      try {
        const error = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
        if (error?.message) message = error.message;
        if (error?.code) code = error.code;
      } catch {
        /* keep the default message */
      }
      throw new OrchestratorError(response.status, code, message);
    }

    const iterator = readFrames(response.body);
    const first = await iterator.next();
    if (first.done || first.value.type !== 'started') {
      throw new OrchestratorError(502, 'bad_stream', 'agent exec did not start');
    }
    const execId = first.value.execId;
    return {
      execId,
      frames: { [Symbol.asyncIterator]: () => iterator },
      kill: async () => {
        await this.call('POST', `/workspaces/${encodeURIComponent(workspaceId)}/agent-exec/${encodeURIComponent(execId)}/kill`, {
          uid: request.uid,
        });
      },
    };
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

/** Splits an NDJSON body into frames, ignoring blank and unparsable lines. */
async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentExecFrame, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            yield JSON.parse(line) as AgentExecFrame;
          } catch {
            /* a partial or malformed frame is not worth failing the run over */
          }
        }
        index = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as AgentExecFrame;
      } catch {
        /* ignore */
      }
    }
  } finally {
    reader.releaseLock();
  }
}
