import { describe, expect, it } from 'vitest';
import type { AgentExecRequest } from '@notea/protocol';
import {
  EXEC_WRAPPER,
  agentHomePath,
  buildAgentExecOptions,
  clampTimeout,
  pidFilePath,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
} from '../src/docker/agent-exec';
import { RuntimeError } from '../src/errors';

const LIMITS = { uidMin: 20_001, uidMax: 29_999, gid: 1000 };
const EXEC_ID = '11111111-2222-3333-4444-555555555555';
const base: AgentExecRequest = { uid: 20_003, cmd: ['/bin/bash', '-lc', 'claude -p hi'] };

const build = (request: Partial<AgentExecRequest>) => buildAgentExecOptions({ ...base, ...request }, LIMITS, EXEC_ID);

describe('buildAgentExecOptions', () => {
  it('runs as the requested uid with the orchestrator’s own gid', () => {
    const options = build({});
    expect(options.User).toBe('20003:1000');
    expect(options.Tty).toBe(false);
  });

  it('refuses every uid outside the agent range', () => {
    // Nothing the control plane can ask for reaches root or the `dev` user whose
    // shells the workspace's humans share; that separation is the isolation.
    for (const uid of [0, 1, 1000, 20_000, 30_000, -1, 1.5, Number.NaN]) {
      expect(() => build({ uid })).toThrow(RuntimeError);
      expect(() => build({ uid })).toThrow(/uid must be an integer/);
    }
    expect(build({ uid: 20_001 }).User).toBe('20001:1000');
    expect(build({ uid: 29_999 }).User).toBe('29999:1000');
  });

  it('passes the command as argv, never as a concatenated shell string', () => {
    const options = build({ cmd: ['/bin/echo', 'a b; rm -rf /', '$(whoami)'] });
    // The wrapper is a fixed script and the caller's argv is appended after it, so
    // there is no place where request data becomes shell syntax.
    expect(options.Cmd).toEqual(['setsid', '-w', '/bin/sh', '-c', EXEC_WRAPPER, 'notea-agent-exec', '/bin/echo', 'a b; rm -rf /', '$(whoami)']);
    expect(EXEC_WRAPPER).toContain('exec "$@"');
    expect(EXEC_WRAPPER).not.toContain('20003');
  });

  it('gives the uid a private HOME and records the process group for cancellation', () => {
    const env = build({}).Env ?? [];
    expect(env).toContain(`NOTEA_EXEC_HOME=${agentHomePath(20_003)}`);
    expect(agentHomePath(20_003)).toBe('/home/dev/.notea/agents/20003');
    expect(env).toContain(`NOTEA_EXEC_PIDFILE=${pidFilePath(EXEC_ID)}`);
    // HOME is created 0700, so one member's CLI login is unreadable by the others.
    expect(EXEC_WRAPPER).toContain('chmod 700 "$NOTEA_EXEC_HOME"');
    expect(EXEC_WRAPPER).toContain('umask 002');
  });

  it('sets the credential variables it is given and clears the ones it is not', () => {
    const options = build({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' }, unsetEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] });
    expect(options.Env).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x');
    expect(options.Env).toContain('NOTEA_EXEC_UNSET=ANTHROPIC_API_KEY OPENAI_API_KEY');
    expect(EXEC_WRAPPER).toContain('for __notea_v in ${NOTEA_EXEC_UNSET:-}; do unset "$__notea_v"; done');
    // The wrapper's own variables never reach the agent process.
    expect(EXEC_WRAPPER).toContain('unset NOTEA_EXEC_UNSET NOTEA_EXEC_PIDFILE NOTEA_EXEC_HOME __notea_v');
  });

  it('refuses environment names that would redirect the agent or its credentials', () => {
    for (const name of ['PATH', 'HOME', 'LD_PRELOAD', 'NOTEA_AGENT_TOKEN', 'NODE_OPTIONS', 'SHELL']) {
      expect(() => build({ env: { [name]: 'x' } })).toThrow(/reserved/);
      expect(() => build({ unsetEnv: [name] })).toThrow(/reserved/);
    }
    for (const name of ['lowercase', '1LEADING', 'WITH-DASH', 'WITH SPACE', '']) {
      expect(() => build({ env: { [name]: 'x' } })).toThrow(/invalid environment variable name/);
    }
  });

  it('rejects malformed commands and working directories', () => {
    expect(() => build({ cmd: [] })).toThrow(/argv array/);
    expect(() => build({ cmd: Array.from({ length: 65 }, () => 'x') })).toThrow(/argv array/);
    expect(() => build({ cwd: 'relative/path' })).toThrow(/absolute path/);
    expect(build({ cwd: '/home/dev/project' }).WorkingDir).toBe('/home/dev/project');
  });
});

describe('clampTimeout', () => {
  it('defaults and caps, so no exec can outlive the cap', () => {
    expect(clampTimeout(undefined)).toBe(DEFAULT_EXEC_TIMEOUT_MS);
    expect(clampTimeout(0)).toBe(DEFAULT_EXEC_TIMEOUT_MS);
    expect(clampTimeout(-5)).toBe(DEFAULT_EXEC_TIMEOUT_MS);
    expect(clampTimeout(5_000)).toBe(5_000);
    expect(clampTimeout(MAX_EXEC_TIMEOUT_MS * 10)).toBe(MAX_EXEC_TIMEOUT_MS);
  });
});
