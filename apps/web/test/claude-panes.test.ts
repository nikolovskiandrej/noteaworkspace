import { describe, expect, it } from 'vitest';
import { claudePanes, firstName } from '../src/lib/claude-panes';

const andrej = { userId: 'u-andrej', name: 'Andrej', email: 'andrej@notea.mk', role: 'owner' as const };
const niche = { userId: 'u-niche', name: 'Niche', email: 'niche@notea.mk', role: 'editor' as const };

describe('claudePanes', () => {
  it('gives each member who can write a terminal named after them, the owner first, in the same order for everyone', () => {
    for (const me of [andrej.userId, niche.userId]) {
      const panes = claudePanes([niche, andrej], me);
      expect(panes.map((p) => p.title)).toEqual(["Andrej's Claude", "Niche's Claude"]);
      expect(panes.map((p) => p.shortLabel)).toEqual(['Andrej', 'Niche']);
      expect(panes.find((p) => p.isYou)?.userId).toBe(me);
      expect(panes.every((p) => p.detail === null)).toBe(true);
    }
  });

  it('leaves viewers out: they watch, they have no Claude here', () => {
    const viewer = { userId: 'u-v', name: 'Vesna', email: 'v@notea.mk', role: 'viewer' as const };
    expect(claudePanes([andrej, niche, viewer], viewer.userId).map((p) => p.userId)).toEqual([andrej.userId, niche.userId]);
  });

  it('tells apart two members who share a first name', () => {
    const other = { userId: 'u-a2', name: 'Andrej Nikolovski', email: 'andrej@notea.local', role: 'editor' as const };
    const panes = claudePanes([andrej, other], andrej.userId);
    expect(panes.map((p) => p.title)).toEqual(["Andrej's Claude", "Andrej's Claude"]);
    expect(panes.map((p) => p.detail)).toEqual(['andrej@notea.mk', 'andrej@notea.local']);
  });

  it('uses the first word of a name', () => {
    expect(firstName('  Andrej Nikolovski ')).toBe('Andrej');
    expect(firstName('')).toBe('Member');
  });
});
