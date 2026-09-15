/**
 * Real Docker end-to-end test. Skipped unless NOTEA_E2E_DOCKER=1 is set or the
 * suite is started through `npm run test:e2e`.
 *
 * Requires: a running Docker engine and the image `notea/workspace:dev`
 * (`npm run build:image`). Creates and removes a throw-away workspace.
 */
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentMessage, AgentMessageOf, ClientMessage } from '@notea/protocol';
import { buildApp } from '../src/app';
import { DockerAgentExec, collectAgentExec } from '../src/docker/agent-exec';
import { loadConfig } from '../src/config';
import { WorkspaceRuntime } from '../src/docker/workspace-runtime';
import { TokenService } from '../src/tokens';

const enabled = process.env.NOTEA_E2E_DOCKER === '1' || process.env.npm_lifecycle_event === 'test:e2e';
const describeE2E = enabled ? describe : describe.skip;

const workspaceId = `e2e-${randomBytes(4).toString('hex')}`;
let app: FastifyInstance;
let runtime: WorkspaceRuntime;
let agentExec: DockerAgentExec;
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
  let config: ReturnType<typeof loadConfig>;
  let docker: Docker;

  beforeAll(async () => {
    config = loadConfig({
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
    docker = new Docker(config.dockerSocketPath ? { socketPath: config.dockerSocketPath } : undefined);
    agentExec = new DockerAgentExec(docker, {
      uidMin: config.agentUidRange.min,
      uidMax: config.agentUidRange.max,
      gid: config.agentUidRange.gid,
    });
    runtime = new WorkspaceRuntime(docker, {
      image: config.workspaceImage,
      network: config.workspaceNetwork,
      agentPort: config.agentPort,
      publishAgentPort: config.agentConnectMode === 'published',
      defaultResources: config.defaultResources,
      agentTokenFor: (id) => tokens.agentToken(id),
      log: { info: () => undefined, warn: () => undefined },
    });
    app = await buildApp({ runtime, tokens, apiKey: config.apiKey, agentExec });
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
      const execOutputs = waitFor(ws, 'exec.output', (m) => {
        execOut += m.data;
        return execOut.includes('persisted');
      });
      execOutputs.catch(() => undefined);
      const execExit = waitFor(ws, 'exec.exit');
      execExit.catch(() => undefined);
      send(ws, {
        type: 'exec.start',
        reqId: 'x1',
        command: 'git --version && echo "exec-ok $DEMO_TEST_VAR" && cat hello.txt',
        shell: true,
        env: { DEMO_TEST_VAR: 'injected' },
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

  /**
   * The credential-isolation boundary, exercised against a real container.
   *
   * The finding this replaces was concrete: the agent ran as the same uid as every
   * human shell, so `grep -a ANTHROPIC_API_KEY /proc/<pid>/environ` returned the
   * owner's key. These tests hold two agent processes from *different* members side
   * by side, each with a distinct marker in its environment, and assert that neither
   * uid — nor the `dev` user the workspace's terminals run as — can read the other's.
   */
  it(
    'keeps one member’s provider credential unreadable by the other member and by the shared shell user',
    async () => {
      const container = docker.getContainer(`notea-ws-${workspaceId}`);
      const andrejUid = 20_003;
      const nicheUid = 20_004;
      const andrejSecret = `sk-ant-oat01-ANDREJ-${randomBytes(6).toString('hex')}`;
      const nicheSecret = `sk-ant-api03-NICHE-${randomBytes(6).toString('hex')}`;

      // Two runs in flight at once, one per member, exactly as two concurrent tasks.
      const andrej = await agentExec.start(container.id, {
        uid: andrejUid,
        cmd: ['/bin/sh', '-c', 'echo andrej-ready; sleep 60'],
        env: { CLAUDE_CODE_OAUTH_TOKEN: andrejSecret },
        unsetEnv: ['ANTHROPIC_API_KEY'],
        timeoutMs: 90_000,
      });
      const niche = await agentExec.start(container.id, {
        uid: nicheUid,
        cmd: ['/bin/sh', '-c', 'echo niche-ready; sleep 60'],
        env: { ANTHROPIC_API_KEY: nicheSecret },
        unsetEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
        timeoutMs: 90_000,
      });
      await Promise.all([readUntil(andrej.stdout, 'andrej-ready'), readUntil(niche.stdout, 'niche-ready')]);

      const asUid = (uid: number | string, script: string) => runAs(container, uid, script);

      // Sanity: each process really does hold its own secret, so a negative result
      // below means "denied", not "there was nothing there".
      const own = await asUid(andrejUid, 'grep -aho "sk-ant-oat01-ANDREJ-[0-9a-f]*" /proc/*/environ 2>/dev/null | head -1');
      expect(own.trim()).toContain(andrejSecret);

      const scan = 'cat /proc/*/environ 2>/dev/null | tr "\0" "\n" | grep -a "sk-ant" || echo NOTHING';
      // 1 + 2: neither member can read the other's credential.
      expect(await asUid(nicheUid, scan)).not.toContain(andrejSecret);
      expect(await asUid(andrejUid, scan)).not.toContain(nicheSecret);
      // 4: the shared `dev` user every human terminal runs as sees neither.
      const asDev = await asUid(1000, scan);
      expect(asDev).not.toContain(andrejSecret);
      expect(asDev).not.toContain(nicheSecret);

      // The kernel is what enforces it: the environ file is mode 0400, owned by the
      // process's own uid, and reading it across uids fails with EACCES.
      const denied = await asUid(nicheUid, `cat /proc/$(pgrep -u ${andrejUid} -f "sleep 60" | head -1)/environ 2>&1 || true`);
      expect(denied).toMatch(/Permission denied/);

      // 10: each member's CLI configuration directory is private on disk too, so a
      // `claude auth login` performed inside the workspace is private as well. (The
      // setgid bit is inherited from the shared parent; what matters is that neither
      // group nor other has any access.)
      const homes = (await asUid(1000, 'ls -ld /home/dev/.notea/agents/* 2>/dev/null')).trim().split('\n');
      for (const uid of [andrejUid, nicheUid]) {
        const line = homes.find((l) => l.trim().endsWith(`/${uid}`));
        expect(line, `no agent home for ${uid} in ${homes.join(' | ')}`).toBeDefined();
        const [mode, , owner] = line!.trim().split(/ +/);
        expect(owner).toBe(String(uid));
        // Owner-only. The group bits stay clear even though the parent is setgid,
        // so a CLI login written here is unreadable by the other members.
        expect(mode?.slice(4)).toMatch(/^--[-S]---$/);
      }
      expect(await asUid(nicheUid, `cat /home/dev/.notea/agents/${andrejUid}/.credentials.json 2>&1 || true`)).toMatch(/Permission denied/);

      await Promise.all([
        agentExec.kill(container.id, andrej.execId, andrejUid),
        agentExec.kill(container.id, niche.execId, nicheUid),
      ]);
      await Promise.all([andrej.done, niche.done]);
    },
    180_000,
  );

  it(
    'runs an agent command as the member and cancels its whole process tree',
    async () => {
      const container = docker.getContainer(`notea-ws-${workspaceId}`);

      const identity = await agentExec.start(container.id, { uid: 20_005, cmd: ['/bin/sh', '-c', 'id -u; echo HOME=$HOME; umask'] });
      const text = await collectAgentExec(identity);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain('20005');
      expect(text.stdout).toContain('HOME=/home/dev/.notea/agents/20005');
      expect(text.stdout).toContain('0002');

      // A cancelled run must take its children with it: the CLI spawns tools, and a
      // survivor would keep holding the credential it was started with.
      const handle = await agentExec.start(container.id, {
        uid: 20_005,
        cmd: ['/bin/sh', '-c', 'sleep 300 & echo child-started; wait'],
        timeoutMs: 120_000,
      });
      await readUntil(handle.stdout, 'child-started');
      await agentExec.kill(container.id, handle.execId, 20_005);
      await handle.done;
      const survivors = await runAs(container, 1000, 'pgrep -u 20005 -f "sleep 300" | wc -l');
      expect(survivors.trim()).toBe('0');
    },
    180_000,
  );
});

/**
 * Runs a throw-away command in the container as an arbitrary uid and returns its
 * output. Used only by the tests, to look at the container from the outside: the
 * product never runs an exec as a uid outside the agent range.
 */
async function runAs(container: Docker.Container, uid: number | string, script: string): Promise<string> {
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', script],
    // Always with the shared group, so these probes have exactly the access a real
    // member's process has. (A uid alone would land in gid 0, which the kernel's
    // ptrace check rejects even for the process's own owner -- a stricter result
    // than the product relies on, and not the case worth asserting.)
    User: `${uid}:1000`,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  container.modem.demuxStream(stream, out, out);
  stream.on('end', () => out.end());
  const chunks: Buffer[] = [];
  for await (const chunk of out) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolves once a stream has produced text containing `needle`. */
async function readUntil(stream: NodeJS.ReadableStream, needle: string): Promise<string> {
  let seen = '';
  for await (const chunk of stream) {
    seen += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (seen.includes(needle)) return seen;
  }
  return seen;
}
