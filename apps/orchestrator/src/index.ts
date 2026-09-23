import { existsSync } from 'node:fs';
import path from 'node:path';
import Docker from 'dockerode';
import type { FastifyInstance } from 'fastify';
import { AgentTerminals } from './agent-terminals';
import { buildApp } from './app';
import { loadConfig } from './config';
import { DockerAgentExec } from './docker/agent-exec';
import { DockerAgentTty } from './docker/agent-terminal';
import { WorkspaceRuntime } from './docker/workspace-runtime';
import { TokenService } from './tokens';

// Load a repository-root `.env` when present (Node 24 built-in, no dependency).
for (const candidate of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const docker = new Docker(config.dockerSocketPath ? { socketPath: config.dockerSocketPath } : undefined);
  const tokens = new TokenService({
    connectTokenSecret: config.connectTokenSecret,
    agentTokenSecret: config.agentTokenSecret,
    defaultTtlSeconds: config.connectTokenTtlSeconds,
    maxTtlSeconds: config.connectTokenMaxTtlSeconds,
  });

  // The runtime logs through the Fastify logger, which only exists once the app is
  // built; bind lazily to avoid a second logger instance.
  let app: FastifyInstance | undefined;
  const runtime = new WorkspaceRuntime(docker, {
    image: config.workspaceImage,
    network: config.workspaceNetwork,
    agentPort: config.agentPort,
    publishAgentPort: config.agentConnectMode === 'published',
    defaultResources: config.defaultResources,
    agentTokenFor: (workspaceId) => tokens.agentToken(workspaceId),
    log: {
      info: (obj, msg) => app?.log.info(obj, msg),
      warn: (obj, msg) => app?.log.warn(obj, msg),
    },
  });
  const uidLimits = { uidMin: config.agentUidRange.min, uidMax: config.agentUidRange.max, gid: config.agentUidRange.gid };
  const terminals = new AgentTerminals(new DockerAgentTty(docker, uidLimits), {
    log: {
      info: (obj, msg) => app?.log.info(obj, msg),
      warn: (obj, msg) => app?.log.warn(obj, msg),
    },
  });
  app = await buildApp({
    runtime,
    tokens,
    apiKey: config.apiKey,
    agentExec: new DockerAgentExec(docker, uidLimits),
    terminals,
    logger: { level: config.logLevel },
    devConsole: config.devConsole,
  });

  const dockerVersion = await docker.version().catch((err: Error) => {
    throw new Error(`cannot reach Docker: ${err.message}`);
  });
  app.log.info(
    { dockerVersion: dockerVersion.Version, image: config.workspaceImage, connectMode: config.agentConnectMode },
    'orchestrator starting',
  );

  await app.listen({ port: config.port, host: config.host });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app?.log.info({ signal }, 'shutting down');
    // Members' Claude terminals cannot be re-attached by the next process; end them
    // rather than leave them running unwatched.
    await terminals.shutdown().catch(() => undefined);
    await app?.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`orchestrator failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
