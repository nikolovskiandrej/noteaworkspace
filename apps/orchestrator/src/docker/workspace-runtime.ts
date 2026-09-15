import type Docker from 'dockerode';
import { AGENT_HEALTH_PATH, type CreateWorkspaceRuntimeRequest, type WorkspaceResources, type WorkspaceRuntimeInfo, type WorkspaceRuntimeStatus } from '@notea/protocol';
import { RuntimeError, isDockerStatus } from '../errors';
import {
  IMAGE_LABEL,
  MANAGED_LABEL,
  WORKSPACE_ID_LABEL,
  WORKSPACE_ID_PATTERN,
  buildContainerSpec,
  containerName,
  volumeName,
} from './spec';

export interface AgentEndpoint {
  host: string;
  port: number;
}

export interface WorkspaceRuntimeApi {
  list(): Promise<WorkspaceRuntimeInfo[]>;
  create(request: CreateWorkspaceRuntimeRequest): Promise<WorkspaceRuntimeInfo>;
  inspect(workspaceId: string): Promise<WorkspaceRuntimeInfo | null>;
  start(workspaceId: string): Promise<WorkspaceRuntimeInfo>;
  stop(workspaceId: string): Promise<WorkspaceRuntimeInfo>;
  remove(workspaceId: string, options: { deleteVolume: boolean }): Promise<void>;
  agentEndpoint(workspaceId: string): Promise<AgentEndpoint | null>;
  waitForAgent(workspaceId: string, timeoutMs: number): Promise<AgentEndpoint>;
}

export interface WorkspaceRuntimeOptions {
  image: string;
  network: string;
  agentPort: number;
  publishAgentPort: boolean;
  defaultResources: WorkspaceResources;
  agentTokenFor: (workspaceId: string) => string;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  fetchImpl?: typeof fetch;
}

/**
 * Manages one Docker container + one named volume per workspace. Docker is the source
 * of truth for runtime state; nothing is cached here, so restarts of this service are
 * harmless. The control plane keeps the metadata (name, owner, members) elsewhere.
 */
export class WorkspaceRuntime implements WorkspaceRuntimeApi {
  private networkEnsured = false;

  constructor(
    private readonly docker: Docker,
    private readonly opts: WorkspaceRuntimeOptions,
  ) {}

  async list(): Promise<WorkspaceRuntimeInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=true`] },
    });
    const infos: WorkspaceRuntimeInfo[] = [];
    for (const summary of containers) {
      const workspaceId = summary.Labels?.[WORKSPACE_ID_LABEL];
      if (!workspaceId) continue;
      const info = await this.inspect(workspaceId);
      if (info) infos.push(info);
    }
    return infos;
  }

  async create(request: CreateWorkspaceRuntimeRequest): Promise<WorkspaceRuntimeInfo> {
    const workspaceId = validateWorkspaceId(request.workspaceId);
    if (await this.rawInspect(workspaceId)) {
      throw new RuntimeError(409, 'conflict', `workspace runtime ${workspaceId} already exists`);
    }
    await this.ensureNetwork();
    const volume = volumeName(workspaceId);
    await this.docker.createVolume({
      Name: volume,
      Labels: { [MANAGED_LABEL]: 'true', [WORKSPACE_ID_LABEL]: workspaceId },
    });
    const resources: WorkspaceResources = { ...this.opts.defaultResources, ...stripUndefined(request.resources ?? {}) };
    const spec = buildContainerSpec({
      workspaceId,
      image: request.image ?? this.opts.image,
      network: this.opts.network,
      agentToken: this.opts.agentTokenFor(workspaceId),
      agentPort: this.opts.agentPort,
      resources,
      publishAgentPort: this.opts.publishAgentPort,
    });
    this.opts.log.info({ workspaceId, image: spec.Image, resources }, 'creating workspace container');
    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(spec);
    } catch (err) {
      if (isDockerStatus(err, 404)) {
        throw new RuntimeError(
          400,
          'image_not_found',
          `image ${spec.Image} is not available; build it with \`npm run build:image\``,
        );
      }
      throw err;
    }
    if (request.start !== false) {
      await container.start();
    }
    return this.mustInspect(workspaceId);
  }

  async inspect(workspaceId: string): Promise<WorkspaceRuntimeInfo | null> {
    const raw = await this.rawInspect(validateWorkspaceId(workspaceId));
    return raw ? toInfo(workspaceId, raw) : null;
  }

  async start(workspaceId: string): Promise<WorkspaceRuntimeInfo> {
    const container = this.docker.getContainer(containerName(validateWorkspaceId(workspaceId)));
    try {
      await container.start();
    } catch (err) {
      if (isDockerStatus(err, 404)) throw notFound(workspaceId);
      if (!isDockerStatus(err, 304)) throw err; // 304: already running
    }
    return this.mustInspect(workspaceId);
  }

  async stop(workspaceId: string): Promise<WorkspaceRuntimeInfo> {
    const container = this.docker.getContainer(containerName(validateWorkspaceId(workspaceId)));
    try {
      await container.stop({ t: 10 });
    } catch (err) {
      if (isDockerStatus(err, 404)) throw notFound(workspaceId);
      if (!isDockerStatus(err, 304)) throw err; // 304: already stopped
    }
    return this.mustInspect(workspaceId);
  }

  async remove(workspaceId: string, options: { deleteVolume: boolean }): Promise<void> {
    validateWorkspaceId(workspaceId);
    const container = this.docker.getContainer(containerName(workspaceId));
    try {
      await container.remove({ force: true, v: false });
    } catch (err) {
      if (!isDockerStatus(err, 404)) throw err;
    }
    if (options.deleteVolume) {
      try {
        await this.docker.getVolume(volumeName(workspaceId)).remove();
      } catch (err) {
        if (!isDockerStatus(err, 404)) throw err;
      }
    }
    this.opts.log.info({ workspaceId, deleteVolume: options.deleteVolume }, 'removed workspace runtime');
  }

  async agentEndpoint(workspaceId: string): Promise<AgentEndpoint | null> {
    const raw = await this.rawInspect(validateWorkspaceId(workspaceId));
    if (!raw || raw.State.Status !== 'running') return null;
    const portKey = `${this.opts.agentPort}/tcp`;
    if (this.opts.publishAgentPort) {
      const binding = raw.NetworkSettings.Ports?.[portKey]?.[0];
      if (!binding?.HostPort) return null;
      return { host: '127.0.0.1', port: Number(binding.HostPort) };
    }
    const ip = raw.NetworkSettings.Networks?.[this.opts.network]?.IPAddress;
    if (!ip) return null;
    return { host: ip, port: this.opts.agentPort };
  }

  async waitForAgent(workspaceId: string, timeoutMs: number): Promise<AgentEndpoint> {
    const deadline = Date.now() + timeoutMs;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let lastError = 'container is not running';
    while (Date.now() < deadline) {
      const endpoint = await this.agentEndpoint(workspaceId);
      if (endpoint) {
        try {
          const response = await fetchImpl(`http://${endpoint.host}:${endpoint.port}${AGENT_HEALTH_PATH}`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) return endpoint;
          lastError = `agent health returned ${response.status}`;
        } catch (err) {
          lastError = (err as Error).message;
        }
      }
      await sleep(400);
    }
    throw new RuntimeError(504, 'agent_unreachable', `workspace agent did not become ready: ${lastError}`);
  }

  private async ensureNetwork(): Promise<void> {
    if (this.networkEnsured) return;
    const existing = await this.docker.listNetworks({ filters: { name: [this.opts.network] } });
    if (!existing.some((n) => n.Name === this.opts.network)) {
      this.opts.log.info({ network: this.opts.network }, 'creating workspace network');
      await this.docker.createNetwork({
        Name: this.opts.network,
        Driver: 'bridge',
        Labels: { [MANAGED_LABEL]: 'true' },
      });
    }
    this.networkEnsured = true;
  }

  private async rawInspect(workspaceId: string): Promise<Docker.ContainerInspectInfo | null> {
    try {
      return await this.docker.getContainer(containerName(workspaceId)).inspect();
    } catch (err) {
      if (isDockerStatus(err, 404)) return null;
      throw err;
    }
  }

  private async mustInspect(workspaceId: string): Promise<WorkspaceRuntimeInfo> {
    const info = await this.inspect(workspaceId);
    if (!info) throw notFound(workspaceId);
    return info;
  }
}

export function validateWorkspaceId(workspaceId: string): string {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new RuntimeError(400, 'bad_request', 'workspaceId must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}');
  }
  return workspaceId;
}

function notFound(workspaceId: string): RuntimeError {
  return new RuntimeError(404, 'not_found', `workspace runtime ${workspaceId} not found`);
}

function toInfo(workspaceId: string, raw: Docker.ContainerInspectInfo): WorkspaceRuntimeInfo {
  const hostConfig = raw.HostConfig as {
    NanoCpus?: number;
    Memory?: number;
    PidsLimit?: number | null;
  };
  const resources: WorkspaceResources | null =
    hostConfig.NanoCpus && hostConfig.Memory
      ? {
          cpus: hostConfig.NanoCpus / 1e9,
          memoryMb: Math.round(hostConfig.Memory / (1024 * 1024)),
          pidsLimit: hostConfig.PidsLimit ?? 0,
        }
      : null;
  return {
    workspaceId,
    status: mapStatus(raw.State.Status, raw.State.Error),
    containerId: raw.Id,
    image: raw.Config.Labels?.[IMAGE_LABEL] ?? raw.Config.Image,
    volumeName: volumeName(workspaceId),
    resources,
    createdAt: raw.Created ?? null,
    startedAt: raw.State.Running ? raw.State.StartedAt : null,
    dockerStatus: raw.State.Status,
  };
}

function mapStatus(dockerStatus: string, error: string | undefined): WorkspaceRuntimeStatus {
  if (error) return 'error';
  switch (dockerStatus) {
    case 'running':
      return 'running';
    case 'restarting':
      return 'starting';
    case 'removing':
      return 'stopping';
    case 'created':
    case 'exited':
    case 'paused':
    case 'dead':
      return 'stopped';
    default:
      return 'unknown';
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (result as Record<string, unknown>)[key] = entry;
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
