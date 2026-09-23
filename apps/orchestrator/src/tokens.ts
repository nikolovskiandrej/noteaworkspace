import { createHmac } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { ClientKindSchema, WorkspaceRoleSchema, type AgentTerminalTokenClaims, type ConnectTokenClaims } from '@notea/protocol';
import { RuntimeError } from './errors';

const ISSUER = 'notea-orchestrator';
const AUDIENCE = 'notea-workspace-connect';
/**
 * A different audience, so neither kind of token is accepted where the other is
 * expected: a connect token names no terminal owner, and an agent-terminal token
 * must not open the workspace bridge.
 */
const AGENT_TERMINAL_AUDIENCE = 'notea-agent-terminal';

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  ws: z.string().min(1),
  name: z.string().min(1),
  role: WorkspaceRoleSchema,
  kind: ClientKindSchema,
});

const AgentTerminalClaimsSchema = z.object({
  sub: z.string().min(1),
  ws: z.string().min(1),
  name: z.string().min(1),
  role: WorkspaceRoleSchema,
  owner: z.object({
    userId: z.string().min(1),
    name: z.string().min(1),
    email: z.string(),
    uid: z.number().int(),
  }),
  input: z.boolean(),
});

export interface TokenServiceOptions {
  connectTokenSecret: string;
  agentTokenSecret: string;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  now?: () => number;
}

/**
 * Two kinds of secrets live here:
 *  - connect tokens: short-lived JWTs the control plane requests for a user and the
 *    browser presents when opening a workspace WebSocket (and agent-terminal tokens,
 *    the same thing for one member's Claude terminal, under their own audience);
 *  - agent tokens: per-workspace shared secrets derived by HMAC from a root secret,
 *    injected into the container environment at creation time. Nothing needs to be
 *    stored to verify them.
 */
export class TokenService {
  private readonly connectKey: Uint8Array;

  constructor(private readonly opts: TokenServiceOptions) {
    this.connectKey = new TextEncoder().encode(opts.connectTokenSecret);
  }

  async issueConnectToken(
    claims: ConnectTokenClaims,
    ttlSeconds?: number,
  ): Promise<{ token: string; expiresAt: string }> {
    const ttl = Math.min(ttlSeconds ?? this.opts.defaultTtlSeconds, this.opts.maxTtlSeconds);
    const nowSeconds = Math.floor((this.opts.now ?? Date.now)() / 1000);
    const exp = nowSeconds + ttl;
    const token = await new SignJWT({ ws: claims.ws, name: claims.name, role: claims.role, kind: claims.kind })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(exp)
      .sign(this.connectKey);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async verifyConnectToken(token: string, workspaceId: string): Promise<ConnectTokenClaims> {
    const payload = await this.verify(token, AUDIENCE, 'connect token');
    const parsed = ClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new RuntimeError(401, 'unauthorized', 'connect token has malformed claims');
    if (parsed.data.ws !== workspaceId) {
      throw new RuntimeError(401, 'unauthorized', 'connect token was issued for another workspace');
    }
    return parsed.data;
  }

  /**
   * A token for watching, and when `claims.input` is set typing into, one member's
   * Claude terminal. The control plane decides who the owner is; whether the holder
   * may type is decided by the caller of this method (see the token route), and the
   * orchestrator enforces it on every message.
   */
  async issueAgentTerminalToken(
    claims: AgentTerminalTokenClaims,
    ttlSeconds?: number,
  ): Promise<{ token: string; expiresAt: string }> {
    const ttl = Math.min(ttlSeconds ?? this.opts.defaultTtlSeconds, this.opts.maxTtlSeconds);
    const nowSeconds = Math.floor((this.opts.now ?? Date.now)() / 1000);
    const exp = nowSeconds + ttl;
    const token = await new SignJWT({ ws: claims.ws, name: claims.name, role: claims.role, owner: claims.owner, input: claims.input })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AGENT_TERMINAL_AUDIENCE)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(exp)
      .sign(this.connectKey);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async verifyAgentTerminalToken(token: string, workspaceId: string): Promise<AgentTerminalTokenClaims> {
    const payload = await this.verify(token, AGENT_TERMINAL_AUDIENCE, 'terminal token');
    const parsed = AgentTerminalClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new RuntimeError(401, 'unauthorized', 'terminal token has malformed claims');
    if (parsed.data.ws !== workspaceId) {
      throw new RuntimeError(401, 'unauthorized', 'terminal token was issued for another workspace');
    }
    return parsed.data;
  }

  private async verify(token: string, audience: string, what: string): Promise<unknown> {
    if (!token) throw new RuntimeError(401, 'unauthorized', `missing ${what}`);
    try {
      const result = await jwtVerify(token, this.connectKey, {
        issuer: ISSUER,
        audience,
        algorithms: ['HS256'],
        currentDate: new Date((this.opts.now ?? Date.now)()),
      });
      return result.payload;
    } catch (err) {
      throw new RuntimeError(401, 'unauthorized', `invalid ${what}: ${(err as Error).message}`);
    }
  }

  agentToken(workspaceId: string): string {
    return createHmac('sha256', this.opts.agentTokenSecret).update(`agent:${workspaceId}`).digest('hex');
  }
}
