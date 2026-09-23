import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentExecFrame } from '@notea/protocol';
import { AgentTerminals } from '../src/agent-terminals';
import { buildApp } from '../src/app';
import type { AgentExecRunner } from '../src/docker/agent-exec';
import type { WorkspaceRuntimeApi } from '../src/docker/workspace-runtime';
import { RuntimeError } from '../src/errors';
import { TokenService } from '../src/tokens';
import { FakeTtyRunner } from './fake-tty';

const API_KEY = 'orchestrator-test-api-key';

let app: FastifyInstance;
let baseUrl: string;
let finish: () => void = () => undefined;
const kills: Array<{ containerId: string; execId: string; uid: number }> = [];

const notUsed = async (): Promise<never> => {
  throw new RuntimeError(500, 'internal', 'not used');
};

beforeAll(async () => {
  const runtime: WorkspaceRuntimeApi = {
    list: async () => [],
    create: notUsed,
    inspect: async (workspaceId) => ({
      workspaceId,
      status: 'running',
      containerId: 'container-1',
      image: 'notea/workspace:dev',
      volumeName: 'v',
      resources: null,
      createdAt: null,
      startedAt: null,
      dockerStatus: 'running',
    }),
    start: notUsed,
    stop: notUsed,
    remove: async () => undefined,
    agentEndpoint: async () => null,
    waitForAgent: notUsed,
  };
  // A process that writes nothing until the test lets it exit.
  const agentExec: AgentExecRunner = {
    start: async () => ({
      execId: 'exec-1',
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      done: new Promise((resolve) => {
        finish = () => resolve({ exitCode: 0, timedOut: false });
      }),
    }),
    kill: async (containerId, execId, uid) => {
      kills.push({ containerId, execId, uid });
    },
  };
  const tokens = new TokenService({ connectTokenSecret: 'c'.repeat(32), agentTokenSecret: 'a'.repeat(32), defaultTtlSeconds: 300, maxTtlSeconds: 3600 });
  app = await buildApp({ runtime, tokens, apiKey: API_KEY, agentExec, terminals: new AgentTerminals(new FakeTtyRunner()), execKeepaliveMs: 20 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

const startExec = (signal?: AbortSignal) =>
  fetch(`${baseUrl}/workspaces/ws-1/agent-exec`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ uid: 20_003, cmd: ['sleep', '600'], stream: true }),
    signal,
  });

describe('streamed agent exec', () => {
  it('keeps a silent process’s stream alive until it exits', async () => {
    kills.length = 0;
    const response = await startExec();
    expect(response.status).toBe(200);
    setTimeout(() => finish(), 150);
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentExecFrame);

    expect(frames[0]).toEqual({ type: 'started', execId: 'exec-1' });
    // Without these, Node's fetch drops a body that stays silent for 300 s and the
    // worker takes the run for finished while the agent keeps working.
    expect(frames.filter((frame) => frame.type === 'keepalive').length).toBeGreaterThanOrEqual(2);
    expect(frames.at(-1)).toEqual({ type: 'exit', exitCode: 0, timedOut: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(kills).toEqual([]); // a process that exited on its own is left alone
  });

  it('stops the process when its caller goes away mid-run', async () => {
    kills.length = 0;
    const controller = new AbortController();
    const response = await startExec(controller.signal);
    await response.body!.getReader().read(); // the `started` frame
    controller.abort(); // the worker crashed, or was restarted past its drain
    for (let i = 0; i < 50 && kills.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kills).toEqual([{ containerId: 'container-1', execId: 'exec-1', uid: 20_003 }]);
    finish();
  });
});
