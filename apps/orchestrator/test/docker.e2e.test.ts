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
import type { AgentMessage, AgentMessageOf, AgentTerminalServerMessage, ClientMessage, IssueAgentTerminalTokenResponse } from '@notea/protocol';
import { AgentTerminals } from '../src/agent-terminals';
import { buildApp } from '../src/app';
import { DockerAgentExec, collectAgentExec } from '../src/docker/agent-exec';
import { DockerAgentTty } from '../src/docker/agent-terminal';
import { loadConfig } from '../src/config';
import { WorkspaceRuntime } from '../src/docker/workspace-runtime';
import { TokenService } from '../src/tokens';

const enabled = process.env.NOTEA_E2E_DOCKER === '1' || process.env.npm_lifecycle_event === 'test:e2e';
const describeE2E = enabled ? describe : describe.skip;

const workspaceId = `e2e-${randomBytes(4).toString('hex')}`;
let app: FastifyInstance;
let runtime: WorkspaceRuntime;
let agentExec: DockerAgentExec;
let terminals: AgentTerminals;
let ttyRunner: DockerAgentTty;
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
    // An interactive shell stands in for the Claude CLI, which would ask to log in.
    ttyRunner = new DockerAgentTty(
      docker,
      { uidMin: config.agentUidRange.min, uidMax: config.agentUidRange.max, gid: config.agentUidRange.gid },
      ['/bin/bash', '--noprofile', '--norc', '-i'],
    );
    terminals = new AgentTerminals(ttyRunner);
    app = await buildApp({ runtime, tokens, apiKey: config.apiKey, agentExec, terminals });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    baseUrl = `127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    if (terminals) await terminals.shutdown().catch(() => undefined);
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

  /**
   * A member's own Claude terminal (D-045), through the real route and a real
   * container: the pty runs as the member's uid with their private HOME, everyone can
   * watch it, only its member can type, what it writes into the project stays
   * writable for the others, and stopping it ends its process tree.
   */
  it(
    'runs each member’s terminal as their own uid, lets only them type, and shares the project',
    async () => {
      const container = docker.getContainer(`notea-ws-${workspaceId}`);
      const andrej = { userId: 'u-andrej', name: 'Andrej', email: 'andrej@example.test', uid: 20_003 };
      const niche = { userId: 'u-niche', name: 'Niche', email: 'niche@example.test', uid: 20_004 };

      const open = async (viewer: { userId: string; name: string }, owner: typeof andrej) => {
        const response = await fetch(`http://${baseUrl}/agent-terminal-tokens`, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, userId: viewer.userId, name: viewer.name, role: 'editor', owner }),
        });
        expect(response.status).toBe(200);
        const issued = (await response.json()) as IssueAgentTerminalTokenResponse;
        return TerminalSocket.open(`ws://${baseUrl}${issued.wsPath}?token=${encodeURIComponent(issued.token)}`);
      };

      const own = await open(andrej, andrej);
      const watcher = await open(niche, andrej);
      expect((await own.hello()).canInput).toBe(true);
      const watcherHello = await watcher.hello();
      expect(watcherHello.canInput).toBe(false);
      expect(watcherHello.terminal.status).toBe('idle');

      // A viewer cannot start someone else's terminal.
      watcher.send({ type: 'start', cols: 100, rows: 30 });
      expect((await watcher.nextOfType('error')).message).toMatch(/Only Andrej can type/);

      own.send({ type: 'start', cols: 100, rows: 30 });
      await own.until((m) => m.type === 'state' && m.terminal.status === 'running');

      const done = `NOTEA_TERM_DONE_${randomBytes(3).toString('hex')}`;
      own.send({
        type: 'input',
        data: `id -u; echo "HOME=$HOME"; umask; stat -c '%a %U' /home/dev/project; env | grep -c NOTEA_AGENT_TOKEN; echo hi > from-andrej.txt; stat -c '%a %u %G' from-andrej.txt; echo "tty=$(tty) pgid=$(ps -o pgid= -p $$) tpgid=$(ps -o tpgid= -p $$)"; echo ${done.slice(0, 8)}"${done.slice(8)}"\r`,
      });
      const transcript = plain(await own.output((text) => text.includes(`${done}\r\n`)));
      expect(transcript).toMatch(/\n20003\n/);
      expect(transcript).toContain('HOME=/home/dev/.notea/agents/20003\n');
      expect(transcript).toContain('\n0002\n');
      // The share step made the project group-writable and setgid.
      expect(transcript).toContain('\n2775 dev\n');
      // The workspace agent's token is not in a member's environment.
      expect(transcript).toMatch(/\n0\n/);
      expect(transcript).toContain('\n664 20003 dev\n');
      // The pty is the shell's controlling terminal and it is in the foreground:
      // resizes reach it as SIGWINCH.
      const [, pgid, tpgid] = /tty=\/dev\/pts\/\d+ pgid= *(\d+) tpgid= *(\d+)/.exec(transcript) ?? [];
      expect(pgid).toBeDefined();
      expect(tpgid).toBe(pgid);
      // The watcher saw the same output, live.
      expect(plain(await watcher.output((text) => text.includes(`${done}\r\n`)))).toContain('664 20003 dev');

      // The watcher's keystrokes go nowhere.
      watcher.send({ type: 'input', data: 'touch /tmp/watcher-typed-this\r' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await runAs(container, 1000, 'ls /tmp/watcher-typed-this 2>&1 || true')).toMatch(/No such file/);

      // Niche's own terminal edits the file Andrej's created: the project is shared.
      const nicheOwn = await open(niche, niche);
      await nicheOwn.hello();
      nicheOwn.send({ type: 'start', cols: 100, rows: 30 });
      await nicheOwn.until((m) => m.type === 'state' && m.terminal.status === 'running');
      const nicheDone = `NOTEA_NICHE_DONE_${randomBytes(3).toString('hex')}`;
      nicheOwn.send({ type: 'input', data: `id -u; echo more >> from-andrej.txt && echo appended; echo ${nicheDone.slice(0, 8)}"${nicheDone.slice(8)}"\r` });
      const nicheTranscript = plain(await nicheOwn.output((text) => text.includes(`${nicheDone}\r\n`)));
      expect(nicheTranscript).toMatch(/\n20004\n/);
      expect(nicheTranscript).toContain('\nappended\n');
      expect(await runAs(container, 1000, 'cat /home/dev/project/from-andrej.txt')).toBe('hi\nmore\n');
      // …but not Andrej's private HOME, where his CLI keeps its login.
      expect(await runAs(container, niche.uid, 'ls /home/dev/.notea/agents/20003 2>&1 || true')).toMatch(/Permission denied/);

      // Someone who opens the terminal later gets what is on it.
      const late = await open({ userId: 'u-late', name: 'Late' }, andrej);
      const lateHello = await late.hello();
      expect(lateHello.terminal.status).toBe('running');
      expect(lateHello.screen).toContain('664 20003 dev');

      // Stopping ends the shell and whatever it started.
      own.send({ type: 'input', data: 'sleep 600 &\r' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      own.send({ type: 'stop' });
      await own.until((m) => m.type === 'state' && m.terminal.status === 'exited');
      // The stop script itself runs as the member until the last process is gone.
      await eventually(async () => expect((await runAs(container, 1000, 'pgrep -u 20003 -a || true')).trim()).toBe(''));

      // A terminal whose orchestrator went away is ended before a new one starts: a
      // second manager (a restarted orchestrator) starting Niche's must not leave two.
      const restarted = new AgentTerminals(ttyRunner);
      await restarted.start(workspaceId, container.id, { uid: niche.uid, name: niche.name, email: niche.email }, { cols: 80, rows: 24 });
      await nicheOwn.until((m) => m.type === 'state' && m.terminal.status === 'exited');
      // The new one's wrapper hands over to bash a moment after the exec starts.
      await eventually(async () => expect((await runAs(container, 1000, 'pgrep -u 20004 -x bash | wc -l')).trim()).toBe('1'));
      await restarted.shutdown();
      await eventually(async () => expect((await runAs(container, 1000, 'pgrep -u 20004 -a || true')).trim()).toBe(''));

      for (const socket of [own, watcher, nicheOwn, late]) socket.close();
      await runAs(container, 1000, 'rm -f /home/dev/project/from-andrej.txt');
    },
    180_000,
  );
});

/** Retries an assertion for a few seconds: processes take a moment to go. */
async function eventually(assertion: () => Promise<void>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** Terminal output as plain lines: no escape sequences, `\n` line ends. */
function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r+\n/g, '\n').replace(/\r/g, '');
}

/** A client of the agent-terminal route that queues what it receives. */
class TerminalSocket {
  private readonly queue: AgentTerminalServerMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  private text = '';

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as AgentTerminalServerMessage;
      if (message.type === 'output') this.text += message.data;
      this.queue.push(message);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static async open(url: string): Promise<TerminalSocket> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new TerminalSocket(ws);
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }

  async hello(): Promise<Extract<AgentTerminalServerMessage, { type: 'hello' }>> {
    return (await this.until((m) => m.type === 'hello')) as Extract<AgentTerminalServerMessage, { type: 'hello' }>;
  }

  async nextOfType<T extends AgentTerminalServerMessage['type']>(type: T): Promise<Extract<AgentTerminalServerMessage, { type: T }>> {
    return (await this.until((m) => m.type === type)) as Extract<AgentTerminalServerMessage, { type: T }>;
  }

  /** Consumes messages until one matches. */
  async until(predicate: (m: AgentTerminalServerMessage) => boolean, timeoutMs = 30_000): Promise<AgentTerminalServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.queue.findIndex(predicate);
      if (index !== -1) return this.queue.splice(0, index + 1).at(-1)!;
      this.queue.length = 0;
      if (Date.now() > deadline) throw new Error('timeout waiting for a terminal message');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Everything printed so far, once it satisfies `predicate`. */
  async output(predicate: (text: string) => boolean, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.text)) {
      if (Date.now() > deadline) throw new Error(`timeout; terminal showed: ${JSON.stringify(this.text.slice(-500))}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.text;
  }
}

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
