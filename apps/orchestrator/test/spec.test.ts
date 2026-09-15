import { describe, expect, it } from 'vitest';
import { WORKSPACE_ID_PATTERN, buildContainerSpec, containerName, volumeName } from '../src/docker/spec';

const base = {
  workspaceId: 'ws_1',
  image: 'notea/workspace:dev',
  network: 'notea-workspaces',
  agentToken: 'a'.repeat(64),
  agentPort: 7070,
  resources: { cpus: 1.5, memoryMb: 2048, pidsLimit: 512 },
  publishAgentPort: false,
};

describe('buildContainerSpec', () => {
  it('names resources after the workspace id', () => {
    expect(containerName('abc')).toBe('notea-ws-abc');
    expect(volumeName('abc')).toBe('notea-ws-abc-home');
    const spec = buildContainerSpec(base);
    expect(spec.name).toBe('notea-ws-ws_1');
    expect(spec.HostConfig?.Mounts).toEqual([{ Type: 'volume', Source: 'notea-ws-ws_1-home', Target: '/home/dev' }]);
  });

  it('hardens the container', () => {
    const spec = buildContainerSpec(base);
    const host = spec.HostConfig ?? {};
    expect(host.CapDrop).toEqual(['ALL']);
    expect(host.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(host.Privileged).toBe(false);
    expect(host.Init).toBe(true);
    expect(host.Memory).toBe(2048 * 1024 * 1024);
    expect(host.MemorySwap).toBe(host.Memory);
    expect(host.NanoCpus).toBe(1_500_000_000);
    expect(host.PidsLimit).toBe(512);
    expect(host.NetworkMode).toBe('notea-workspaces');
    // No bind mounts: the docker socket or host paths must never be exposed.
    expect(host.Binds).toBeUndefined();
    expect(host.Mounts?.every((m) => m.Type === 'volume')).toBe(true);
  });

  it('passes the agent configuration through the environment and labels', () => {
    const spec = buildContainerSpec(base);
    expect(spec.Env).toContain('NOTEA_WORKSPACE_ID=ws_1');
    expect(spec.Env).toContain(`NOTEA_AGENT_TOKEN=${'a'.repeat(64)}`);
    expect(spec.Env).toContain('NOTEA_AGENT_PORT=7070');
    expect(spec.Labels).toMatchObject({ 'notea.managed': 'true', 'notea.workspace.id': 'ws_1' });
  });

  it('publishes the agent port on loopback only when asked', () => {
    expect(buildContainerSpec(base).HostConfig?.PortBindings).toBeUndefined();
    const published = buildContainerSpec({ ...base, publishAgentPort: true });
    expect(published.ExposedPorts).toEqual({ '7070/tcp': {} });
    expect(published.HostConfig?.PortBindings).toEqual({ '7070/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] });
  });
});

describe('WORKSPACE_ID_PATTERN', () => {
  it('accepts slugs and uuids, rejects path-like ids', () => {
    expect(WORKSPACE_ID_PATTERN.test('my-workspace_1')).toBe(true);
    expect(WORKSPACE_ID_PATTERN.test('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(WORKSPACE_ID_PATTERN.test('../etc')).toBe(false);
    expect(WORKSPACE_ID_PATTERN.test('-leading')).toBe(false);
    expect(WORKSPACE_ID_PATTERN.test('')).toBe(false);
    expect(WORKSPACE_ID_PATTERN.test('a'.repeat(65))).toBe(false);
  });
});
