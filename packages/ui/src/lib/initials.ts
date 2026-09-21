/**
 * Two-character monogram for a name, handle or address.
 *
 *   'Ada Lovelace' -> 'AL'   'ada'  -> 'AD'   '0x9fE2…' -> '9F'   '' -> '?'
 */
export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  if (/^0x[0-9a-fA-F]{2,}/.test(trimmed)) return trimmed.slice(2, 4).toUpperCase();
  const words = trimmed.replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  const first = words[0] ?? '';
  const second = words[1] ?? '';
  if (second) return (first.charAt(0) + second.charAt(0)).toUpperCase();
  return first.slice(0, 2).toUpperCase() || '?';
}
