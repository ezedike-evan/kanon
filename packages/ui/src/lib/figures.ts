/**
 * A sentence, split so the figures in it can be set monospaced and tabular
 * while the words around them stay in the reading face. Every number in the
 * app is monospaced, and a sentence that states one is no exception.
 *
 * Pure, so the split is pinned down in `figures.test.ts`.
 */

export interface TextPart {
  text: string;
  /** A figure: set monospaced and tabular. */
  mono: boolean;
}

/**
 * A figure as a sentence writes it: `$10`, `15m`, `1h`, `5x`, `1.00%`, `2`,
 * `1,250`. A currency sign before it and a unit letter or percent sign straight
 * after it belong to the figure; a comma or a full stop that ends a clause does
 * not.
 */
const FIGURE = /\$?\d+(?:,\d{3})*(?:\.\d+)?(?:%|x\b|[smhd]\b)?/g;

export function splitFigures(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let from = 0;
  for (const match of text.matchAll(FIGURE)) {
    const at = match.index ?? 0;
    if (at > from) parts.push({ text: text.slice(from, at), mono: false });
    parts.push({ text: match[0], mono: true });
    from = at + match[0].length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), mono: false });
  return parts;
}
