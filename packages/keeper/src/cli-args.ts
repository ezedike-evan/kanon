/**
 * Strict parsing for the numbers a CLI takes from argv or the environment.
 * `Number("abc")` is NaN and `Number("")` is 0, and either used to flow on into
 * a timer or a cap; every number here is checked to be an integer in range and
 * a bad one is a readable startup error. Values are never echoed back.
 */

/** Per-request timeout and retries for every RPC call, so one hung endpoint cannot stall a pass. */
export const RPC_TIMEOUT_MS = 15_000;
export const RPC_RETRIES = 2;

export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

export interface IntRange {
  min: number;
  max: number;
}

/** An integer in `[min, max]`; anything else (NaN, empty, float, exponent, out of range) throws naming `label`. */
export function parseBoundedInt(label: string, raw: string | undefined, range: IntRange): number {
  const text = raw?.trim() ?? '';
  if (!/^\d+$/.test(text)) throw new CliArgError(`${label} must be an integer from ${range.min} to ${range.max}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < range.min || n > range.max) {
    throw new CliArgError(`${label} must be an integer from ${range.min} to ${range.max}`);
  }
  return n;
}

export const INTERVAL_RANGE: IntRange = { min: 1, max: 86_400 };

/** `--interval N` seconds, or `fallback` when the flag is absent. A flag with no value is an error, not the default. */
export function parseIntervalArg(argv: readonly string[], fallback: number): number {
  const at = argv.indexOf('--interval');
  if (at === -1) return fallback;
  return parseBoundedInt('--interval', argv[at + 1], INTERVAL_RANGE);
}

/** `HEALTH_PORT`: unset or blank disables the endpoint. */
export function parseHealthPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return parseBoundedInt('HEALTH_PORT', raw, { min: 1, max: 65_535 });
}

/** An optional env integer with a default, range-checked. */
export function parseEnvInt(name: string, raw: string | undefined, fallback: number, range: IntRange): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  return parseBoundedInt(name, raw, range);
}
