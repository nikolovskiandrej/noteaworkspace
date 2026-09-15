import { createHmac } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { ClientKindSchema, WorkspaceRoleSchema, type ConnectTokenClaims } from '@notea/protocol';
import { RuntimeError } from './errors';

const ISSUER = 'notea-orchestrator';
const AUDIENCE = 'notea-workspace-connect';

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  ws: z.string().min(1),
  name: z.string().min(1),
  role: WorkspaceRoleSchema,
  kind: ClientKindSchema,
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
 *    browser presents when opening a workspace WebSocket;
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
    if (!token) throw new RuntimeError(401, 'unauthorized', 'missing connect token');
    let payload: unknown;
    try {
      const result = await jwtVerify(token, this.connectKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
        currentDate: new Date((this.opts.now ?? Date.now)()),
      });
      payload = result.payload;
    } catch (err) {
      throw new RuntimeError(401, 'unauthorized', `invalid connect token: ${(err as Error).message}`);
    }
    const parsed = ClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new RuntimeError(401, 'unauthorized', 'connect token has malformed claims');
    if (parsed.data.ws !== workspaceId) {
      throw new RuntimeError(401, 'unauthorized', 'connect token was issued for another workspace');
    }
    return parsed.data;
  }

  agentToken(workspaceId: string): string {
    return createHmac('sha256', this.opts.agentTokenSecret).update(`agent:${workspaceId}`).digest('hex');
  }
}
