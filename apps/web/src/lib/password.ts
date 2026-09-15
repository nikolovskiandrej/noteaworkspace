import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };

/**
 * scrypt from Node's crypto: no native dependency, memory-hard, adequate for a
 * self-hosted tool. Format: `scrypt$N$r$p$<salt b64>$<hash b64>` so parameters can
 * be raised later without breaking existing hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: 128 * PARAMS.N * PARAMS.r * 2 });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 128 * N * r * 2 });
  return timingSafeEqual(actual, expected);
}
