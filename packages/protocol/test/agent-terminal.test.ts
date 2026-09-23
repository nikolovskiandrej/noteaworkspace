import { describe, expect, it } from 'vitest';
import { MAX_TERMINAL_INPUT_CHARS, parseAgentTerminalClientMessage } from '../src';

describe('parseAgentTerminalClientMessage', () => {
  it('accepts the four client messages', () => {
    for (const message of [
      { type: 'start', cols: 120, rows: 40 },
      { type: 'input', data: 'fix the failing test\r' },
      { type: 'resize', cols: 80, rows: 24 },
      { type: 'stop' },
    ]) {
      const result = parseAgentTerminalClientMessage(JSON.stringify(message));
      expect(result, JSON.stringify(message)).toEqual({ ok: true, message });
    }
  });

  it('rejects invalid JSON, unknown types and the workspace protocol’s messages', () => {
    expect(parseAgentTerminalClientMessage('{nope')).toEqual({ ok: false, error: 'invalid JSON' });
    expect(parseAgentTerminalClientMessage(JSON.stringify({ type: 'kill' })).ok).toBe(false);
    expect(parseAgentTerminalClientMessage(JSON.stringify({ type: 'term.input', sessionId: 's', data: 'x' })).ok).toBe(false);
  });

  it('bounds sizes and input', () => {
    const tooSmall = parseAgentTerminalClientMessage(JSON.stringify({ type: 'resize', cols: 2, rows: 24 }));
    expect(tooSmall.ok).toBe(false);
    if (!tooSmall.ok) expect(tooSmall.error).toContain('cols');
    expect(parseAgentTerminalClientMessage(JSON.stringify({ type: 'start', cols: 80, rows: 24.5 })).ok).toBe(false);
    expect(parseAgentTerminalClientMessage(JSON.stringify({ type: 'input', data: 'x'.repeat(MAX_TERMINAL_INPUT_CHARS + 1) })).ok).toBe(false);
  });
});
