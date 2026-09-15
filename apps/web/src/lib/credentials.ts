import { and, eq } from 'drizzle-orm';
import { PROVIDERS, decryptSecret, encryptSecret, maskSecret, parseCredentialsKey, type ProviderId } from '@notea/agents';
import { providerCredentials, type Database, type ProviderCredential } from '@notea/db';
import { NotFoundError } from './authz';

export interface CredentialView {
  id: string;
  provider: ProviderId;
  providerName: string;
  label: string;
  masked: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export function requireCredentialsKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('CREDENTIALS_KEY is not configured; add it to .env (openssl rand -hex 32) on the web app and the worker');
  return parseCredentialsKey(raw);
}

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
  return {
    id: row.id,
    provider,
    providerName: PROVIDERS[provider]?.name ?? row.provider,
    label: row.label,
    masked,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export async function addCredential(
  db: Database,
  userId: string,
  key: Buffer,
  input: { provider: string; label: string; secret: string },
): Promise<ProviderCredential> {
  if (!(input.provider in PROVIDERS)) throw new Error('unknown provider');
  const label = input.label.trim();
  if (!label || label.length > 80) throw new Error('label must be 1-80 characters');
  const secret = input.secret.trim();
  if (secret.length < 8 || secret.length > 4096) throw new Error('secret looks invalid');
  const [row] = await db
    .insert(providerCredentials)
    .values({ userId, provider: input.provider, label, encryptedSecret: encryptSecret(secret, key) })
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
