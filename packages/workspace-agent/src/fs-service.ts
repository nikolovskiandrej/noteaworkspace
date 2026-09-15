import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FsEntry } from '@notea/protocol';
import { AgentError } from './errors';

export interface FsReadResult {
  path: string;
  content: string;
  etag: string;
  size: number;
  mtimeMs: number;
}

export interface FsWriteResult {
  path: string;
  etag: string;
  size: number;
  mtimeMs: number;
}

/**
 * File operations confined to the project directory. Paths from clients are treated
 * as relative to the project root (a leading slash is stripped) and are rejected if
 * they resolve outside it, including through symlinks.
 *
 * This is a convenience API for the editor, not a security boundary: anyone with a
 * terminal in the workspace already has full access as the `dev` user.
 */
export class FsService {
  constructor(
    private readonly rootDir: string,
    private readonly maxFileBytes = 2 * 1024 * 1024,
  ) {}

  async list(clientPath: string): Promise<{ path: string; entries: FsEntry[] }> {
    const abs = await this.resolve(clientPath);
    let dirents;
    try {
      dirents = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      throw translateFsError(err, clientPath);
    }
    const entries: FsEntry[] = [];
    for (const dirent of dirents) {
      const entryPath = path.join(abs, dirent.name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const stat = await fsp.lstat(entryPath);
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        // entry vanished between readdir and lstat; report what we know
      }
      entries.push({
        name: dirent.name,
        type: dirent.isSymbolicLink()
          ? 'symlink'
          : dirent.isDirectory()
            ? 'dir'
            : dirent.isFile()
              ? 'file'
              : 'other',
        size,
        mtimeMs,
      });
    }
    entries.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });
    return { path: this.toClientPath(abs), entries };
  }

  async read(clientPath: string): Promise<FsReadResult> {
    const abs = await this.resolve(clientPath);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch (err) {
      throw translateFsError(err, clientPath);
    }
    if (stat.isDirectory()) throw new AgentError('bad_request', `${clientPath} is a directory`);
    if (stat.size > this.maxFileBytes) {
      throw new AgentError('too_large', `file exceeds ${this.maxFileBytes} bytes`);
    }
    const buffer = await fsp.readFile(abs);
    if (buffer.includes(0)) throw new AgentError('bad_request', `${clientPath} is a binary file`);
    const content = buffer.toString('utf8');
    return {
      path: this.toClientPath(abs),
      content,
      etag: computeEtag(buffer),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  async write(clientPath: string, content: string, expectedEtag?: string): Promise<FsWriteResult> {
    const abs = await this.resolve(clientPath);
    const buffer = Buffer.from(content, 'utf8');
    if (buffer.byteLength > this.maxFileBytes) {
      throw new AgentError('too_large', `content exceeds ${this.maxFileBytes} bytes`);
    }
    if (expectedEtag !== undefined) {
      let currentEtag: string | null = null;
      try {
        currentEtag = computeEtag(await fsp.readFile(abs));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw translateFsError(err, clientPath);
      }
      if (currentEtag !== null && currentEtag !== expectedEtag) {
        throw new AgentError('conflict', `${clientPath} changed since it was read`);
      }
    }
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, buffer);
    } catch (err) {
      throw translateFsError(err, clientPath);
    }
    const stat = await fsp.stat(abs);
    return {
      path: this.toClientPath(abs),
      etag: computeEtag(buffer),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  /** Resolves a client-supplied path to an absolute path inside the project root. */
  async resolve(clientPath: string): Promise<string> {
    const relative = clientPath.replace(/^[/\\]+/, '');
    const abs = path.resolve(this.rootDir, relative);
    if (!isInside(this.rootDir, abs)) {
      throw new AgentError('bad_request', 'path escapes the project directory');
    }
    // Follow symlinks on the nearest existing ancestor so a link cannot point outside.
    const rootReal = await fsp.realpath(this.rootDir);
    let probe = abs;
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (!isInside(rootReal, real)) {
          throw new AgentError('bad_request', 'path escapes the project directory');
        }
        break;
      } catch (err) {
        if (err instanceof AgentError) throw err;
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw translateFsError(err, clientPath);
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return abs;
  }

  /**
   * Resolves a working directory for a process: relative paths are taken from the
   * project root; absolute paths are allowed anywhere (the container is the boundary)
   * but must exist and be directories.
   */
  async resolveAnyDir(clientPath: string): Promise<string> {
    const abs = path.isAbsolute(clientPath) ? path.normalize(clientPath) : path.resolve(this.rootDir, clientPath);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch (err) {
      throw translateFsError(err, clientPath);
    }
    if (!stat.isDirectory()) throw new AgentError('bad_request', `${clientPath} is not a directory`);
    return abs;
  }

  private toClientPath(abs: string): string {
    const rel = path.relative(this.rootDir, abs);
    return rel.split(path.sep).join('/');
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(rootWithSep);
}

function computeEtag(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

function translateFsError(err: unknown, clientPath: string): AgentError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new AgentError('not_found', `${clientPath} does not exist`);
  if (code === 'ENOTDIR') return new AgentError('bad_request', `${clientPath}: not a directory`);
  if (code === 'EISDIR') return new AgentError('bad_request', `${clientPath} is a directory`);
  if (code === 'EACCES' || code === 'EPERM') {
    return new AgentError('unauthorized', `${clientPath}: permission denied`);
  }
  return new AgentError('internal', `${clientPath}: ${(err as Error).message}`);
}
