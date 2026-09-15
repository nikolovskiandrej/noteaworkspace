/**
 * Connect tokens travel in the bridge URL's `?token=` parameter. Fastify's default
 * request serializer logs `req.url` verbatim, which would put a live workspace
 * credential in the orchestrator log. These tests pin the redaction in place.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, redactQuery } from '../src/app';
import type { WorkspaceRuntimeApi } from '../src/docker/workspace-runtime';
import { RuntimeError } from '../src/errors';
import { TokenService } from '../src/tokens';

const SECRET = 'connect-token-that-must-never-be-logged';

function unusedRuntime(): WorkspaceRuntimeApi {
  const unused = () => {
    throw new RuntimeError(500, 'internal', 'not used');
  };
  return {
    list: async () => [],
    create: unused,
    inspect: async () => null,
    start: unused,
    stop: unused,
    remove: async () => undefined,
    agentEndpoint: async () => null,
    waitForAgent: unused,
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Builds an app whose log lines are captured instead of written to stdout. */
async function appWithCapturedLog(): Promise<{ app: FastifyInstance; lines: string[] }> {
  const lines: string[] = [];
  const built = await buildApp({
    runtime: unusedRuntime(),
    tokens: new TokenService({
      connectTokenSecret: 'c'.repeat(32),
      agentTokenSecret: 'a'.repeat(32),
      defaultTtlSeconds: 300,
      maxTtlSeconds: 3600,
    }),
    apiKey: 'test-api-key',
    logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
  });
  return { app: built, lines };
}

describe('redactQuery', () => {
  it('drops the query string and keeps the path', () => {
    expect(redactQuery('/ws/workspaces/abc?token=secret')).toBe('/ws/workspaces/abc?<redacted>');
    expect(redactQuery('/healthz')).toBe('/healthz');
    expect(redactQuery('/a?b=1&token=secret&c=2')).toBe('/a?<redacted>');
  });
});

describe('request logging', () => {
  it('never writes a token from the bridge URL to the log', async () => {
    const built = await appWithCapturedLog();
    app = built.app;
    await app.inject({ method: 'GET', url: `/ws/workspaces/ws-logging?token=${SECRET}` });

    const log = built.lines.join('\n');
    expect(log).not.toContain(SECRET);
    expect(log).toContain('/ws/workspaces/ws-logging?<redacted>');
  });

  it('redacts query strings on ordinary routes too', async () => {
    const built = await appWithCapturedLog();
    app = built.app;
    const response = await app.inject({ method: 'GET', url: `/healthz?token=${SECRET}` });

    expect(response.statusCode).toBe(200);
    const log = built.lines.join('\n');
    expect(log).not.toContain(SECRET);
    expect(log).toContain('/healthz?<redacted>');
  });

  it('still logs the method, path and status so requests stay traceable', async () => {
    const built = await appWithCapturedLog();
    app = built.app;
    await app.inject({ method: 'GET', url: '/healthz' });

    const log = built.lines.join('\n');
    expect(log).toContain('"method":"GET"');
    expect(log).toContain('"url":"/healthz"');
    expect(log).toContain('"statusCode":200');
  });
});
