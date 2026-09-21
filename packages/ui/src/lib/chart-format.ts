/**
 * Number and time formatting for the chart, shared by the host chrome and the
 * runtime (which is bundled for the WebView, so this file imports nothing).
 *
 * The chart draws in floats, so every figure that reaches the screen is
 * rendered here at a fixed number of decimals: a price that drops a trailing
 * zero stops lining up with the one above it.
 */

/**
 * How many decimals to show a price at, from its magnitude, the way a trading
 * terminal does: a $85,965 coin is quoted to the cent, a $0.034 coin to five
 * places. `sourceDecimals` is the precision the feed carries (Pyth's raw
 * exponent is often 8) and only ever caps the answer, never raises it.
 *
 * Display only. The atoms behind a price stay exact; nothing rounded here is
 * fed back into spec or contract arithmetic.
 */
export function displayDecimals(reference: number, sourceDecimals: number): number {
  const magnitude = Math.abs(reference);
  const wanted = magnitude >= 10 ? 2 : magnitude >= 1 ? 4 : magnitude >= 0.01 ? 5 : 6;
  return Math.max(0, Math.min(wanted, Math.floor(sourceDecimals)));
}

/**
 * A fixed-point value (`atoms` at `decimals`) rendered at `dp` decimals,
 * rounded half away from zero on the integers, so no float ever touches it.
 * `85965877742820000` at 12 decimals, 2 dp -> `85,965.88`.
 */
export function formatAtoms(
  atoms: string,
  decimals: number,
  dp: number,
  opts: { signed?: boolean } = {},
): string {
  if (!/^-?\d+$/.test(atoms)) return '—';
  const negative = atoms.startsWith('-');
  let magnitude = BigInt(negative ? atoms.slice(1) : atoms);
  if (dp < decimals) {
    const divisor = 10n ** BigInt(decimals - dp);
    magnitude = (magnitude + divisor / 2n) / divisor;
  } else if (dp > decimals) {
    magnitude *= 10n ** BigInt(dp - decimals);
  }
  const digits = magnitude.toString().padStart(dp + 1, '0');
  const whole = digits.slice(0, digits.length - dp).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = dp === 0 ? whole : `${whole}.${digits.slice(digits.length - dp)}`;
  const isZero = magnitude === 0n;
  if (negative && !isZero) return `\u2212${body}`;
  return opts.signed && !isZero ? `+${body}` : body;
}

/** `68207.3, 2` -> `68,207.30`. Fixed decimals, grouped thousands, true minus. */
export function formatPrice(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—';
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(Math.max(0, decimals));
  const [whole = '0', frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac === undefined ? grouped : `${grouped}.${frac}`;
  return negative ? `−${body}` : body;
}

/** Same as `formatPrice` with an explicit sign. */
export function formatSigned(value: number, decimals: number): string {
  const body = formatPrice(Math.abs(value), decimals);
  if (value < 0) return `−${body}`;
  return value > 0 ? `+${body}` : body;
}

/** A percentage from a ratio in percent (`1.9234` -> `1.92%`). */
export function formatPercent(percent: number, opts: { signed?: boolean } = {}): string {
  if (!Number.isFinite(percent)) return '—';
  const body = `${Math.abs(percent).toFixed(2)}%`;
  if (percent < 0) return `−${body}`;
  return opts.signed && percent > 0 ? `+${body}` : body;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Time to a bar's close: `04:12`, `1:02:09`, `2d 04:00:00`. Never negative. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const seconds = s % 60;
  if (days > 0) return `${days}d ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

/** A span in words a trader reads at a glance: `45m`, `6h 45m`, `3d 4h`. */
export function formatSpan(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

/** `HH:MM` in UTC, the way the canonical series buckets. */
export function formatClock(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `20 Sep 20:00` in UTC. */
export function formatStamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${formatClock(unixSeconds)}`;
}

/** `#RRGGBB` (or `#RGB`) to an `rgba()` string. Anything else is returned untouched. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
