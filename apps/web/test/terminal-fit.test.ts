import { describe, expect, it } from 'vitest';
import { OWN_LINE_HEIGHT, WATCH_FONT, WATCH_LINE_HEIGHT, largestFittingSize } from '../src/lib/terminal-fit';

/** A pane that holds a grid up to `limit` px wide, for a grid whose width is `perPx` per px of font. */
const fitsUpTo = (limit: number, perPx: number) => (size: number) => size * perPx <= limit;

describe('largestFittingSize', () => {
  it('finds the largest size that still fits, on a step', () => {
    // 96 columns of 0.6 em in a 477 px pane: 477 / (96 * 0.6) = 8.28 px, so 8.25 on a 0.25 grid.
    expect(largestFittingSize(WATCH_FONT, fitsUpTo(477, 96 * 0.6))).toBe(8.25);
    // A pane for 61 columns holds 16 px easily; 400 px holds 61 * 0.6 * 10.9 → 10.75.
    expect(largestFittingSize(WATCH_FONT, fitsUpTo(400, 61 * 0.6))).toBe(10.75);
  });

  it('stops at the maximum when everything fits, so a small grid is not blown up', () => {
    expect(largestFittingSize(WATCH_FONT, () => true)).toBe(WATCH_FONT.max);
    expect(largestFittingSize(WATCH_LINE_HEIGHT, () => true)).toBe(WATCH_LINE_HEIGHT.max);
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
    // The smallest, then a binary search over 64 steps.
    expect(asked.length).toBeLessThanOrEqual(8);
  });

  it('keeps fractional steps exact, so xterm is never given 1.0700000000000001', () => {
    const asked = new Set<number>();
    for (let rows = 1; rows <= 60; rows += 1) {
      largestFittingSize(WATCH_LINE_HEIGHT, (spacing) => {
        asked.add(spacing);
        return spacing <= 1 + rows / 100;
      });
    }
    for (const spacing of asked) expect(spacing).toBe(Math.round(spacing * 100) / 100);
    // Every step is reachable, the top one included: 1 + 60 * 0.01 is 1.6 up to rounding.
    expect(largestFittingSize(WATCH_LINE_HEIGHT, (spacing) => spacing <= 1.6)).toBe(1.6);
    expect(largestFittingSize(WATCH_LINE_HEIGHT, (spacing) => spacing <= 1.37)).toBe(1.37);
  });
});

describe('what a watcher may do with the owner’s grid', () => {
  it('can match the owner’s own look, and then go beyond it either way', () => {
    // The spacing range includes the owner's, so a pane shaped like the owner's gets the owner's look.
    expect(OWN_LINE_HEIGHT).toBeGreaterThanOrEqual(WATCH_LINE_HEIGHT.min);
    expect(OWN_LINE_HEIGHT).toBeLessThanOrEqual(WATCH_LINE_HEIGHT.max);
    // The font range holds the owner's 13 px with room on both sides: a larger pane enlarges, a smaller one shrinks.
    expect(WATCH_FONT.min).toBeLessThan(13);
    expect(WATCH_FONT.max).toBeGreaterThan(13);
  });

  it('spreads the lines to the pane’s height once the font is settled by its width', () => {
    // A 61x31 grid in a pane 740 px wide and 850 px tall, as a watcher: cells are 0.6 em wide, and a
    // line is 1.3 em tall at the tightest spacing, rounded down to whole pixels like xterm does.
    const cols = 61;
    const rows = 31;
    const width = 740;
    const height = 850;
    const cellWidth = (font: number) => font * 0.6;
    const cellHeight = (font: number, spacing: number) => Math.floor(Math.ceil(font * 1.3) * spacing);
    const font = largestFittingSize(WATCH_FONT, (size) => cols * cellWidth(size) <= width && rows * cellHeight(size, WATCH_LINE_HEIGHT.min) <= height);
    expect(font).not.toBeNull();
    const spacing = largestFittingSize(WATCH_LINE_HEIGHT, (value) => rows * cellHeight(font!, value) <= height);
    expect(spacing).toBeGreaterThan(WATCH_LINE_HEIGHT.min);
    // The grid now uses nearly all of the pane's height: less than one more pixel per line would still fit.
    const used = rows * cellHeight(font!, spacing!);
    expect(used).toBeLessThanOrEqual(height);
    expect(height - used).toBeLessThan(rows);
    // And the width is what decided the font: one more step would overflow it.
    expect(cols * cellWidth(font! + WATCH_FONT.step)).toBeGreaterThan(width);
  });
});
