/**
 * A member's terminal is one pty with one grid of columns and rows, and its owner's pane
 * decides that grid (D-045). A watcher's pane is a different size, so the same grid has
 * to be drawn smaller or larger there: at a fixed font it either overflowed (the right
 * edge and the prompt at the bottom cut off) or left most of the pane empty.
 */

/** The owner's font. Their grid is whatever fits their pane at this size. */
export const OWN_FONT_SIZE = 13;

/**
 * What a watcher may draw the owner's grid at, in px. Below `min` text stops being
 * readable, so a grid that still does not fit scrolls instead; above `max` a small grid
 * would only look enlarged.
 */
export const WATCH_FONT = { min: 8, max: 16, step: 0.5 } as const;

/**
 * The largest size in `range` (in whole steps) at which `fits` holds, or null when it
 * does not hold even at `range.min`. `fits` must be monotonic: a size that does not fit
 * is never followed by a larger one that does. It is called O(log n) times and may set
 * the size it is asked about, so the caller applies the result afterwards.
 */
export function largestFittingSize(range: { min: number; max: number; step: number }, fits: (size: number) => boolean): number | null {
  if (!fits(range.min)) return null;
  let low = 0;
  let high = Math.floor((range.max - range.min) / range.step);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(range.min + mid * range.step)) low = mid;
    else high = mid - 1;
  }
  return range.min + low * range.step;
}
