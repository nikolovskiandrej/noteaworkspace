import type { AuthMode } from './types';

/**
 * What `claude auth status --json` reports (claude-code 2.1.272).
 *
 * The CLI is the authority on how it authenticated, so Notea asks it rather than
 * asserting. Observed values, verified against the binary in the workspace image:
 *
 *   {"loggedIn":false,"authMethod":"none",...}
 *   {"loggedIn":true,"authMethod":"oauth_token",...}                 CLAUDE_CODE_OAUTH_TOKEN
 *   {"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY",...}
 *
 * When both variables are present the CLI reports `oauth_token`: the subscription
 * wins. Notea never sets both, and clears the one it is not using, so the report and
 * the intent cannot drift apart.
 */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiKeySource: string | null;
  configDirectory: string | null;
  /** The raw record, for display when a field is not one we know. */
  raw: Record<string, unknown>;
}

/** The command that produces it. Machine-readable output is the default. */
export const CLAUDE_AUTH_STATUS_COMMAND = 'claude auth status --json';

export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    loggedIn: record.loggedIn === true,
    authMethod: typeof record.authMethod === 'string' ? record.authMethod : 'unknown',
    apiKeySource: typeof record.apiKeySource === 'string' ? record.apiKeySource : null,
    configDirectory: typeof record.configDirectory === 'string' ? record.configDirectory : null,
    raw: record,
  };
}

/** The authentication mode a reported `authMethod` corresponds to, if we know it. */
export function authModeOfMethod(authMethod: string): AuthMode | null {
  if (authMethod === 'oauth_token' || authMethod === 'oauth' || authMethod === 'claudeai') return 'subscription';
  if (authMethod === 'api_key') return 'api_key';
  return null;
}

/**
 * Compares what the CLI reports with what Notea intended to hand it.
 *
 * A mismatch is worth surfacing rather than smoothing over: it means the process
 * authenticated as something other than the mode the user connected — the one way
 * subscription usage could quietly become metered API usage.
 */
export function describeAuthStatus(
  status: ClaudeAuthStatus | null,
  expected: AuthMode | null,
): { ok: boolean; mode: AuthMode | null; summary: string } {
  if (!status) return { ok: false, mode: null, summary: 'the CLI did not report a status' };
  if (!status.loggedIn) return { ok: false, mode: null, summary: 'not authenticated' };
  const mode = authModeOfMethod(status.authMethod);
  if (expected && mode && mode !== expected) {
    return { ok: false, mode, summary: `authenticated as ${status.authMethod}, but this connection is ${expected}` };
  }
  const via = status.apiKeySource ? ` (from ${status.apiKeySource})` : '';
  return { ok: true, mode, summary: `authenticated (${status.authMethod}${via})` };
}
