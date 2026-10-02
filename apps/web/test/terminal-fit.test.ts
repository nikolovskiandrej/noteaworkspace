import { describe, expect, it } from 'vitest';
import { WATCH_FONT, largestFittingSize } from '../src/lib/terminal-fit';

/** A pane that holds a grid up to `limit` px wide, for a grid whose width is `perPx` per px of font. */
const fitsUpTo = (limit: number, perPx: number) => (size: number) => size * perPx <= limit;

describe('largestFittingSize', () => {
  it('finds the largest size that still fits, on a step', () => {
    // 96 columns of 0.6 em in a 477 px pane: 477 / (96 * 0.6) = 8.28 px, so 8 on a 0.5 grid.
    expect(largestFittingSize(WATCH_FONT, fitsUpTo(477, 96 * 0.6))).toBe(8);
    // A pane for 61 columns holds 16 px easily; 400 px holds 61 * 0.6 * 10.9 → 10.5.
    expect(largestFittingSize(WATCH_FONT, fitsUpTo(400, 61 * 0.6))).toBe(10.5);
  });

  it('stops at the maximum when everything fits, so a small grid is not blown up', () => {
    expect(largestFittingSize(WATCH_FONT, () => true)).toBe(WATCH_FONT.max);
  });

  it('is null when not even the smallest readable size fits', () => {
    expect(largestFittingSize(WATCH_FONT, () => false)).toBeNull();
    expect(largestFittingSize(WATCH_FONT, fitsUpTo(100, 96 * 0.6))).toBeNull();
  });

  it('answers the same as trying every size, for any pane', () => {
    for (let limit = 200; limit < 1400; limit += 7) {
      const fits = fitsUpTo(limit, 96 * 0.6);
      let expected: number | null = null;
      for (let size: number = WATCH_FONT.min; size <= WATCH_FONT.max; size += WATCH_FONT.step) if (fits(size)) expected = size;
      expect(largestFittingSize(WATCH_FONT, fits)).toBe(expected);
    }
  });

  it('asks about few sizes, and the smallest first', () => {
    const asked: number[] = [];
    largestFittingSize(WATCH_FONT, (size) => {
      asked.push(size);
      return size <= 11;
    });
    expect(asked[0]).toBe(WATCH_FONT.min);
    expect(asked.length).toBeLessThanOrEqual(7);
  });
});
