import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentError } from '../src/errors';
import { FsService } from '../src/fs-service';

let root: string;
let outside: string;
let service: FsService;

beforeEach(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'notea-fs-'));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fsp.mkdir(path.join(root, 'src'));
  await fsp.writeFile(path.join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  await fsp.writeFile(path.join(root, 'README.md'), '# hi\n');
  service = new FsService(root, 64);
});

afterEach(async () => {
  await fsp.rm(path.dirname(root), { recursive: true, force: true });
});

async function expectAgentError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.unreachable('expected an AgentError');
  } catch (err) {
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe(code);
  }
}

describe('FsService', () => {
  it('lists a directory with directories first', async () => {
    const result = await service.list('/');
    expect(result.path).toBe('');
    expect(result.entries.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:src', 'file:README.md']);
  });

  it('reads a file and returns a stable etag', async () => {
    const first = await service.read('src/index.ts');
    const second = await service.read('/src/index.ts');
    expect(first.content).toBe('export const x = 1;\n');
    expect(first.path).toBe('src/index.ts');
    expect(first.etag).toBe(second.etag);
  });

  it('writes a file, creating parent directories', async () => {
    const written = await service.write('deep/nested/file.txt', 'hello');
    expect(written.path).toBe('deep/nested/file.txt');
    const read = await service.read('deep/nested/file.txt');
    expect(read.content).toBe('hello');
    expect(read.etag).toBe(written.etag);
  });

  it('rejects writes when the expected etag no longer matches', async () => {
    const original = await service.read('README.md');
    await service.write('README.md', '# changed\n');
    await expectAgentError(service.write('README.md', '# mine\n', original.etag), 'conflict');
    const current = await service.read('README.md');
    await service.write('README.md', '# mine\n', current.etag);
    expect((await service.read('README.md')).content).toBe('# mine\n');
  });

  it('rejects paths that escape the project root', async () => {
    await expectAgentError(service.read('../outside/secret.txt'), 'bad_request');
    await expectAgentError(service.list('src/../../outside'), 'bad_request');
  });

  it('rejects symlinks that point outside the project root', async () => {
    let linked = true;
    try {
      await fsp.symlink(outside, path.join(root, 'escape'), 'dir');
    } catch {
      linked = false; // symlink creation may need privileges on Windows
    }
    if (!linked) return;
    await expectAgentError(service.read('escape/secret.txt'), 'bad_request');
  });

  it('reports missing files as not_found', async () => {
    await expectAgentError(service.read('nope.txt'), 'not_found');
    await expectAgentError(service.list('nope'), 'not_found');
  });

  it('refuses oversized and binary files', async () => {
    await fsp.writeFile(path.join(root, 'big.txt'), 'x'.repeat(65));
    await expectAgentError(service.read('big.txt'), 'too_large');
    await expectAgentError(service.write('big2.txt', 'y'.repeat(65)), 'too_large');
    await fsp.writeFile(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
    await expectAgentError(service.read('bin.dat'), 'bad_request');
  });
});
