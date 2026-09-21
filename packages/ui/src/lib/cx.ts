import { extendTailwindMerge } from 'tailwind-merge';
import { fontSize, tracking } from '@kanon/tokens';

/**
 * Joins class names, dropping anything falsy, and lets a later class beat an
 * earlier one.
 *
 * That last part is not decoration. NativeWind resolves conflicts by CSS
 * specificity, not by position in the string, so `cx('text-bone', 'text-ash')`
 * would otherwise resolve by whichever Tailwind happened to emit last — a
 * component's default silently winning over its caller's override. Every
 * component here takes a `className`, so that has to be predictable.
 */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      // The mono face carries its weight in the family utility; see @kanon/tokens.
      'font-family': [{ font: ['mono', 'mono-medium', 'mono-bold', 'sans'] }],
      // The px-keyed type scale (`text-11`, `text-20`). Unregistered, tailwind-merge
      // reads `text-11` as a text *colour*, so `cx('text-11', 'text-ash')` would
      // silently drop the size. Registered, size and colour coexist.
      'font-size': [{ text: Object.keys(fontSize) }],
      tracking: [{ tracking: Object.keys(tracking) }],
    },
  },
});

export function cx(...parts: Array<string | false | null | undefined>): string {
  return merge(parts.filter(Boolean).join(' '));
}
