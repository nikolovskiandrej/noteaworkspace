import { describe, expect, it } from 'vitest';
import { EXEC_WRAPPER, agentHomePath } from '../src/docker/agent-exec';
import {
  AGENT_TERMINAL_MARKER,
  PROJECT_DIR,
  SHARE_PROJECT_SCRIPT,
  STOP_TERMINAL_SCRIPT,
  buildAgentTerminalExecOptions,
} from '../src/docker/agent-terminal';
import { RuntimeError } from '../src/errors';

const limits = { uidMin: 20_001, uidMax: 29_999, gid: 1000 };
const andrej = { uid: 20_003, name: 'Andrej', email: 'andrej@notea.mk' };

describe('buildAgentTerminalExecOptions', () => {
  it('runs the CLI as the member, in the project, through the agent wrapper, with a pty', () => {
    const options = buildAgentTerminalExecOptions(andrej, limits, { cols: 120, rows: 40 });
    expect(options.User).toBe('20003:1000');
    expect(options.WorkingDir).toBe(PROJECT_DIR);
    // No setsid: the pty must stay the process's controlling terminal, or resizes never reach it.
    expect(options.Cmd).toEqual(['/bin/sh', '-c', EXEC_WRAPPER, 'notea-agent-terminal', 'claude']);
    expect(options).toMatchObject({ Tty: true, AttachStdin: true, AttachStdout: true, ConsoleSize: [40, 120] });
  });

  it('gives it the member’s private HOME, the marker, git’s exception and their commit identity', () => {
    const env = buildAgentTerminalExecOptions(andrej, limits, { cols: 80, rows: 24 }).Env ?? [];
    expect(env).toContain(`NOTEA_EXEC_HOME=${agentHomePath(20_003)}`);
    expect(env).toContain(AGENT_TERMINAL_MARKER);
    expect(env).toContain('TERM=xterm-256color');
    expect(env).toEqual(expect.arrayContaining(['GIT_CONFIG_COUNT=1', 'GIT_CONFIG_KEY_0=safe.directory', 'GIT_CONFIG_VALUE_0=*']));
    expect(env).toEqual(expect.arrayContaining(['GIT_AUTHOR_NAME=Andrej', 'GIT_AUTHOR_EMAIL=andrej@notea.mk', 'GIT_COMMITTER_NAME=Andrej']));
    // Nothing that carries a credential: the CLI logs in by itself, into its HOME.
    expect(env.some((entry) => /API_KEY|_TOKEN=|NOTEA_EXEC_UNSET/.test(entry))).toBe(false);
  });

  it('refuses uids outside the agent range: never root, never dev', () => {
    for (const uid of [0, 1000, 20_000, 30_000, 20_003.5, Number.NaN]) {
      expect(() => buildAgentTerminalExecOptions({ ...andrej, uid }, limits, { cols: 80, rows: 24 })).toThrow(RuntimeError);
    }
  });

  it('keeps control characters out of the environment and clamps the size', () => {
    const options = buildAgentTerminalExecOptions({ uid: 20_004, name: 'Niche\nEVIL=1', email: '\u0000' }, limits, { cols: 5000, rows: 1 });
    const env = options.Env ?? [];
    expect(env).toContain('GIT_AUTHOR_NAME=Niche EVIL=1');
    expect(env).toContain('GIT_AUTHOR_EMAIL=member-20004@notea.local');
    expect(options.ConsoleSize).toEqual([4, 500]);
  });

  it('uses the command it is given (tests run a shell instead of the CLI)', () => {
    const options = buildAgentTerminalExecOptions(andrej, limits, { cols: 80, rows: 24 }, ['/bin/bash', '-i']);
    expect(options.Cmd?.slice(-2)).toEqual(['/bin/bash', '-i']);
  });
});

describe('terminal scripts', () => {
  it('shares only what dev owns, and trusts the project repository', () => {
    expect(SHARE_PROJECT_SCRIPT).toContain('find "$project" -user "$(id -u)" -type d');
    expect(SHARE_PROJECT_SCRIPT).toContain('chmod g+rwxs');
    expect(SHARE_PROJECT_SCRIPT).toContain("git config --global --add safe.directory '*'");
    // Nothing is granted to "other".
    expect(SHARE_PROJECT_SCRIPT).not.toMatch(/o\+|a\+|777/);
  });

  it('stops only processes that carry the marker, and takes no input', () => {
    expect(STOP_TERMINAL_SCRIPT).toContain(`grep -qxF '${AGENT_TERMINAL_MARKER}'`);
    expect(STOP_TERMINAL_SCRIPT).toContain('kill -HUP $pids');
    expect(STOP_TERMINAL_SCRIPT).toContain('kill -KILL $alive');
    expect(STOP_TERMINAL_SCRIPT).not.toContain('$1');
  });
});
