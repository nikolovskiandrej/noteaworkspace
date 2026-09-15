import { describe, expect, it } from 'vitest';
import { ScrollbackBuffer } from '../src/scrollback';

describe('ScrollbackBuffer', () => {
  it('keeps everything while under the limit', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.append('hello ');
    buffer.append('world');
    expect(buffer.snapshot()).toBe('hello world');
    expect(buffer.byteLength).toBe(11);
  });

  it('drops the oldest chunks once the limit is exceeded', () => {
    const buffer = new ScrollbackBuffer(10);
    buffer.append('aaaa');
    buffer.append('bbbb');
    buffer.append('cccc');
    expect(buffer.snapshot()).toBe('bbbbcccc');
    expect(buffer.byteLength).toBe(8);
  });

  it('keeps only the tail of a single oversized chunk', () => {
    const buffer = new ScrollbackBuffer(5);
    buffer.append('0123456789');
    expect(buffer.snapshot()).toBe('56789');
  });

  it('measures multi-byte characters by UTF-8 size', () => {
    const buffer = new ScrollbackBuffer(6);
    buffer.append('é'); // 2 bytes
    buffer.append('€'); // 3 bytes
    buffer.append('€'); // 3 bytes -> total 8, drop 'é'
    expect(buffer.snapshot()).toBe('€€');
    expect(buffer.byteLength).toBe(6);
  });

  it('rejects a non-positive limit', () => {
    expect(() => new ScrollbackBuffer(0)).toThrow();
  });
});
