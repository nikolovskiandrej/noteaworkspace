import { describe, expect, it } from 'vitest';
import { RuntimeError } from '../src/errors';
import { TokenService } from '../src/tokens';

function service(overrides: Partial<ConstructorParameters<typeof TokenService>[0]> = {}) {
  return new TokenService({
    connectTokenSecret: 'c'.repeat(32),
    agentTokenSecret: 'a'.repeat(32),
    defaultTtlSeconds: 300,
    maxTtlSeconds: 3600,
    ...overrides,
  });
}

const claims = { sub: 'user-1', ws: 'ws-1', name: 'Andrej', role: 'owner' as const, kind: 'user' as const };

describe('TokenService connect tokens', () => {
  it('round-trips claims', async () => {
    const tokens = service();
    const { token, expiresAt } = await tokens.issueConnectToken(claims);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await tokens.verifyConnectToken(token, 'ws-1')).toEqual(claims);
  });

  it('caps the ttl at the configured maximum', async () => {
    const now = 1_700_000_000_000;
    const tokens = service({ now: () => now, maxTtlSeconds: 60 });
    const { expiresAt } = await tokens.issueConnectToken(claims, 99_999);
    expect(new Date(expiresAt).getTime()).toBe(now + 60_000);
  });

  it('rejects tokens for another workspace', async () => {
    const tokens = service();
    const { token } = await tokens.issueConnectToken(claims);
    await expect(tokens.verifyConnectToken(token, 'ws-2')).rejects.toBeInstanceOf(RuntimeError);
  });

  it('rejects expired, tampered and foreign tokens', async () => {
    let now = 1_700_000_000_000;
    const tokens = service({ now: () => now, defaultTtlSeconds: 10 });
    const { token } = await tokens.issueConnectToken(claims);
    now += 11_000;
    await expect(tokens.verifyConnectToken(token, 'ws-1')).rejects.toThrow(/invalid connect token/);

    const fresh = service();
    const issued = await fresh.issueConnectToken(claims);
    const tampered = issued.token.slice(0, -2) + 'xx';
    await expect(fresh.verifyConnectToken(tampered, 'ws-1')).rejects.toThrow(/invalid connect token/);

    const other = service({ connectTokenSecret: 'z'.repeat(32) });
    await expect(other.verifyConnectToken(issued.token, 'ws-1')).rejects.toThrow(/invalid connect token/);
    await expect(other.verifyConnectToken('', 'ws-1')).rejects.toThrow(/missing connect token/);
  });
});

describe('TokenService agent tokens', () => {
  it('derives a stable per-workspace secret', () => {
    const tokens = service();
    expect(tokens.agentToken('ws-1')).toBe(tokens.agentToken('ws-1'));
    expect(tokens.agentToken('ws-1')).not.toBe(tokens.agentToken('ws-2'));
    expect(tokens.agentToken('ws-1')).toHaveLength(64);
    expect(service({ agentTokenSecret: 'b'.repeat(32) }).agentToken('ws-1')).not.toBe(tokens.agentToken('ws-1'));
  });
});

describe('TokenService agent-terminal tokens', () => {
  const terminalClaims = {
    sub: 'user-2',
    ws: 'ws-1',
    name: 'Niche',
    role: 'editor' as const,
    owner: { userId: 'user-1', name: 'Andrej', email: 'andrej@notea.mk', uid: 20_003 },
    input: false,
  };

  it('round-trips claims', async () => {
    const tokens = service();
    const { token } = await tokens.issueAgentTerminalToken(terminalClaims);
    expect(await tokens.verifyAgentTerminalToken(token, 'ws-1')).toEqual(terminalClaims);
  });

  it('is not interchangeable with a connect token, in either direction', async () => {
    const tokens = service();
    const terminal = await tokens.issueAgentTerminalToken(terminalClaims);
    const connect = await tokens.issueConnectToken(claims);
    await expect(tokens.verifyConnectToken(terminal.token, 'ws-1')).rejects.toThrow(/invalid connect token/);
    await expect(tokens.verifyAgentTerminalToken(connect.token, 'ws-1')).rejects.toThrow(/invalid terminal token/);
  });

  it('rejects another workspace, expiry and tampering', async () => {
    let now = 1_700_000_000_000;
    const tokens = service({ now: () => now, defaultTtlSeconds: 10 });
    const { token } = await tokens.issueAgentTerminalToken(terminalClaims);
    await expect(tokens.verifyAgentTerminalToken(token, 'ws-2')).rejects.toThrow(/another workspace/);
    await expect(tokens.verifyAgentTerminalToken(`${token.slice(0, -2)}xx`, 'ws-1')).rejects.toThrow(/invalid terminal token/);
    now += 11_000;
    await expect(tokens.verifyAgentTerminalToken(token, 'ws-1')).rejects.toThrow(/invalid terminal token/);
    await expect(tokens.verifyAgentTerminalToken('', 'ws-1')).rejects.toThrow(/missing terminal token/);
  });
});
