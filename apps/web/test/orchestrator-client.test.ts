import { describe, expect, it, vi } from 'vitest';
import { OrchestratorClient, OrchestratorError } from '@notea/workspace-client';

function client(handler: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init));
  return { client: new OrchestratorClient({ baseUrl: 'http://orch.local/', apiKey: 'k'.repeat(20), fetchImpl }), fetchImpl };
}

describe('OrchestratorClient', () => {
  it('sends the api key and json bodies', async () => {
    const { client: c, fetchImpl } = client(() => Response.json({ workspaceId: 'w1', status: 'running' }, { status: 201 }));
    const info = await c.createWorkspace({ workspaceId: 'w1', wait: true });
    expect(info.status).toBe('running');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://orch.local/workspaces');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${'k'.repeat(20)}`);
    expect(JSON.parse(String(init.body))).toEqual({ workspaceId: 'w1', wait: true });
  });

  it('maps error bodies to OrchestratorError', async () => {
    const { client: c } = client(() => Response.json({ error: { code: 'conflict', message: 'exists' } }, { status: 409 }));
    await expect(c.startWorkspace('w1')).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'exists' });
  });

  it('returns null for a missing workspace and undefined for 204', async () => {
    const { client: c } = client((url, init) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 }),
    );
    expect(await c.getWorkspace('nope')).toBeNull();
    expect(await c.deleteWorkspace('nope', { deleteVolume: true })).toBeUndefined();
  });

  it('wraps network failures', async () => {
    const { client: c } = client(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(c.listWorkspaces()).rejects.toBeInstanceOf(OrchestratorError);
    await expect(c.listWorkspaces()).rejects.toMatchObject({ status: 503, code: 'unreachable' });
  });
});
