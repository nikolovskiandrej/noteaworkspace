import { describe, expect, it } from 'vitest';
import type { AgentExecFrame, AgentExecRequest, AgentExecResult } from '@notea/protocol';
import {
  AGENT_GIT_ENV,
  IsolatedAgentSession,
  allCredentialEnvNames,
  authModesFor,
  conflictingEnvNames,
  credentialEnv,
  describeAuthStatus,
  parseClaudeAuthStatus,
  sharedLayoutScript,
  type AuthMode,
} from '../src/index';

const SECRET = 'sk-ant-oat01-SECRET-VALUE-DO-NOT-LEAK';
const API_KEY = 'sk-ant-api03-SECRET-KEY-DO-NOT-LEAK';
const PATHS = { projectDir: '/home/dev/project', worktreesDir: '/home/dev/.notea/worktrees' };

/** Records every exec request and replays canned frames. */
class FakeTransport {
  readonly requests: Array<{ workspaceId: string; request: AgentExecRequest }> = [];
  killed = 0;

  constructor(private readonly frames: AgentExecFrame[] = [{ type: 'exit', exitCode: 0, timedOut: false }]) {}

  async agentExec(workspaceId: string, request: AgentExecRequest): Promise<AgentExecResult> {
    this.requests.push({ workspaceId, request });
    return { execId: 'exec-1', exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false };
  }

  async agentExecStream(workspaceId: string, request: AgentExecRequest) {
    this.requests.push({ workspaceId, request });
    const frames = this.frames;
    return {
      execId: 'exec-stream',
      frames: {
        async *[Symbol.asyncIterator]() {
          for (const frame of frames) yield frame;
        },
      },
      kill: async () => {
        this.killed += 1;
      },
    };
  }
}

describe('credential environment (one mode, never two)', () => {
  it('emits exactly one variable per authentication mode', () => {
    expect(credentialEnv('anthropic', 'subscription', SECRET)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET });
    expect(credentialEnv('anthropic', 'api_key', API_KEY)).toEqual({ ANTHROPIC_API_KEY: API_KEY });
    expect(Object.keys(credentialEnv('openai', 'api_key', 'x'))).toEqual(['OPENAI_API_KEY']);
  });

  it('refuses a mode the provider does not support', () => {
    // Only Anthropic has a subscription mode today; claiming one for another provider
    // would silently produce an environment no CLI reads.
    expect(() => credentialEnv('openai', 'subscription', 'x')).toThrow(/does not support/);
    expect(authModesFor('google').map((m) => m.id)).toEqual(['api_key']);
  });

  it('names the other modes so a run can clear them', () => {
    // A subscription run must not be able to fall back to a stray API key.
    expect(conflictingEnvNames('anthropic', 'subscription')).toContain('ANTHROPIC_API_KEY');
    expect(conflictingEnvNames('anthropic', 'subscription')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(conflictingEnvNames('anthropic', 'api_key')).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(allCredentialEnvNames()).toEqual(
      expect.arrayContaining(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']),
    );
  });
});

describe('IsolatedAgentSession', () => {
  it('runs every process as the owning member, and clears the credentials it is not given', async () => {
    const transport = new FakeTransport();
    const session = new IsolatedAgentSession(transport, { workspaceId: 'ws-1', uid: 20003 });

    await session.createTerminal({
      cols: 80,
      rows: 24,
      command: '/bin/bash',
      args: ['-lc', 'claude -p "hi"'],
      cwd: '/home/dev/.notea/worktrees/t1',
      title: 'agent: Claude',
      env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET },
      timeoutMs: 60_000,
    });

    const { request } = transport.requests[0]!;
    expect(request.uid).toBe(20003);
    expect(request.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(SECRET);
    // The other billing mode is removed from the inherited environment.
    expect(request.unsetEnv).toContain('ANTHROPIC_API_KEY');
    expect(request.unsetEnv).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    // git needs the ownership exception because the repository belongs to `dev`.
    expect(request.env).toMatchObject(AGENT_GIT_ENV);
    expect(request.cmd).toEqual(['/bin/bash', '-lc', 'claude -p "hi"']);
  });

  it('scrubs every credential variable from runs that were given none', async () => {
    const transport = new FakeTransport();
    const session = new IsolatedAgentSession(transport, { workspaceId: 'ws-1', uid: 20004 });
    await session.run('git status --porcelain', { cwd: '/home/dev/project' });
    const { request } = transport.requests[0]!;
    expect(request.uid).toBe(20004);
    expect(request.unsetEnv).toEqual(expect.arrayContaining(allCredentialEnvNames()));
    expect(JSON.stringify(request.env)).not.toContain('sk-ant');
  });

  it('buffers output produced before the consumer attaches, and always reports an exit', async () => {
    const transport = new FakeTransport([
      { type: 'out', data: 'line one\n' },
      { type: 'err', data: 'line two\n' },
      { type: 'exit', exitCode: 7, timedOut: false },
    ]);
    const session = new IsolatedAgentSession(transport, { workspaceId: 'ws-1', uid: 20003 });
    const { sessionId } = await session.createTerminal({ cols: 80, rows: 24, command: 'x', args: [], cwd: '/', title: 't' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const seen: string[] = [];
    session.onTerminalOutput(sessionId, (data) => seen.push(data));
    expect(seen.join('')).toBe('line one\nline two\n');

    // The stream already finished: a late listener still learns the exit code, so a
    // run started just before the process died cannot wait forever.
    const exits: (number | null)[] = [];
    session.onTerminalExit(sessionId, (code) => exits.push(code));
    expect(exits).toEqual([7]);
  });

  it('writes run artefacts as the member, without putting content through a shell string', async () => {
    const transport = new FakeTransport();
    const session = new IsolatedAgentSession(transport, { workspaceId: 'ws-1', uid: 20003 });
    const brief = `a brief with 'quotes' and $(touch /tmp/pwned)`;
    await session.writeHostFile('/home/dev/.notea/runs/r1/brief.md', brief);
    const { request } = transport.requests[0]!;
    expect(request.uid).toBe(20003);
    expect(request.cmd[0]).toBe('/bin/sh');
    // The payload is base64 in argv, so the shell never sees the text itself.
    expect(request.cmd.join(' ')).not.toContain('touch /tmp/pwned');
    expect(Buffer.from(request.cmd[4]!, 'base64').toString('utf8')).toBe(brief);
    expect(request.cmd[5]).toBe('/home/dev/.notea/runs/r1/brief.md');
  });

  it('refuses a file too large for argv rather than truncating it', async () => {
    const session = new IsolatedAgentSession(new FakeTransport(), { workspaceId: 'ws-1', uid: 20003, maxFileBytes: 64 });
    await expect(session.writeHostFile('/tmp/x', 'y'.repeat(1000))).rejects.toThrow(/exceeds 64 bytes/);
  });
});

describe('shared project layout', () => {
  it('grants the shared group, and only the group, access to the repository', () => {
    const script = sharedLayoutScript(PATHS);
    expect(script).toContain('git config core.sharedRepository group');
    expect(script).toContain("chmod 2775 '/home/dev/.notea'");
    expect(script).toContain('chmod -R g+rwX .git');
    // `other` is never widened: the uid separation is what isolates members.
    expect(script).not.toMatch(/o\+[rwx]/);
    expect(script).not.toContain('chmod 777');
    // The expensive pass runs once per container.
    expect(script).toContain("if [ ! -e '.git/notea-shared-layout-v1' ]; then");
  });
});

describe('claude auth status', () => {
  const statusJson = (extra: Record<string, unknown>) =>
    JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', configDirectory: '/home/dev/.notea/agents/20003', ...extra });

  it('reads the authentication mode the CLI reports', () => {
    // Fixtures captured from claude-code 2.1.272 in the workspace image.
    expect(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toMatchObject({ loggedIn: false, authMethod: 'none' });
    expect(parseClaudeAuthStatus(statusJson({ authMethod: 'oauth_token' }))).toMatchObject({ authMethod: 'oauth_token' });
    expect(parseClaudeAuthStatus(statusJson({ authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }))).toMatchObject({
      apiKeySource: 'ANTHROPIC_API_KEY',
    });
    expect(parseClaudeAuthStatus('not json at all')).toBeNull();
  });

  it('flags a run that authenticated in a different billing mode than the user connected', () => {
    const subscription = parseClaudeAuthStatus(statusJson({ authMethod: 'oauth_token' }));
    const apiKey = parseClaudeAuthStatus(statusJson({ authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }));
    expect(describeAuthStatus(subscription, 'subscription')).toMatchObject({ ok: true, mode: 'subscription' });
    expect(describeAuthStatus(apiKey, 'subscription')).toMatchObject({ ok: false, mode: 'api_key' });
    expect(describeAuthStatus(apiKey, 'api_key' as AuthMode).summary).toContain('ANTHROPIC_API_KEY');
    expect(describeAuthStatus(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}'), null)).toMatchObject({ ok: false });
    expect(describeAuthStatus(null, null).ok).toBe(false);
  });
});
