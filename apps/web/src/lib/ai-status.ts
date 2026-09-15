import { and, eq } from 'drizzle-orm';
import {
  CLAUDE_AUTH_STATUS_COMMAND,
  conflictingEnvNames,
  credentialEnv,
  decryptSecret,
  describeAuthStatus,
  findAuthMode,
  parseClaudeAuthStatus,
  type AuthMode,
  type ProviderId,
} from '@notea/agents';
import { providerCredentials, users, type Database } from '@notea/db';
import type { OrchestratorClient } from '@notea/workspace-client';
import { NotFoundError, requireMembership } from './authz';

export interface ConnectionCheck {
  ok: boolean;
  /** Human-readable outcome. Never contains the secret. */
  summary: string;
  authMethod: string | null;
  /** Where the CLI keeps this identity's own configuration inside the container. */
  configDirectory: string | null;
  /** The Unix uid the check ran as: the same one the user's agents run as. */
  uid: number;
}

/**
 * Asks the vendor CLI, inside a real workspace container and under the user's own
 * Unix uid, how it authenticated with this credential.
 *
 * This is the honest answer to "am I connected, and who pays?": Notea reports what
 * the CLI says rather than what Notea intended. It runs the credential through
 * exactly the path a task run uses — same uid, same single environment variable,
 * same clearing of the other modes — so a pass here means a run will authenticate
 * the same way. It spends no tokens: `claude auth status` makes no model request.
 */
export async function checkCredential(
  deps: { db: Database; orchestrator: OrchestratorClient; credentialsKey: Buffer },
  userId: string,
  input: { credentialId: string; workspaceId: string },
): Promise<ConnectionCheck> {
  const { db } = deps;
  await requireMembership(db, input.workspaceId, userId, 'editor');

  const credential = await db.query.providerCredentials.findFirst({
    where: and(eq(providerCredentials.id, input.credentialId), eq(providerCredentials.userId, userId)),
  });
  if (!credential) throw new NotFoundError('credential not found');

  const provider = credential.provider as ProviderId;
  const authMode = credential.authMode as AuthMode;
  if (provider !== 'anthropic') {
    throw new Error(`there is no connection check for ${provider} yet; run a small task to verify it`);
  }
  if (!findAuthMode(provider, authMode)) throw new Error(`unsupported authentication mode: ${credential.authMode}`);

  const owner = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { agentUid: true } });
  if (!owner) throw new NotFoundError('user not found');

  const result = await deps.orchestrator.agentExec(input.workspaceId, {
    uid: owner.agentUid,
    cmd: ['/bin/bash', '-lc', CLAUDE_AUTH_STATUS_COMMAND],
    env: credentialEnv(provider, authMode, decryptSecret(credential.encryptedSecret, deps.credentialsKey)),
    unsetEnv: conflictingEnvNames(provider, authMode),
    timeoutMs: 60_000,
  });

  const status = parseClaudeAuthStatus(result.stdout);
  const described = describeAuthStatus(status, authMode);
  return {
    ok: described.ok,
    summary: described.ok
      ? described.summary
      : `${described.summary}${result.exitCode === 0 ? '' : ` (exit ${String(result.exitCode)})`}`,
    authMethod: status?.authMethod ?? null,
    configDirectory: status?.configDirectory ?? null,
    uid: owner.agentUid,
  };
}
