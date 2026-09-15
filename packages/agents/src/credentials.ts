import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/** Parses CREDENTIALS_KEY: 32 bytes as 64 hex characters. */
export function parseCredentialsKey(value: string | undefined): Buffer {
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('CREDENTIALS_KEY must be 64 hex characters (32 bytes); generate with `openssl rand -hex 32`');
  }
  return Buffer.from(value, 'hex');
}

/** AES-256-GCM; output `v1:<iv>:<tag>:<ciphertext>` (base64 fields). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(stored: string, key: Buffer): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) throw new Error('unrecognised credential format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Shows a key's shape without revealing it, e.g. `sk-ant-…3f9a`. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}
