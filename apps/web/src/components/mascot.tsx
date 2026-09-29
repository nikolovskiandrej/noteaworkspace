/**
 * The ribbon mascot, flabbergasted, in the bottom-right corner of every page. Purely for fun: it is
 * decorative (no alt text, hidden from assistive technology), it never takes a click,
 * and the stylesheet hides it on phones and tablets (`.mascot`).
 */
export function Mascot() {
  return <img src="/brand/notea-mascot.webp" alt="" aria-hidden width={474} height={337} draggable={false} className="mascot" />;
}
