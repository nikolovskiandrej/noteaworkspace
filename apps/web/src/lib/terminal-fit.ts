/**
 * A member's terminal is one pty with one grid of columns and rows, and its owner's pane
 * decides that grid (D-045). A watcher's pane is a different size, so the same grid has
 * to be drawn smaller or larger there. A fixed font either overflowed (the right edge and
 * the prompt at the bottom cut off) or left most of the pane empty; a font alone still
 * leaves a strip empty wherever the two panes' proportions differ, so the watcher also
 * spreads the lines until the grid is as tall as its pane.
 */

/** The owner's font and line spacing. Their grid is whatever fits their pane at these. */
export const OWN_FONT_SIZE = 13;
export const OWN_LINE_HEIGHT = 1.2;

/**
 * What a watcher may draw the owner's grid at, in px. Below `min` text stops being
 * readable, so a grid that still does not fit scrolls instead; above `max` a small grid
 * would only look enlarged.
 */
export const WATCH_FONT = { min: 8, max: 24, step: 0.25 } as const;

/**
 * How far a watcher may spread the lines (xterm's multiple of the font's own line height,
 * which is also what the owner's 1.2 is) to use the height its font leaves over. The font
 * is chosen at `min`, the tightest, so that the width decides it; past `max` the lines
 * would read as double spaced, and the rest of the height stays empty.
 */
export const WATCH_LINE_HEIGHT = { min: 1, max: 1.6, step: 0.01 } as const;

/**
 * The largest size in `range` (in whole steps) at which `fits` holds, or null when it
 * does not hold even at `range.min`. `fits` must be monotonic: a size that does not fit
 * is never followed by a larger one that does. It is called O(log n) times and may set
 * the size it is asked about, so the caller applies the result afterwards.
 */
export function largestFittingSize(range: { min: number; max: number; step: number }, fits: (size: number) => boolean): number | null {
  // Whole steps, rounded, so that 1 + 7 * 0.01 is 1.07 and not 1.0700000000000001.
  const at = (steps: number) => Math.round((range.min + steps * range.step) * 1e6) / 1e6;
  if (!fits(range.min)) return null;
  let low = 0;
  let high = Math.floor((range.max - range.min) / range.step + 1e-9);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(at(mid))) low = mid;
    else high = mid - 1;
  }
  return at(low);
}
