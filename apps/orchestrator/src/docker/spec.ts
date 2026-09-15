import type Docker from 'dockerode';
import type { WorkspaceResources } from '@notea/protocol';

export const MANAGED_LABEL = 'notea.managed';
export const WORKSPACE_ID_LABEL = 'notea.workspace.id';
export const IMAGE_LABEL = 'notea.image';

export const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Path of the persistent volume inside the container (the `dev` user's HOME). */
export const HOME_MOUNT_PATH = '/home/dev';

export function containerName(workspaceId: string): string {
  return `notea-ws-${workspaceId}`;
}

export function volumeName(workspaceId: string): string {
  return `notea-ws-${workspaceId}-home`;
}

export interface ContainerSpecInput {
  workspaceId: string;
  image: string;
  network: string;
  agentToken: string;
  agentPort: number;
  resources: WorkspaceResources;
  /** Publish the agent port on 127.0.0.1 (Docker Desktop on Windows/macOS). */
  publishAgentPort: boolean;
}

/**
 * Pure function producing the Docker create options for a workspace container.
 * Kept free of I/O so the security-relevant invariants can be unit-tested.
 */
export function buildContainerSpec(input: ContainerSpecInput): Docker.ContainerCreateOptions {
  const memoryBytes = Math.round(input.resources.memoryMb * 1024 * 1024);
  const portKey = `${input.agentPort}/tcp`;
  return {
    name: containerName(input.workspaceId),
    Image: input.image,
    Hostname: `ws-${input.workspaceId}`.slice(0, 63),
    Env: [
      `NOTEA_WORKSPACE_ID=${input.workspaceId}`,
      `NOTEA_AGENT_TOKEN=${input.agentToken}`,
      `NOTEA_AGENT_PORT=${input.agentPort}`,
    ],
    Labels: {
      [MANAGED_LABEL]: 'true',
      [WORKSPACE_ID_LABEL]: input.workspaceId,
      [IMAGE_LABEL]: input.image,
    },
    ExposedPorts: input.publishAgentPort ? { [portKey]: {} } : undefined,
    HostConfig: {
      Init: true,
      Mounts: [{ Type: 'volume', Source: volumeName(input.workspaceId), Target: HOME_MOUNT_PATH }],
      NetworkMode: input.network,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      Memory: memoryBytes,
      // Equal to Memory: no swap for workspaces.
      MemorySwap: memoryBytes,
      NanoCpus: Math.round(input.resources.cpus * 1e9),
      PidsLimit: input.resources.pidsLimit,
      ShmSize: 256 * 1024 * 1024,
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      PortBindings: input.publishAgentPort ? { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '' }] } : undefined,
    },
  };
}
