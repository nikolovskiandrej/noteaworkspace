import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, maskSecret, parseCredentialsKey } from '../src/credentials';

describe('credentials', () => {
  const key = parseCredentialsKey('a'.repeat(64));

  it('round-trips secrets with a fresh iv each time', () => {
    const a = encryptSecret('sk-ant-secret-123', key);
    const b = encryptSecret('sk-ant-secret-123', key);
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(decryptSecret(a, key)).toBe('sk-ant-secret-123');
  });

  it('rejects tampering and wrong keys', () => {
    const stored = encryptSecret('secret', key);
    const tampered = stored.slice(0, -2) + (stored.endsWith('A') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret(stored, parseCredentialsKey('b'.repeat(64)))).toThrow();
    expect(() => decryptSecret('v0:x:y:z', key)).toThrow(/unrecognised/);
  });

  it('validates the key format and masks secrets', () => {
    expect(() => parseCredentialsKey('short')).toThrow(/64 hex/);
    expect(maskSecret('sk-ant-api03-abcdefghijkl')).toBe('sk-ant…ijkl');
    expect(maskSecret('tiny')).toBe('••••');
  });
});
