import { describe, expect, it } from 'vitest';
import { buildTaskBrief } from '../src/brief';
import { assertTransition, canTransition, globToRegExp, scopesOverlap } from '../src/tasks';

describe('task transitions', () => {
  it('allows the designed flow and rejects shortcuts', () => {
    const flow = ['draft', 'queued', 'running', 'needs_review', 'approved', 'integrating', 'done'] as const;
    for (let i = 0; i < flow.length - 1; i += 1) expect(canTransition(flow[i]!, flow[i + 1]!)).toBe(true);
    expect(canTransition('draft', 'done')).toBe(false);
    expect(canTransition('running', 'approved')).toBe(false);
    expect(canTransition('integrating', 'needs_rebase')).toBe(true);
    expect(canTransition('needs_rebase', 'queued')).toBe(true);
    expect(() => assertTransition('done', 'queued')).toThrow(/cannot move task/);
  });
});

describe('scopes', () => {
  it('compiles globs', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('docs/?.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });

  it('detects overlapping scopes conservatively', () => {
    expect(scopesOverlap(['src/api'], ['src/api/users.ts'])).toBe(true);
    expect(scopesOverlap(['src/api/**'], ['src/api/users.ts'])).toBe(true);
    expect(scopesOverlap(['src/api/**'], ['src/ui/**'])).toBe(false);
    expect(scopesOverlap(['src/**'], ['src/ui/**'])).toBe(true);
    expect(scopesOverlap(['package.json'], ['package.json'])).toBe(true);
    expect(scopesOverlap(['docs'], ['src'])).toBe(false);
    expect(scopesOverlap([], ['src'])).toBe(false);
  });
});

describe('buildTaskBrief', () => {
  it('states the isolation and coordination rules', () => {
    const brief = buildTaskBrief({
      taskTitle: 'Add login',
      taskDescription: 'Implement email login.',
      worktreePath: '/home/dev/.notea/worktrees/t1',
      branch: 'notea/task/t1',
      baseBranch: 'main',
      projectDir: '/home/dev/project',
      scope: ['src/auth/**'],
      reservedPaths: ['src/api/**'],
      checkCommand: 'npm test',
      portRange: { from: 4200, to: 4210 },
    });
    expect(brief).toContain('# Task: Add login');
    expect(brief).toContain('`/home/dev/.notea/worktrees/t1`');
    expect(brief).toContain('Do NOT modify `/home/dev/project`');
    expect(brief).toContain('`src/auth/**`');
    expect(brief).toContain('Do not touch those paths');
    expect(brief).toContain('`npm test`');
    expect(brief).toContain('4200 and 4210');
    expect(brief).toContain('Do not merge, rebase, push');
  });
});
