/**
 * Workspace agent entry point. Runs as PID 1's child inside every workspace
 * container. Configuration comes from environment variables set by the orchestrator.
 */
import { promises as fsp } from 'node:fs';
import { DEFAULT_AGENT_PORT } from '@notea/protocol';
import { FsService } from './fs-service';
import { AgentHub } from './hub';
import { createLogger, type LogLevel } from './logger';
import { ProcessManager, createNodeProcessFactory } from './process-manager';
import { createNodePtyFactory } from './pty';
import { createAgentServer } from './server';
import { SessionManager } from './session-manager';

export const AGENT_VERSION = '0.0.1';

interface AgentConfig {
  port: number;
  token: string;
  workspaceId: string;
  projectDir: string;
  shell: string;
  maxSessions: number;
  scrollbackBytes: number;
  logLevel: LogLevel;
}

function readConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const token = env.NOTEA_AGENT_TOKEN;
  if (!token || token.length < 16) {
    throw new Error('NOTEA_AGENT_TOKEN must be set to a secret of at least 16 characters');
  }
  const port = Number(env.NOTEA_AGENT_PORT ?? DEFAULT_AGENT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`NOTEA_AGENT_PORT is invalid: ${env.NOTEA_AGENT_PORT}`);
  }
  return {
    port,
    token,
    workspaceId: env.NOTEA_WORKSPACE_ID ?? 'unknown',
    projectDir: env.NOTEA_PROJECT_DIR ?? `${env.HOME ?? '/home/dev'}/project`,
    shell: env.NOTEA_SHELL ?? env.SHELL ?? '/bin/bash',
    maxSessions: Number(env.NOTEA_MAX_SESSIONS ?? 32),
    scrollbackBytes: Number(env.NOTEA_SCROLLBACK_BYTES ?? 256 * 1024),
    logLevel: (env.NOTEA_LOG_LEVEL as LogLevel | undefined) ?? 'info',
  };
}

/** Environment handed to every terminal: the agent's own environment minus secrets. */
function terminalEnv(env: NodeJS.ProcessEnv, config: AgentConfig): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === 'NOTEA_AGENT_TOKEN') continue;
    result[key] = value;
  }
  result.TERM = 'xterm-256color';
  result.COLORTERM = 'truecolor';
  result.NOTEA_WORKSPACE_ID = config.workspaceId;
  result.NOTEA_PROJECT_DIR = config.projectDir;
  return result;
}

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const log = createLogger(config.logLevel, { component: 'workspace-agent', workspaceId: config.workspaceId });

  await fsp.mkdir(config.projectDir, { recursive: true });

  const sessions = new SessionManager({
    spawn: await createNodePtyFactory(),
    defaultCwd: config.projectDir,
    defaultCommand: config.shell,
    defaultArgs: ['-l'],
    env: terminalEnv(process.env, config),
    maxSessions: config.maxSessions,
    scrollbackBytes: config.scrollbackBytes,
  });
  const fs = new FsService(config.projectDir);
  const processes = new ProcessManager({
    spawn: createNodeProcessFactory(),
    defaultCwd: config.projectDir,
    baseEnv: terminalEnv(process.env, config),
    maxProcesses: 16,
    maxOutputBytes: 8 * 1024 * 1024,
    defaultTimeoutMs: 10 * 60 * 1000,
  });
  const hub = new AgentHub({
    sessions,
    processes,
    fs,
    workspaceId: config.workspaceId,
    projectDir: config.projectDir,
    agentVersion: AGENT_VERSION,
    log,
  });
  const server = createAgentServer({
    port: config.port,
    token: config.token,
    hub,
    log,
    workspaceId: config.workspaceId,
    agentVersion: AGENT_VERSION,
  });

  const { port } = await server.listen();
  log.info('workspace agent listening', { port, projectDir: config.projectDir, shell: config.shell });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    sessions.dispose();
    processes.dispose();
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`workspace agent failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
