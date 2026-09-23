import { describe, expect, it } from 'vitest';
import { findKnownLinks } from '../src/lib/terminal-links';

/** Rows of cells as a terminal of `cols` columns holds them. */
function screen(lines: string[], cols = 30): string[][] {
  return lines.map((line) => Array.from({ length: cols }, (_, x) => line[x] ?? ' '));
}

const signIn = 'https://claude.com/cai/oauth/authorize?code=true&state=f28geXY';

describe('findKnownLinks', () => {
  it('finds a link Claude broke over several lines, from any of them', () => {
    const rows = screen(['Use the url below to sign in', '', signIn.slice(0, 30), signIn.slice(30, 60), signIn.slice(60), '', 'Paste code here >']);
    for (const row of [2, 3, 4]) {
      expect(findKnownLinks(rows, row, [signIn])).toEqual([{ uri: signIn, start: { x: 0, y: 2 }, end: { x: signIn.length - 61, y: 4 } }]);
    }
    expect(findKnownLinks(rows, 0, [signIn])).toEqual([]);
    expect(findKnownLinks(rows, 6, [signIn])).toEqual([]);
  });

  it('ignores indentation on the continuation lines and text before the link', () => {
    const rows = screen([`Sign in: ${signIn.slice(0, 21)}`, `    ${signIn.slice(21, 47)}`, `    ${signIn.slice(47)}`]);
    expect(findKnownLinks(rows, 1, [signIn])).toEqual([{ uri: signIn, start: { x: 9, y: 0 }, end: { x: 4 + signIn.length - 48, y: 2 } }]);
  });

  it('knows nothing it was not told, and finds nothing when the text differs', () => {
    const rows = screen([signIn.slice(0, 30), signIn.slice(30, 60), signIn.slice(60)]);
    expect(findKnownLinks(rows, 0, [])).toEqual([]);
    expect(findKnownLinks(rows, 0, [`${signIn}X`])).toEqual([]);
  });

  it('keeps columns right after a wide character', () => {
    // '✻' takes one cell here, a CJK character takes two: the second is ''.
    const rows = [['界', '', ' ', ...'https://a.io'.split(''), ' ', ' ']];
    expect(findKnownLinks(rows, 0, ['https://a.io'])).toEqual([{ uri: 'https://a.io', start: { x: 3, y: 0 }, end: { x: 14, y: 0 } }]);
  });
});
