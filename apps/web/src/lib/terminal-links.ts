/** A terminal cell: `x` is the column, `y` the row, both counted from 0. */
export interface CellPosition {
  x: number;
  y: number;
}

export interface FoundLink {
  uri: string;
  start: CellPosition;
  /** The link's last cell (inclusive). */
  end: CellPosition;
}

/**
 * Finds known link addresses on a terminal screen and returns those that touch
 * `row`.
 *
 * A screen redrawn from a snapshot has lost its hyperlinks, and Claude breaks a long
 * one (its sign-in link) over several lines, which no URL detector can put back
 * together: the first line alone looks like a complete, wrong address. The server
 * sends the addresses that were printed (`hello.links`); this finds them in the text
 * again, ignoring the line breaks and indentation between rows, since a web address
 * holds no whitespace.
 *
 * `rows[y][x]` is the text of one cell: '' for the second half of a wide character,
 * ' ' for a blank.
 */
export function findKnownLinks(rows: string[][], row: number, uris: string[]): FoundLink[] {
  if (uris.length === 0) return [];
  let joined = '';
  const where: CellPosition[] = [];
  rows.forEach((cells, y) => {
    let end = cells.length;
    while (end > 0 && isBlank(cells[end - 1])) end -= 1;
    let start = 0;
    while (start < end && isBlank(cells[start])) start += 1;
    for (let x = start; x < end; x += 1) {
      const text = cells[x] ?? '';
      // One position per UTF-16 unit, so indexes into `joined` map straight back.
      for (let unit = 0; unit < text.length; unit += 1) where.push({ x, y });
      joined += text;
    }
  });

  const found: FoundLink[] = [];
  for (const uri of new Set(uris)) {
    if (!uri) continue;
    for (let index = joined.indexOf(uri); index !== -1; index = joined.indexOf(uri, index + 1)) {
      const start = where[index]!;
      const end = where[index + uri.length - 1]!;
      if (start.y <= row && row <= end.y) found.push({ uri, start, end });
    }
  }
  return found;
}

function isBlank(cell: string | undefined): boolean {
  return cell === undefined || cell === '' || cell === ' ';
}
