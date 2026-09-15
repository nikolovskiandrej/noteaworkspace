import { and, eq } from 'drizzle-orm';
import {
  PROVIDERS,
  authModesFor,
  decryptSecret,
  encryptSecret,
  findAuthMode,
  isApiBilled,
  maskSecret,
  parseCredentialsKey,
  type AuthMode,
  type ProviderId,
} from '@notea/agents';
import { providerCredentials, type Database, type ProviderCredential } from '@notea/db';
import { NotFoundError } from './authz';

export interface CredentialView {
  id: string;
  provider: ProviderId;
  providerName: string;
  authMode: AuthMode;
  /** e.g. "Claude subscription" */
  authLabel: string;
  /** e.g. "Included in the Claude plan; no API charges" */
  billing: string;
  /** True when using this credential spends metered API credit. */
  apiBilled: boolean;
  /** The environment variable this credential becomes inside the agent process. */
  env: string;
  label: string;
  masked: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export function requireCredentialsKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('CREDENTIALS_KEY is not configured; add it to .env (openssl rand -hex 32) on the web app and the worker');
  return parseCredentialsKey(raw);
}

/**
 * The signed-in user's own credentials, and only those.
 *
 * Every caller passes the session's user id; there is no "all credentials" query in
 * the product, so one member's connection can never be listed, selected or displayed
 * in another member's session.
 */
export async function listCredentials(db: Database, userId: string, key: Buffer | null): Promise<CredentialView[]> {
  const rows = await db.query.providerCredentials.findMany({ where: eq(providerCredentials.userId, userId), orderBy: providerCredentials.createdAt });
  return rows.map((row) => toView(row, key));
}

function toView(row: ProviderCredential, key: Buffer | null): CredentialView {
  let masked = '•••• (key unavailable)';
  if (key) {
    try {
      masked = maskSecret(decryptSecret(row.encryptedSecret, key));
    } catch {
      masked = '•••• (undecryptable)';
    }
  }
  const provider = row.provider as ProviderId;
  const authMode = row.authMode as AuthMode;
  const info = findAuthMode(provider, authMode);
  return {
    id: row.id,
    provider,
    providerName: PROVIDERS[provider]?.name ?? row.provider,
    authMode,
    authLabel: info?.label ?? row.authMode,
    billing: info?.billing ?? 'unknown',
    apiBilled: isApiBilled(authMode),
    env: info?.env ?? '(unknown)',
    label: row.label,
    masked,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

/** One provider's connection status for the signed-in user. */
export interface ProviderConnection {
  provider: ProviderId;
  providerName: string;
  connected: boolean;
  credentials: CredentialView[];
  /** True when the user has connected both a subscription and an API key. */
  mixed: boolean;
}

export function connectionsFor(credentials: CredentialView[]): ProviderConnection[] {
  return Object.values(PROVIDERS).map((provider) => {
    const mine = credentials.filter((c) => c.provider === provider.id);
    return {
      provider: provider.id,
      providerName: provider.name,
      connected: mine.length > 0,
      credentials: mine,
      mixed: mine.some((c) => c.apiBilled) && mine.some((c) => !c.apiBilled),
    };
  });
}

export async function addCredential(
  db: Database,
  userId: string,
  key: Buffer,
  input: { provider: string; authMode: string; label: string; secret: string },
): Promise<ProviderCredential> {
  if (!(input.provider in PROVIDERS)) throw new Error('unknown provider');
  const provider = input.provider as ProviderId;
  const mode = findAuthMode(provider, input.authMode);
  if (!mode) {
    const supported = authModesFor(provider).map((m) => m.id).join(', ');
    throw new Error(`${PROVIDERS[provider].name} supports these authentication modes: ${supported}`);
  }
  const label = input.label.trim();
  if (!label || label.length > 80) throw new Error('label must be 1-80 characters');
  const secret = input.secret.trim();
  if (secret.length < 8 || secret.length > 4096) throw new Error('secret looks invalid');
  // A subscription token and an API key look different and bill differently; pasting
  // one into the other's slot would silently choose the wrong billing relationship.
  if (mode.secretPattern && !mode.secretPattern.test(secret)) {
    const other = authModesFor(provider).find((m) => m.id !== mode.id && m.secretPattern?.test(secret));
    throw new Error(
      other
        ? `that looks like a ${other.label} secret, not a ${mode.label} one — pick "${other.label}" instead`
        : `that does not look like a ${mode.label} secret`,
    );
  }
  const [row] = await db
    .insert(providerCredentials)
    .values({ userId, provider, authMode: mode.id, label, encryptedSecret: encryptSecret(secret, key) })
    .returning();
  if (!row) throw new Error('failed to store credential');
  return row;
}

export async function deleteCredential(db: Database, userId: string, credentialId: string): Promise<void> {
  const deleted = await db
    .delete(providerCredentials)
    .where(and(eq(providerCredentials.id, credentialId), eq(providerCredentials.userId, userId)))
    .returning({ id: providerCredentials.id });
  if (deleted.length === 0) throw new NotFoundError('credential not found');
}
