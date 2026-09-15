import { z } from 'zod';
import { DEFAULT_AGENT_PORT } from '@notea/protocol';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /** Bearer token the control plane presents on the REST API. */
  ORCHESTRATOR_API_KEY: z.string().min(16, 'ORCHESTRATOR_API_KEY must be at least 16 characters'),
  /** HS256 secret for short-lived browser connect tokens. */
  CONNECT_TOKEN_SECRET: z.string().min(32, 'CONNECT_TOKEN_SECRET must be at least 32 characters'),
  /** HMAC base for per-workspace agent tokens. Rotating it requires recreating containers. */
  AGENT_TOKEN_SECRET: z.string().min(32, 'AGENT_TOKEN_SECRET must be at least 32 characters'),

  /** Docker socket path. Leave unset to use dockerode's platform default / DOCKER_HOST. */
  DOCKER_SOCKET_PATH: z.string().optional(),
  WORKSPACE_IMAGE: z.string().default('notea/workspace:dev'),
  WORKSPACE_NETWORK: z.string().default('notea-workspaces'),
  /**
   * How the orchestrator reaches the agent inside a container.
   *  - network:   connect to the container IP on the workspace network (orchestrator runs on Linux
   *               or inside Docker).
   *  - published: publish the agent port on 127.0.0.1 with a random host port (Docker Desktop on
   *               Windows/macOS cannot route to container IPs from the host).
   *  - auto:      network on linux, published elsewhere.
   */
  AGENT_CONNECT_MODE: z.enum(['auto', 'network', 'published']).default('auto'),
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_AGENT_PORT),

  WORKSPACE_DEFAULT_CPUS: z.coerce.number().positive().default(2),
  WORKSPACE_DEFAULT_MEMORY_MB: z.coerce.number().int().positive().default(4096),
  WORKSPACE_DEFAULT_PIDS_LIMIT: z.coerce.number().int().positive().default(2048),

  CONNECT_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  CONNECT_TOKEN_MAX_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
});

export interface OrchestratorConfig {
  port: number;
  host: string;
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  apiKey: string;
  connectTokenSecret: string;
  agentTokenSecret: string;
  dockerSocketPath: string | undefined;
  workspaceImage: string;
  workspaceNetwork: string;
  agentConnectMode: 'network' | 'published';
  agentPort: number;
  defaultResources: { cpus: number; memoryMb: number; pidsLimit: number };
  connectTokenTtlSeconds: number;
  connectTokenMaxTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): OrchestratorConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`invalid orchestrator configuration:\n  ${details}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    apiKey: e.ORCHESTRATOR_API_KEY,
    connectTokenSecret: e.CONNECT_TOKEN_SECRET,
    agentTokenSecret: e.AGENT_TOKEN_SECRET,
    dockerSocketPath: e.DOCKER_SOCKET_PATH,
    workspaceImage: e.WORKSPACE_IMAGE,
    workspaceNetwork: e.WORKSPACE_NETWORK,
    agentConnectMode:
      e.AGENT_CONNECT_MODE === 'auto' ? (platform === 'linux' ? 'network' : 'published') : e.AGENT_CONNECT_MODE,
    agentPort: e.AGENT_PORT,
    defaultResources: {
      cpus: e.WORKSPACE_DEFAULT_CPUS,
      memoryMb: e.WORKSPACE_DEFAULT_MEMORY_MB,
      pidsLimit: e.WORKSPACE_DEFAULT_PIDS_LIMIT,
    },
    connectTokenTtlSeconds: e.CONNECT_TOKEN_TTL_SECONDS,
    connectTokenMaxTtlSeconds: e.CONNECT_TOKEN_MAX_TTL_SECONDS,
  };
}
