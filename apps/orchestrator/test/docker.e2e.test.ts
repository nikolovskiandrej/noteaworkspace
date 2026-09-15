/**
 * Real Docker end-to-end test. Skipped unless NOTEA_E2E_DOCKER=1 is set or the
 * suite is started through `npm run test:e2e`.
 *
 * Requires: a running Docker engine and the image `notea/workspace:dev`
 * (`npm run build:image`). Creates and removes a throw-away workspace.
 */
import { randomBytes } from 'node:crypto';
import Docker from 'dockerode';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentMessage, AgentMessageOf, ClientMessage } from '@notea/protocol';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { WorkspaceRuntime } from '../src/docker/workspace-runtime';
import { TokenService } from '../src/tokens';

const enabled = process.env.NOTEA_E2E_DOCKER === '1' || process.env.npm_lifecycle_event === 'test:e2e';
const describeE2E = enabled ? describe : describe.skip;

const workspaceId = `e2e-${randomBytes(4).toString('hex')}`;
let app: FastifyInstance;
let runtime: WorkspaceRuntime;
let tokens: TokenService;
let baseUrl: string;

async function waitFor<T extends AgentMessage['type']>(
  ws: WebSocket,
  type: T,
  predicate: (m: AgentMessageOf<T>) => boolean = () => true,
  timeoutMs = 30_000,
): Promise<AgentMessageOf<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as AgentMessage;
      if (message.type === type && predicate(message as AgentMessageOf<T>)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message as AgentMessageOf<T>);
      }
    };
    ws.on('message', onMessage);
  });
}

function send(ws: WebSocket, message: ClientMessage): void {
  ws.send(JSON.stringify(message));
}

describeE2E('docker end-to-end', () => {
  beforeAll(async () => {
    const config = loadConfig({
      ...process.env,
      ORCHESTRATOR_API_KEY: 'e2e-api-key-e2e-api-key',
      CONNECT_TOKEN_SECRET: 'c'.repeat(32),
      AGENT_TOKEN_SECRET: randomBytes(32).toString('hex'),
      WORKSPACE_DEFAULT_MEMORY_MB: '1024',
      WORKSPACE_DEFAULT_CPUS: '1',
    });
    tokens = new TokenService({
      connectTokenSecret: config.connectTokenSecret,
      agentTokenSecret: config.agentTokenSecret,
      defaultTtlSeconds: 300,
      maxTtlSeconds: 3600,
    });
    const docker = new Docker(config.dockerSocketPath ? { socketPath: config.dockerSocketPath } : undefined);
    runtime = new WorkspaceRuntime(docker, {
      image: config.workspaceImage,
      network: config.workspaceNetwork,
      agentPort: config.agentPort,
      publishAgentPort: config.agentConnectMode === 'published',
      defaultResources: config.defaultResources,
      agentTokenFor: (id) => tokens.agentToken(id),
      log: { info: () => undefined, warn: () => undefined },
    });
    app = await buildApp({ runtime, tokens, apiKey: config.apiKey });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    baseUrl = `127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.remove(workspaceId, { deleteVolume: true }).catch(() => undefined);
    if (app) await app.close();
  }, 60_000);

  it(
    'creates a workspace, runs a shell command through the bridge, persists files across restarts',
    async () => {
      const info = await runtime.create({ workspaceId });
      expect(info.status).toBe('running');
      const endpoint = await runtime.waitForAgent(workspaceId, 60_000);
      expect(endpoint.port).toBeGreaterThan(0);

      const { token } = await tokens.issueConnectToken({ sub: 'u1', ws: workspaceId, name: 'E2E', role: 'owner', kind: 'user' });
      const ws = new WebSocket(`ws://${baseUrl}/ws/workspaces/${workspaceId}?token=${token}`);
      const hello = await waitFor(ws, 'hello');
      expect(hello.projectDir).toBe('/home/dev/project');

      send(ws, { type: 'term.create', reqId: 'r1', cols: 100, rows: 30 });
      const created = await waitFor(ws, 'term.created');
      const sessionId = created.session.id;

      let transcript = '';
      const marker = `NOTEA_OK_${randomBytes(3).toString('hex')}`;
      const done = `NOTEA_DONE_${randomBytes(3).toString('hex')}`;
      // The command echoes a marker, the user, the cwd, then a final sentinel. Quotes in
      // the typed command keep the echoed input from matching the markers themselves.
      const outputPromise = waitFor(ws, 'term.output', (m) => {
        transcript += m.data;
        return transcript.includes(`${done}\r\n`) || transcript.includes(`${done}\n`);
      });
      send(ws, {
        type: 'term.input',
        sessionId,
        data: `echo ${marker.slice(0, 6)}"${marker.slice(6)}"; whoami; pwd; echo ${done.slice(0, 6)}"${done.slice(6)}"\r`,
      });
      await outputPromise;
      expect(transcript).toContain(`${marker}\r\n`);
      expect(transcript).toMatch(/\r\ndev\r\n/);
      expect(transcript).toContain('/home/dev/project\r\n');

      send(ws, { type: 'fs.write', reqId: 'w1', path: 'hello.txt', content: 'persisted\n' });
      await waitFor(ws, 'fs.written');

      // exec: a real child process with streamed output and an injected variable.
      let execOut = '';
      const execExit = waitFor(ws, 'exec.exit');
      const execOutputs = waitFor(ws, 'exec.output', (m) => {
        execOut += m.data;
        return execOut.includes('exec-ok');
      });
      send(ws, {
        type: 'exec.start',
        reqId: 'x1',
        command: 'git --version && echo "exec-ok $NOTEA_TEST_VAR" && cat hello.txt',
        shell: true,
        env: { NOTEA_TEST_VAR: 'injected' },
      });
      const started = await waitFor(ws, 'exec.started');
      expect(started.pid).toBeGreaterThan(0);
      await execOutputs;
      const exit = await execExit;
      expect(exit).toMatchObject({ execId: started.execId, exitCode: 0, timedOut: false });
      expect(execOut).toContain('git version');
      expect(execOut).toContain('exec-ok injected');
      expect(execOut).toContain('persisted');
      ws.close();

      // Stop and start: the container restarts, the volume keeps the file.
      const stopped = await runtime.stop(workspaceId);
      expect(stopped.status).toBe('stopped');
      await runtime.start(workspaceId);
      await runtime.waitForAgent(workspaceId, 60_000);

      const { token: token2 } = await tokens.issueConnectToken({ sub: 'u1', ws: workspaceId, name: 'E2E', role: 'owner', kind: 'user' });
      const ws2 = new WebSocket(`ws://${baseUrl}/ws/workspaces/${workspaceId}?token=${token2}`);
      const hello2 = await waitFor(ws2, 'hello');
      expect(hello2.sessions).toEqual([]); // sessions do not survive a container restart
      send(ws2, { type: 'fs.read', reqId: 'rd1', path: 'hello.txt' });
      const content = await waitFor(ws2, 'fs.content');
      expect(content.content).toBe('persisted\n');
      ws2.close();
    },
    180_000,
  );
});
