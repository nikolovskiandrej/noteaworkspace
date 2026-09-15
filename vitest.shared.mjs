import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Shared test configuration for every workspace package.
 *
 * Several suites create scratch directories with `os.tmpdir()`. On Windows that
 * resolves to `%LOCALAPPDATA%\Temp` on the C: drive, which this project deliberately
 * keeps clear (see docs/ARCHITECTURE.md, "Storage layout"). Pointing TMPDIR/TEMP/TMP
 * at a repository-local `.tmp` keeps test scratch data on whichever drive the
 * repository lives on and makes cleanup a single directory removal.
 */
const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(repoRoot, '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });

export default defineConfig({
  test: {
    env: { TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir },
  },
});
