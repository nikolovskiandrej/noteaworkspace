import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../src/messages';

describe('parseClientMessage', () => {
  it('accepts a valid term.create message', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'term.create', reqId: 'r1', cols: 80, rows: 24 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe('term.create');
    }
  });

  it('rejects invalid JSON', () => {
    const result = parseClientMessage('{not json');
    expect(result).toEqual({ ok: false, error: 'invalid JSON' });
  });

  it('rejects unknown message types', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'term.explode' }));
    expect(result.ok).toBe(false);
  });

  it('rejects out-of-range terminal dimensions', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'term.resize', sessionId: 's1', cols: 0, rows: 24 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('cols');
    }
  });

  it('validates injected environment variables', () => {
    const ok = parseClientMessage(
      JSON.stringify({ type: 'exec.start', reqId: 'r1', command: 'claude', env: { ANTHROPIC_API_KEY: 'k', PORT: '3000' } }),
    );
    expect(ok.ok).toBe(true);
    for (const env of [{ PATH: '/x' }, { NOTEA_AGENT_TOKEN: 'x' }, { lower: 'x' }, { LD_PRELOAD: 'x' }]) {
      const bad = parseClientMessage(JSON.stringify({ type: 'exec.start', reqId: 'r1', command: 'x', env }));
      expect(bad.ok).toBe(false);
    }
  });

  it('rejects identify frames with an invalid role', () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: 'identify',
        client: { id: 'c1', userId: 'u1', name: 'A', kind: 'user', role: 'admin' },
      }),
    );
    expect(result.ok).toBe(false);
  });
});
