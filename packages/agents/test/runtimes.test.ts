import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClientIdentity } from '@notea/protocol';
import { AgentHub, FsService, ProcessManager, SessionManager, createAgentServer, silentLogger, type AgentServer } from '@notea/workspace-agent';
import { fakeProcessFactory, fakePtyFactory, type FakeProcess, type FakePty } from '@notea/workspace-agent/testing';
import { WorkspaceClient } from '@notea/workspace-client';
import { ClaudeCodeRuntime, parseClaudeStreamLine } from '../src/runtimes/claude-code';
import { createRuntimeRegistry } from '../src/runtimes/index';
import type { AgentRunContext, AgentRunEvent } from '../src/types';
import { ClientWorkspaceSession } from '../src/workspace-session';

const TOKEN = 'agents-test-token-1234567890';
const identity: ClientIdentity = { id: 'conn-agent', userId: 'agent-1', name: 'Claude (task t1)', kind: 'agent', role: 'editor' };

function identifyingWebSocket(): typeof WebSocket {
  return class extends WebSocket {
    constructor(url: string | URL) {
      super(url);
      this.addEventListener('open', () => super.send(JSON.stringify({ type: 'identify', client: identity })), { once: true });
    }
  };
}

let server: AgentServer;
let port: number;
let ptys: FakePty[];
let procs: FakeProcess[];
let projectDir: string;

beforeEach(async () => {
  projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notea-agents-'));
  const pty = fakePtyFactory();
  ptys = pty.spawned;
  const proc = fakeProcessFactory();
  procs = proc.spawned;
  let counter = 0;
  const sessions = new SessionManager({
    spawn: pty.factory,
    defaultCwd: projectDir,
    defaultCommand: '/bin/bash',
    defaultArgs: ['-l'],
    env: {},
    maxSessions: 4,
    scrollbackBytes: 4096,
    idGenerator: () => `s${++counter}`,
  });
  const processes = new ProcessManager({
    spawn: proc.factory,
    defaultCwd: projectDir,
    baseEnv: {},
    maxProcesses: 4,
    maxOutputBytes: 1024 * 1024,
    defaultTimeoutMs: 60_000,
  });
  const hub = new AgentHub({ sessions, processes, fs: new FsService(projectDir), workspaceId: 'ws', projectDir, agentVersion: 'test', log: silentLogger });
  server = createAgentServer({ port: 0, host: '127.0.0.1', token: TOKEN, hub, log: silentLogger, workspaceId: 'ws', agentVersion: 'test' });
  port = (await server.listen()).port;
});

afterEach(async () => {
  await server.close();
  await fsp.rm(projectDir, { recursive: true, force: true });
});

const ctx: AgentRunContext = {
  workspaceId: 'ws',
  taskId: 't1',
  runId: 'r1',
  worktreePath: '/home/dev/.notea/worktrees/t1',
  branch: 'notea/task/t1',
  brief: '# Task: do things',
  model: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
  credentialEnv: { ANTHROPIC_API_KEY: 'sk-test' },
  identity,
  limits: { maxMinutes: 5, maxTurns: 20 },
};

describe('parseClaudeStreamLine', () => {
  it('maps assistant text, tool calls, file edits and results', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Working on it' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/home/dev/.notea/worktrees/t1/src/a.ts', old_string: 'a', new_string: 'b' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    });
    const events = parseClaudeStreamLine(assistant);
    expect(events.map((e) => e.type)).toEqual(['message', 'tool_call', 'file_changed', 'tool_call']);

    const result = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.', total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 5 } }),
    );
    expect(result).toMatchObject([
      { type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.12 },
      { type: 'finished', outcome: 'completed', summary: 'Done.' },
    ]);
    expect(parseClaudeStreamLine('plain text line')).toMatchObject([{ type: 'log', text: 'plain text line' }]);
    expect(parseClaudeStreamLine('{not json')).toMatchObject([{ type: 'log' }]);
    expect(parseClaudeStreamLine('')).toEqual([]);
  });
});

describe('ClaudeCodeRuntime', () => {
  it('builds a headless command line', () => {
    const runtime = new ClaudeCodeRuntime();
    const command = runtime.buildCommandLine(ctx, '/home/dev/.notea/runs/r1/brief.md');
    expect(command).toBe(
      `cd '/home/dev/.notea/worktrees/t1' && claude -p "$(cat '/home/dev/.notea/runs/r1/brief.md')" --output-format stream-json --verbose --model 'claude-sonnet-5' --max-turns 20 --dangerously-skip-permissions`,
    );
    expect(new ClaudeCodeRuntime({ permissionMode: 'acceptEdits' }).buildCommandLine({ ...ctx, model: null, limits: { maxMinutes: 1 } }, '/b')).toContain(
      '--permission-mode acceptEdits',
    );
    expect(runtime.supports({ provider: 'openai', modelId: 'x' })).toBe(false);
  });

  it('runs in a workspace terminal, writes the brief, streams events and finishes', async () => {
    const client = new WorkspaceClient({ url: `ws://127.0.0.1:${port}/ws?token=${TOKEN}`, WebSocketImpl: identifyingWebSocket() });
    await client.waitForHello();
    const session = new ClientWorkspaceSession(client);
    const runtime = new ClaudeCodeRuntime();

    const startPromise = runtime.start(ctx, session);
    // The brief is written through an exec (`cat > file`); complete it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(procs[0]?.options.args?.[1]).toContain(`cat > '/home/dev/.notea/runs/r1/brief.md'`);
    expect(procs[0]?.stdin.join('')).toBe('# Task: do things');
    procs[0]?.emitExit(0);
    const handle = await startPromise;

    expect(ptys[0]?.options.command).toBe('/bin/bash');
    expect(ptys[0]?.options.args[1]).toContain('claude -p');
    expect(ptys[0]?.options.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(ptys[0]?.options.cwd).toBe('/home/dev/.notea/worktrees/t1');

    const collected: AgentRunEvent[] = [];
    const consume = (async () => {
      for await (const event of handle.events) collected.push(event);
    })();

    ptys[0]?.emitData(JSON.stringify({ type: 'system', subtype: 'init' }) + '\r\n');
    ptys[0]?.emitData(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }) + '\r\n');
    ptys[0]?.emitData(JSON.stringify({ type: 'result', subtype: 'success', result: 'All done', total_cost_usd: 0.5 }).slice(0, 20));
    ptys[0]?.emitData(JSON.stringify({ type: 'result', subtype: 'success', result: 'All done', total_cost_usd: 0.5 }).slice(20) + '\r\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    ptys[0]?.emitExit(0);
    await consume;

    expect(collected.map((e) => e.type)).toEqual(['started', 'log', 'message', 'usage', 'finished', 'log']);
    expect(collected.find((e) => e.type === 'finished')).toMatchObject({ outcome: 'completed', summary: 'All done' });
    client.close();
  });

  it('reports cancellation when the run is interrupted', async () => {
    const client = new WorkspaceClient({ url: `ws://127.0.0.1:${port}/ws?token=${TOKEN}`, WebSocketImpl: identifyingWebSocket() });
    await client.waitForHello();
    const runtime = createRuntimeRegistry().get('generic-cli')!;
    const startPromise = runtime.start({ ...ctx, model: null, command: 'sleep 1000' }, new ClientWorkspaceSession(client));
    await new Promise((resolve) => setTimeout(resolve, 50));
    procs[0]?.emitExit(0);
    const handle = await startPromise;
    const collected: AgentRunEvent[] = [];
    const consume = (async () => {
      for await (const event of handle.events) collected.push(event);
    })();
    await handle.cancel();
    await consume;
    expect(collected.at(-1)).toMatchObject({ type: 'finished', outcome: 'cancelled' });
    client.close();
  });
});
