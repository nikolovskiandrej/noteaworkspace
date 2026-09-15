/**
 * Bounded buffer of recent terminal output, replayed to clients when they attach.
 * Bounded by UTF-8 byte size so memory per session is predictable.
 */
export class ScrollbackBuffer {
  private chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error('ScrollbackBuffer maxBytes must be a positive number');
    }
  }

  append(data: string): void {
    if (data.length === 0) return;
    let chunk = data;
    let size = Buffer.byteLength(chunk, 'utf8');
    if (size > this.maxBytes) {
      chunk = tailWithinBytes(chunk, this.maxBytes);
      size = Buffer.byteLength(chunk, 'utf8');
      this.chunks = [];
      this.bytes = 0;
    }
    this.chunks.push(chunk);
    this.bytes += size;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const first = this.chunks.shift() as string;
      this.bytes -= Buffer.byteLength(first, 'utf8');
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }

  get byteLength(): number {
    return this.bytes;
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }
}

/** Returns a suffix of `s` whose UTF-8 encoding fits within `max` bytes. */
function tailWithinBytes(s: string, max: number): string {
  let out = s;
  let size = Buffer.byteLength(out, 'utf8');
  while (size > max && out.length > 0) {
    // Dropping N UTF-16 code units removes at least N bytes, so this converges quickly.
    out = out.slice(Math.min(out.length, size - max));
    size = Buffer.byteLength(out, 'utf8');
  }
  return out;
}
